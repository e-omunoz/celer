//! JDBC through Celer's bridge, and Informix over it (SQLI, the native protocol, with IBM's pure-Java driver): no
//! Client SDK, no DRDA listener.
//!
//! The bridge and its protocol know nothing of any engine: the driver class, its jars, the URL and the properties
//! come with each connection, so any JDBC driver can be added (see docs/DRIVERS.md). What is Informix's (URL,
//! properties such as FET_BUF_SIZE, the dialect above) lives here and in odbc_driver.rs.
//!
//! Celer's bridge (`bridge/CelerBridge.java`, embedded by build.rs) runs in one JVM shared by the whole app: a child
//! process that talks to Celer only through its stdin and stdout, never a network port. It starts once (the first
//! JDBC connection, or `prewarm` as soon as one is being opened), and every session after that only pays for its own
//! connection. Each session runs on its own thread in the bridge, and the reader thread never waits on a driver: a
//! cancel runs `Statement.cancel()` on a helper thread. Informix sends that cancel as TCP urgent data, which proxies
//! and firewalls may drop: if the statement is still running 5 s later the bridge cuts the connection
//! (`Connection.abort`), answers with RESET_STATE, and the driver above opens a new one (`Link::reset_pending`).
//!
//! Protocol, version 1. Every frame is a little-endian u32 length and that many bytes.
//! - Request: u32 request id (0: no reply wanted), u32 session, u8 operation, body.
//! - Reply: u32 request id, u8 status (0 ok, 1 error), body. An error body is the message, the SQLSTATE and the
//!   vendor code. The bridge's first frame, unasked, is its hello: name, protocol version, Java version and vendor.
//! - Values: unsigned LEB128 varints, zigzag varints for signed numbers, strings as a varint length plus UTF-8,
//!   doubles as 8 little-endian bytes.
//! - Rows travel in batches: u32 row count, u8 "more rows remain", and for each row a null bitmap (bit i % 8 of byte
//!   i / 8 for column i) followed by the values that are not null, as the column's wire type says: bool (u8), int
//!   (zigzag), double, text (string) or bytes (varint length + bytes).
//! The password goes in the CONNECT request's properties, through the pipe: never on a command line, in the
//! environment or in a log.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::model::*;
use crate::odbc::{fit_fraction, BINARY_PREVIEW};
use crate::odbc_driver::{Link, LinkDriver, LinkStmt};
use crate::session::Canceller;

const PROTOCOL: u64 = 1;

const OP_LOAD: u8 = 1;
const OP_CONNECT: u8 = 2;
const OP_EXEC: u8 = 3;
const OP_FETCH: u8 = 4;
const OP_CLOSE_CURSOR: u8 = 5;
const OP_AUTOCOMMIT: u8 = 6;
const OP_COMMIT: u8 = 7;
const OP_ROLLBACK: u8 = 8;
const OP_CANCEL: u8 = 9;
const OP_CLOSE: u8 = 10;

const W_BOOL: u8 = 1;
const W_INT: u8 = 2;
const W_DOUBLE: u8 = 3;
const W_TEXT: u8 = 4;
const W_BYTES: u8 = 5;

/// Informix's fetch buffer, in bytes, when the user does not set one. The driver's default is the row size (4–8 KB,
/// a round trip every few dozen rows); it accepts up to 2 GB when the server allows it (32 KB otherwise, and it cuts
/// the value to that). Measured with the engine tests' 200,000-row read (`informix_speed`, Informix 15): 256 KB was
/// the fastest (918 ms against 985 ms with 1 MB, 1,325 ms with the driver's default and 1,603 ms with 4 MB). Pages
/// set the fetch size to the rows asked for; this buffer governs the reads without it (metadata).
pub const FET_BUF_SIZE: u32 = 256 << 10;

const MAX_FRAME: usize = 512 << 20;

/// SQLSTATE of the bridge's "the connection was cut after a cancel": it has to be opened again.
const RESET_STATE: &str = "CELER-RESET";

/// The bridge jar built by build.rs: empty when Celer was compiled without a JDK.
static BRIDGE_JAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/celer-bridge.jar"));

pub fn bridge_included() -> bool {
    !BRIDGE_JAR.is_empty()
}

/// What a JDBC connection runs on: Java, and the driver's class and jars (drivers.rs finds them).
#[derive(Debug, Clone)]
pub struct Runtime {
    pub java: PathBuf,
    pub java_major: u32,
    pub driver_class: String,
    /// The driver jar first, then what it needs.
    pub jars: Vec<PathBuf>,
    /// Celer's data folder: the bridge jar is written under drivers/jdbc.
    pub dir: PathBuf,
}

// ───────────────────────────────────────────────────────────────── wire format

#[derive(Default)]
pub(crate) struct Out(pub Vec<u8>);

impl Out {
    pub fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    pub fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.0.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.0.push(v as u8);
    }
    pub fn zigzag(&mut self, v: i64) {
        self.varint(((v << 1) ^ (v >> 63)) as u64);
    }
    pub fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub fn bytes(&mut self, b: &[u8]) {
        self.varint(b.len() as u64);
        self.0.extend_from_slice(b);
    }
    pub fn str(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
}

pub(crate) struct In<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> In<'a> {
    pub fn new(d: &'a [u8]) -> In<'a> {
        In { d, p: 0 }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.p.checked_add(n).filter(|e| *e <= self.d.len()).ok_or_else(|| anyhow!("Respuesta del puente JDBC incompleta"))?;
        let s = &self.d[self.p..end];
        self.p = end;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    pub fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        let mut shift = 0;
        loop {
            let b = self.u8()?;
            if shift > 63 {
                bail!("Respuesta del puente JDBC no válida");
            }
            v |= ((b & 0x7F) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
            shift += 7;
        }
    }
    pub fn zigzag(&mut self) -> Result<i64> {
        let v = self.varint()?;
        Ok((v >> 1) as i64 ^ -((v & 1) as i64))
    }
    pub fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into()?))
    }
    pub fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.varint()? as usize;
        self.take(n)
    }
    pub fn str(&mut self) -> Result<String> {
        let b = self.bytes()?;
        Ok(match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => String::from_utf8_lossy(b).into_owned(),
        })
    }
}

/// How a column's values are read: wire type, and for timestamps the fraction digits the column has.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Wire {
    wire: u8,
    frac: Option<u8>,
}

/// Column descriptions as the bridge sends them (label, type name, java.sql.Types, precision, scale, wire type).
fn read_columns(r: &mut In) -> Result<(Vec<ColumnInfo>, Vec<Wire>)> {
    let n = r.varint()? as usize;
    let mut cols = Vec::with_capacity(n);
    let mut plan = Vec::with_capacity(n);
    for _ in 0..n {
        let name = r.str()?;
        let type_name = r.str()?.to_lowercase();
        let jdbc_type = r.zigzag()? as i32;
        let _precision = r.varint()?;
        let scale = r.zigzag()?;
        let wire = r.u8()?;
        let frac = matches!(jdbc_type, 92 | 93 | 2013 | 2014).then(|| fraction_digits(&type_name, scale));
        cols.push(ColumnInfo { kind: jdbc_kind(jdbc_type, &type_name), type_name, name });
        plan.push(Wire { wire, frac });
    }
    Ok((cols, plan))
}

/// Fraction digits of a time column: DATETIME's qualifier says them ("… to fraction(3)"; "to second": none).
fn fraction_digits(type_name: &str, scale: i64) -> u8 {
    if let Some(at) = type_name.find("fraction") {
        let rest = &type_name[at + "fraction".len()..];
        return rest.trim_start().strip_prefix('(').and_then(|r| r.split(')').next()).and_then(|d| d.trim().parse().ok()).unwrap_or(3);
    }
    if type_name.starts_with("datetime") {
        return 0;
    }
    scale.clamp(0, 9) as u8
}

/// The grid's family for a java.sql.Types code.
fn jdbc_kind(t: i32, type_name: &str) -> ColKind {
    match t {
        -7 | 16 => ColKind::Bool,
        -6 | 5 | 4 | -5 | 6 | 7 | 8 | 2 | 3 => ColKind::Number,
        1 | 12 | -1 | -15 | -9 | -16 | 2005 | 2011 => ColKind::Text,
        // INTERVAL arrives as text but is not a date.
        91 | 92 | 93 | 2013 | 2014 if !type_name.starts_with("interval") => ColKind::Date,
        -2 | -3 | -4 | 2004 => ColKind::Binary,
        _ => ColKind::Other,
    }
}

/// A batch of rows: count, "more remain", then each row's null bitmap and values.
fn read_batch(r: &mut In, plan: &[Wire], out: &mut VecDeque<Vec<Cell>>) -> Result<bool> {
    let count = r.u32()? as usize;
    let more = r.u8()? != 0;
    let nb = plan.len().div_ceil(8);
    for _ in 0..count {
        let nulls = r.take(nb)?;
        let mut row = Vec::with_capacity(plan.len());
        for (i, w) in plan.iter().enumerate() {
            if nulls[i >> 3] & (1 << (i & 7)) != 0 {
                row.push(Cell::Null);
                continue;
            }
            row.push(match w.wire {
                W_BOOL => Cell::Bool(r.u8()? != 0),
                W_INT => Cell::int(r.zigzag()?),
                W_DOUBLE => Cell::num(r.f64()?),
                W_BYTES => Cell::hex(r.bytes()?, BINARY_PREVIEW),
                W_TEXT => {
                    let s = r.str()?;
                    Cell::Text(match w.frac {
                        Some(digits) => fit_fraction(s, digits),
                        None => s,
                    })
                }
                other => bail!("Tipo de valor desconocido en el puente JDBC: {other}"),
            });
        }
        out.push_back(row);
    }
    Ok(more)
}

/// An error from the driver or the bridge.
#[derive(Debug)]
pub struct JdbcError {
    pub message: String,
    pub state: String,
    pub code: i32,
}

impl std::fmt::Display for JdbcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if !self.state.is_empty() && self.state != RESET_STATE {
            write!(f, "[{}] ", self.state)?;
        }
        write!(f, "{}", self.message)?;
        if self.code != 0 {
            write!(f, " ({})", self.code)?;
        }
        Ok(())
    }
}

impl std::error::Error for JdbcError {}

fn read_error(body: &[u8]) -> anyhow::Error {
    let mut r = In::new(body);
    match (r.str(), r.str(), r.zigzag()) {
        (Ok(message), Ok(state), Ok(code)) => anyhow::Error::new(JdbcError { message, state, code: code as i32 }),
        _ => anyhow!("Error del puente JDBC sin descripción"),
    }
}

/// A connection error with what to do about it (same `INFORMIX_GUIDE:<topic>:` codes as the ODBC path).
pub fn explain(e: anyhow::Error) -> anyhow::Error {
    let Some((code, lower)) = e.downcast_ref::<JdbcError>().map(|j| (j.code, j.message.to_lowercase())) else { return e };
    let (topic, what) = match code {
        -23101 | -23104 | -23197 | -79783 => (
            "locale",
            "El locale de la conexión no es el de la base de datos: indícalo en Parámetros extra, por ejemplo DB_LOCALE=es_ES.819 (y CLIENT_LOCALE si hace falta).",
        ),
        -25596 | -761 | -908 | -930 => (
            "server",
            "No se pudo entrar en el servidor: revisa servidor, puerto (SQLI suele ser 9088) e INFORMIXSERVER, que debe ser su DBSERVERNAME o uno de sus alias (en DBeaver aparece en la URL como informixserver=…).",
        ),
        -951 | -952 => ("", "Usuario o contraseña incorrectos."),
        -329 => ("", "La base de datos no existe o el usuario no tiene permiso para abrirla."),
        _ if lower.contains("connectexception") || lower.contains("unknownhostexception") || lower.contains("connection refused") => (
            "server",
            "No hay respuesta SQLI en ese servidor y puerto: comprueba la dirección y el puerto (normalmente 9088).",
        ),
        _ if lower.contains("classnotfound") || lower.contains("noclassdeffound") => (
            "jdbc",
            "El driver JDBC de Informix está incompleto o dañado: vuelve a descargarlo en Ajustes › Drivers.",
        ),
        _ => return e,
    };
    if topic.is_empty() {
        anyhow!("{what}\n\n{e}")
    } else {
        anyhow!("INFORMIX_GUIDE:{topic}: {what}\n\n{e}")
    }
}

// ───────────────────────────────────────────────────────────────── the bridge process

struct Reply {
    status: u8,
    body: Vec<u8>,
}

struct Bridge {
    stdin: Mutex<BufWriter<ChildStdin>>,
    pending: Mutex<HashMap<u32, mpsc::Sender<Reply>>>,
    next_req: AtomicU32,
    alive: AtomicBool,
    /// The last lines Java wrote to stderr, to explain why it stopped.
    stderr: Arc<Mutex<VecDeque<String>>>,
    child: Mutex<Child>,
}

static BRIDGE: LazyLock<Mutex<Option<Arc<Bridge>>>> = LazyLock::new(|| Mutex::new(None));
static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

/// What Java wrote on stdout instead of the bridge's hello, as a line for the error.
fn stray_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    format!("Java escribió en la salida del puente: {}", text.trim())
}

/// The bridge jar in Celer's data folder (named after its hash: a new Celer writes its own).
fn bridge_jar(dir: &Path) -> Result<PathBuf> {
    if BRIDGE_JAR.is_empty() {
        bail!("JDBC_BRIDGE_MISSING: Esta compilación de Celer no incluye el puente JDBC (se compiló sin un JDK). Usa una versión publicada de Celer.");
    }
    let hash: String = Sha256::digest(BRIDGE_JAR).iter().take(6).map(|b| format!("{b:02x}")).collect();
    let folder = dir.join("drivers").join("jdbc");
    std::fs::create_dir_all(&folder)?;
    let path = folder.join(format!("celer-bridge-{hash}.jar"));
    if std::fs::metadata(&path).map(|m| m.len() != BRIDGE_JAR.len() as u64).unwrap_or(true) {
        let partial = folder.join(format!("celer-bridge-{hash}.jar.partial"));
        std::fs::write(&partial, BRIDGE_JAR)?;
        std::fs::rename(&partial, &path)?;
    }
    Ok(path)
}

impl Bridge {
    /// The running bridge, or a new one.
    fn get(rt: &Runtime) -> Result<Arc<Bridge>> {
        let mut slot = BRIDGE.lock();
        if let Some(b) = slot.as_ref().filter(|b| b.alive()) {
            return Ok(b.clone());
        }
        let b = Bridge::spawn(rt)?;
        *slot = Some(b.clone());
        Ok(b)
    }

    fn spawn(rt: &Runtime) -> Result<Arc<Bridge>> {
        let jar = bridge_jar(&rt.dir)?;
        let folder = jar.parent().unwrap_or(Path::new(".")).to_path_buf();
        let jar_name = jar.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut cmd = Command::new(&rt.java);
        // Java itself, no shell in between, with fixed arguments. The paths are relative to the bridge's folder in
        // Celer's data (a user name the console code page cannot write never reaches Java's command line), and Java
        // writes nothing elsewhere: no hsperfdata, and its temporary files (a driver's LOB cache) go there too.
        let _ = std::fs::create_dir_all(folder.join("tmp"));
        // stdout is the protocol: the JVM's own warnings (unified logging and the rest of its output go to stdout by
        // default) are sent to stderr. A JRE without its base CDS archive (DBeaver's) warns about it at start.
        cmd.args(["-Xlog:disable", "-Xlog:all=warning:stderr", "-XX:+DisplayVMOutputToStderr"]);
        cmd.args(["-XX:+UseSerialGC", "-XX:-UsePerfData", "-Xss2m", "-Djava.awt.headless=true", "-Djava.io.tmpdir=tmp"]);
        if rt.java_major >= 19 {
            // Class data of the bridge and the driver, kept from one start to the next (JDK 19+): a faster start.
            cmd.arg("-XX:+AutoCreateSharedArchive").arg(format!("-XX:SharedArchiveFile=celer-bridge-java{}.jsa", rt.java_major));
        }
        cmd.args(["-cp", jar_name.as_str(), "CelerBridge"]);
        cmd.current_dir(&folder).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| anyhow!("No se pudo arrancar Java ({}): {e}", rt.java.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("Java sin entrada estándar"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Java sin salida estándar"))?;
        let stderr_pipe = child.stderr.take();
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(pipe) = stderr_pipe {
            let tail = stderr.clone();
            let _ = std::thread::Builder::new().name("celer-jdbc-stderr".into()).spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(|l| l.ok()) {
                    let mut t = tail.lock();
                    if t.len() >= 40 {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            });
        }
        let bridge = Arc::new(Bridge {
            stdin: Mutex::new(BufWriter::with_capacity(64 * 1024, stdin)),
            pending: Mutex::new(HashMap::new()),
            next_req: AtomicU32::new(1),
            alive: AtomicBool::new(true),
            stderr,
            child: Mutex::new(child),
        });
        let (hello_tx, hello_rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let reader = bridge.clone();
        std::thread::Builder::new().name("celer-jdbc-reader".into()).spawn(move || reader.read_loop(stdout, hello_tx))?;
        let hello = match hello_rx.recv_timeout(Duration::from_secs(60)) {
            Ok(h) => h,
            Err(_) => {
                bridge.kill();
                // stderr may still be arriving.
                std::thread::sleep(Duration::from_millis(200));
                bail!("Java no arrancó el puente JDBC ({}).{}", rt.java.display(), bridge.stderr_tail());
            }
        };
        let mut r = In::new(&hello);
        let (name, protocol) = (r.str()?, r.varint()?);
        if name != "celer-bridge" || protocol != PROTOCOL {
            bridge.kill();
            bail!("El puente JDBC no responde como se esperaba ({name} {protocol})");
        }
        Ok(bridge)
    }

    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.child.lock().kill();
    }

    fn read_loop(self: Arc<Bridge>, stdout: impl Read, hello: mpsc::SyncSender<Vec<u8>>) {
        let mut r = std::io::BufReader::with_capacity(256 * 1024, stdout);
        let mut first = true;
        loop {
            let mut len = [0u8; 4];
            if r.read_exact(&mut len).is_err() {
                break;
            }
            let n = u32::from_le_bytes(len) as usize;
            if !(5..=MAX_FRAME).contains(&n) {
                if first {
                    // Not the bridge's hello: text Java wrote before it, which the error then shows.
                    let mut text = len.to_vec();
                    let _ = r.by_ref().take(2048).read_until(b'\n', &mut text);
                    self.stderr.lock().push_back(stray_output(&text));
                }
                break;
            }
            let mut frame = vec![0u8; n];
            if r.read_exact(&mut frame).is_err() {
                break;
            }
            let req = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
            let status = frame[4];
            frame.drain(..5);
            if first {
                first = false;
                let _ = hello.send(frame);
                continue;
            }
            if let Some(tx) = self.pending.lock().remove(&req) {
                let _ = tx.send(Reply { status, body: frame });
            }
        }
        // Java is gone: every request waiting gets its error (their senders are dropped here).
        self.alive.store(false, Ordering::SeqCst);
        self.pending.lock().clear();
        let _ = self.child.lock().try_wait();
    }

    fn stderr_tail(&self) -> String {
        let t = self.stderr.lock();
        if t.is_empty() {
            return String::new();
        }
        let lines: Vec<&str> = t.iter().rev().take(8).map(|s| s.as_str()).collect::<Vec<_>>().into_iter().rev().collect();
        format!("\n{}", lines.join("\n"))
    }

    fn gone(&self) -> anyhow::Error {
        anyhow!("El proceso de Java del puente JDBC terminó inesperadamente; vuelve a conectar.{}", self.stderr_tail())
    }

    fn write(&self, req: u32, session: u32, op: u8, body: &[u8]) -> std::io::Result<()> {
        let mut w = self.stdin.lock();
        w.write_all(&((9 + body.len()) as u32).to_le_bytes())?;
        w.write_all(&req.to_le_bytes())?;
        w.write_all(&session.to_le_bytes())?;
        w.write_all(&[op])?;
        w.write_all(body)?;
        w.flush()
    }

    /// Sends a request and waits for its reply (`timeout`: only for connecting).
    fn call(&self, session: u32, op: u8, body: &[u8], timeout: Option<Duration>) -> Result<Vec<u8>> {
        if !self.alive() {
            return Err(self.gone());
        }
        let mut req = self.next_req.fetch_add(1, Ordering::SeqCst);
        if req == 0 {
            req = self.next_req.fetch_add(1, Ordering::SeqCst);
        }
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(req, tx);
        if self.write(req, session, op, body).is_err() {
            self.pending.lock().remove(&req);
            return Err(self.gone());
        }
        let reply = match timeout {
            Some(t) => match rx.recv_timeout(t) {
                Ok(r) => r,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.pending.lock().remove(&req);
                    bail!("El servidor no respondió en {} s", t.as_secs());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.gone()),
            },
            None => rx.recv().map_err(|_| self.gone())?,
        };
        if reply.status == 0 {
            Ok(reply.body)
        } else {
            Err(read_error(&reply.body))
        }
    }

    /// A request without reply (cancel, closing a cursor or a session).
    fn send(&self, session: u32, op: u8, body: &[u8]) {
        if self.alive() {
            let _ = self.write(0, session, op, body);
        }
    }
}

/// Notes in `reset` that the bridge cut the connection (the next operation reconnects).
fn noting_reset<T>(reset: &AtomicBool, r: Result<T>) -> Result<T> {
    if let Err(e) = &r {
        if e.downcast_ref::<JdbcError>().is_some_and(|j| j.state == RESET_STATE) {
            reset.store(true, Ordering::SeqCst);
        }
    }
    r
}

/// The bridge's process id, to dump its threads when a test hangs.
#[cfg(test)]
pub fn bridge_pid() -> Option<u32> {
    BRIDGE.lock().as_ref().map(|b| b.child.lock().id())
}

fn driver_body(b: &mut Out, rt: &Runtime) {
    b.varint(rt.jars.len() as u64);
    for j in &rt.jars {
        b.str(&j.to_string_lossy());
    }
    b.str(&rt.driver_class);
}

/// Starts the bridge and loads the driver in the background, while the user is still typing the password.
pub fn prewarm(rt: Runtime) {
    let _ = std::thread::Builder::new().name("celer-jdbc-prewarm".into()).spawn(move || {
        if let Ok(b) = Bridge::get(&rt) {
            let mut body = Out::default();
            driver_body(&mut body, &rt);
            let _ = b.call(0, OP_LOAD, &body.0, Some(Duration::from_secs(60)));
        }
    });
}

/// Java and the bridge answer (for Settings › Drivers and the tests): the Java version they run on.
pub fn check(rt: &Runtime) -> Result<String> {
    let b = Bridge::get(rt)?;
    let mut body = Out::default();
    driver_body(&mut body, rt);
    let reply = b.call(0, OP_LOAD, &body.0, Some(Duration::from_secs(60)))?;
    In::new(&reply).str()
}

// ───────────────────────────────────────────────────────────────── Informix

/// URL and properties of an Informix connection.
pub fn informix_params(cfg: &ConnConfig, database: Option<&str>) -> (String, Vec<(String, String)>) {
    (jdbc_url(cfg, database), jdbc_props(cfg))
}

/// `jdbc:informix-sqli://host:port/database:INFORMIXSERVER=name` (the rest of the properties go apart, with the
/// password, never in the URL).
pub fn jdbc_url(cfg: &ConnConfig, database: Option<&str>) -> String {
    let db = database.unwrap_or(&cfg.database).trim();
    let mut url = format!("jdbc:informix-sqli://{}:{}", cfg.host.trim(), cfg.port.unwrap_or(9088));
    if !db.is_empty() {
        url.push('/');
        url.push_str(db);
    }
    let server = cfg.instance.trim();
    if !server.is_empty() {
        url.push_str(":INFORMIXSERVER=");
        url.push_str(server);
    }
    url
}

/// "clave=valor;clave2=valor2" from Parámetros extra.
pub fn parse_extra(extra: &str) -> Vec<(String, String)> {
    extra
        .split(';')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

/// The connection properties: user and password, the fetch buffer, the locales and a connect timeout unless the
/// user gave them, then the user's own parameters (they win). DELIMIDENT is not set: Celer writes names unquoted
/// for Informix, as on the ODBC path.
pub fn jdbc_props(cfg: &ConnConfig) -> Vec<(String, String)> {
    let extra = parse_extra(&cfg.extra);
    let has = |key: &str| extra.iter().any(|(k, _)| k.eq_ignore_ascii_case(key));
    let mut props = vec![("user".to_string(), cfg.user.clone()), ("password".to_string(), cfg.password.clone().unwrap_or_default())];
    if !has("FET_BUF_SIZE") && !has("BIG_FET_BUF_SIZE") {
        props.push(("FET_BUF_SIZE".into(), FET_BUF_SIZE.to_string()));
    }
    // As the Client SDK does, the locales may come from the environment.
    for key in ["DB_LOCALE", "CLIENT_LOCALE"] {
        if !has(key) {
            if let Some(v) = std::env::var(key).ok().filter(|v| !v.trim().is_empty()) {
                props.push((key.into(), v.trim().to_string()));
            }
        }
    }
    if !has("INFORMIXCONTIME") {
        props.push(("INFORMIXCONTIME".into(), "20".into()));
    }
    props.extend(extra);
    props
}

// ───────────────────────────────────────────────────────────────── connection

/// The engine's part of a connection: its URL and properties (password included) for a config and a database.
pub type Params = fn(&ConnConfig, Option<&str>) -> (String, Vec<(String, String)>);

/// How long a connect may take before Celer gives up on it (the driver's own timeout should come first).
const CONNECT_WAIT: Duration = Duration::from_secs(90);

/// A connection of the bridge, for any JDBC driver.
pub struct JdbcConn {
    bridge: Arc<Bridge>,
    session: u32,
    /// Where a cancel goes; a reconnect after the JVM went away updates it.
    cancel: Arc<Mutex<(Arc<Bridge>, u32)>>,
    rt: Runtime,
    params: Params,
    server: String,
    /// The bridge cut this connection after a cancel that did not stop (shared with its statements).
    reset: Arc<AtomicBool>,
    /// The driver fetches as many rows a trip as Celer asks for (see `informix_speed` in engine_tests.rs).
    pub page_fetch: bool,
}

impl JdbcConn {
    pub fn connect(cfg: &ConnConfig, rt: Runtime, params: Params) -> Result<JdbcConn> {
        let bridge = Bridge::get(&rt)?;
        let session = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
        let mut conn = JdbcConn { cancel: Arc::new(Mutex::new((bridge.clone(), session))), bridge, session, rt, params, server: String::new(), reset: Arc::new(AtomicBool::new(false)), page_fetch: true };
        conn.open(cfg, None)?;
        Ok(conn)
    }

    fn open(&mut self, cfg: &ConnConfig, database: Option<&str>) -> Result<()> {
        if !self.bridge.alive() {
            self.bridge = Bridge::get(&self.rt)?;
            self.session = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
            *self.cancel.lock() = (self.bridge.clone(), self.session);
        }
        let mut b = Out::default();
        driver_body(&mut b, &self.rt);
        let (url, props) = (self.params)(cfg, database);
        b.str(&url);
        b.varint(props.len() as u64);
        for (k, v) in &props {
            b.str(k);
            b.str(v);
        }
        let reply = self.bridge.call(self.session, OP_CONNECT, &b.0, Some(CONNECT_WAIT))?;
        self.server = In::new(&reply).str()?;
        self.reset.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn run(&self, sql: &str, first: usize) -> Result<JdbcStmt> {
        let mut b = Out::default();
        b.str(sql);
        b.varint(first.min(i32::MAX as usize) as u64);
        b.u8(self.page_fetch as u8);
        let reply = noting_reset(&self.reset, self.bridge.call(self.session, OP_EXEC, &b.0, None))?;
        JdbcStmt::from_exec(self.bridge.clone(), self.session, self.page_fetch, self.reset.clone(), &reply)
    }

    fn simple(&self, op: u8, body: &[u8]) -> Result<()> {
        noting_reset(&self.reset, self.bridge.call(self.session, op, body, None)).map(|_| ())
    }
}

impl Drop for JdbcConn {
    fn drop(&mut self) {
        self.bridge.send(self.session, OP_CLOSE, &[]);
    }
}

impl Link for JdbcConn {
    type Stmt = JdbcStmt;

    fn exec(&mut self, sql: &str, fetch: usize) -> Result<JdbcStmt> {
        self.run(sql, fetch)
    }

    fn query_all(&self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        let mut st = self.run(sql, usize::MAX)?;
        if st.cols.is_empty() {
            return Ok(vec![]);
        }
        Ok(st.read(usize::MAX)?.0)
    }

    fn set_autocommit(&mut self, on: bool) -> Result<()> {
        self.simple(OP_AUTOCOMMIT, &[on as u8])
    }

    fn end_tran(&mut self, commit: bool) -> Result<()> {
        self.simple(if commit { OP_COMMIT } else { OP_ROLLBACK }, &[])
    }

    fn server_info(&self) -> String {
        self.server.clone()
    }

    fn canceller(&self) -> Canceller {
        let target = self.cancel.clone();
        Arc::new(move || {
            let (bridge, session) = target.lock().clone();
            bridge.send(session, OP_CANCEL, &[]);
        })
    }

    fn reconnect(&mut self, cfg: &ConnConfig, database: Option<&str>) -> Result<()> {
        self.open(cfg, database).map_err(explain)
    }

    fn reset_pending(&self) -> bool {
        self.reset.load(Ordering::SeqCst)
    }
}

/// A statement run through the bridge: the first rows came with its answer, the rest arrive in batches.
pub struct JdbcStmt {
    bridge: Arc<Bridge>,
    session: u32,
    /// The bridge's cursor (0: the statement returned no rows).
    cursor: u32,
    cols: Vec<ColumnInfo>,
    plan: Vec<Wire>,
    rows: VecDeque<Vec<Cell>>,
    more: bool,
    in_result: bool,
    count: i64,
    messages: Vec<String>,
    page_fetch: bool,
    reset: Arc<AtomicBool>,
}

impl JdbcStmt {
    fn from_exec(bridge: Arc<Bridge>, session: u32, page_fetch: bool, reset: Arc<AtomicBool>, reply: &[u8]) -> Result<JdbcStmt> {
        let mut r = In::new(reply);
        let warnings = r.varint()?;
        let mut messages = Vec::new();
        for _ in 0..warnings {
            messages.push(r.str()?);
        }
        let mut st = JdbcStmt { bridge, session, cursor: 0, cols: vec![], plan: vec![], rows: VecDeque::new(), more: false, in_result: false, count: -1, messages, page_fetch, reset };
        if r.u8()? == 0 {
            st.count = r.zigzag()?;
            return Ok(st);
        }
        st.cursor = r.varint()? as u32;
        let (cols, plan) = read_columns(&mut r)?;
        st.cols = cols;
        st.plan = plan;
        st.more = read_batch(&mut r, &st.plan, &mut st.rows)?;
        st.in_result = true;
        Ok(st)
    }

    fn fetch_more(&mut self, want: usize) -> Result<()> {
        let mut b = Out::default();
        b.varint(self.cursor as u64);
        b.varint(want.clamp(1, i32::MAX as usize) as u64);
        b.u8(self.page_fetch as u8);
        let reply = noting_reset(&self.reset, self.bridge.call(self.session, OP_FETCH, &b.0, None))?;
        self.more = read_batch(&mut In::new(&reply), &self.plan, &mut self.rows)?;
        Ok(())
    }
}

impl Drop for JdbcStmt {
    fn drop(&mut self) {
        if self.cursor != 0 {
            let mut b = Out::default();
            b.varint(self.cursor as u64);
            self.bridge.send(self.session, OP_CLOSE_CURSOR, &b.0);
        }
    }
}

impl LinkStmt for JdbcStmt {
    fn num_cols(&mut self) -> Result<usize> {
        Ok(self.cols.len())
    }

    fn begin_result(&mut self, _ncols: usize) -> Result<()> {
        self.in_result = !self.cols.is_empty();
        Ok(())
    }

    fn columns(&self) -> &[ColumnInfo] {
        &self.cols
    }

    fn in_result(&self) -> bool {
        self.in_result
    }

    fn read(&mut self, n: usize) -> Result<(Vec<Vec<Cell>>, bool)> {
        let mut out = Vec::with_capacity(n.min(4096));
        while out.len() < n {
            if let Some(r) = self.rows.pop_front() {
                out.push(r);
                continue;
            }
            if !self.more {
                break;
            }
            self.fetch_more(n - out.len())?;
        }
        let more = !self.rows.is_empty() || self.more;
        if !more {
            self.in_result = false;
        }
        Ok((out, more))
    }

    fn row_count(&self) -> i64 {
        self.count
    }

    /// Informix gives one result per statement (a batch is split into statements by the driver above).
    fn more_results(&mut self) -> Result<bool> {
        self.in_result = false;
        Ok(false)
    }

    fn messages(&mut self) -> &mut Vec<String> {
        &mut self.messages
    }
}

pub type JdbcDriver = LinkDriver<JdbcConn>;

/// Informix over JDBC: the same dialect as the ODBC path (catalog, batches, DDL…) on the bridge's connection.
pub fn connect(cfg: ConnConfig, rt: Runtime) -> Result<JdbcDriver> {
    let conn = JdbcConn::connect(&cfg, rt, informix_params).map_err(explain)?;
    LinkDriver::over(cfg, conn)
}

/// `connect` with the statement's fetch size left to FET_BUF_SIZE (`page_fetch` false), to measure both.
#[cfg(test)]
pub fn connect_tuned(cfg: ConnConfig, rt: Runtime, page_fetch: bool) -> Result<JdbcDriver> {
    let mut conn = JdbcConn::connect(&cfg, rt, informix_params).map_err(explain)?;
    conn.page_fetch = page_fetch;
    LinkDriver::over(cfg, conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip() {
        let values = [0i64, 1, -1, 63, -64, 64, 127, 128, 300, -300, i32::MAX as i64, i32::MIN as i64, i64::MAX, i64::MIN];
        let mut out = Out::default();
        for v in values {
            out.zigzag(v);
            out.varint(v as u64);
        }
        out.f64(-2.5);
        out.str("Zoë 李 😀");
        let mut r = In::new(&out.0);
        for v in values {
            assert_eq!(r.zigzag().unwrap(), v);
            assert_eq!(r.varint().unwrap(), v as u64);
        }
        assert_eq!(r.f64().unwrap(), -2.5);
        assert_eq!(r.str().unwrap(), "Zoë 李 😀");
        assert!(r.u8().is_err(), "nothing left");
        // Small numbers are one byte; the wire type rows use is compact.
        let mut one = Out::default();
        one.zigzag(-64);
        assert_eq!(one.0.len(), 1);
    }

    /// Columns and a batch as CelerBridge.java writes them.
    fn sample(cols: &[(&str, &str, i32, i64, u8)], rows: &[Vec<Option<Vec<u8>>>], more: bool) -> Vec<u8> {
        let mut b = Out::default();
        b.varint(0); // no warnings
        b.u8(1);
        b.varint(7); // cursor
        b.varint(cols.len() as u64);
        for (name, ty, jdbc, scale, wire) in cols {
            b.str(name);
            b.str(ty);
            b.zigzag(*jdbc as i64);
            b.varint(10);
            b.zigzag(*scale);
            b.u8(*wire);
        }
        b.u32(rows.len() as u32);
        b.u8(more as u8);
        for row in rows {
            let mut nulls = vec![0u8; cols.len().div_ceil(8)];
            for (i, v) in row.iter().enumerate() {
                if v.is_none() {
                    nulls[i / 8] |= 1 << (i % 8);
                }
            }
            b.0.extend_from_slice(&nulls);
            for v in row.iter().flatten() {
                b.0.extend_from_slice(v);
            }
        }
        b.0
    }

    fn enc(f: impl FnOnce(&mut Out)) -> Option<Vec<u8>> {
        let mut o = Out::default();
        f(&mut o);
        Some(o.0)
    }

    fn decode(reply: &[u8]) -> (u32, Vec<ColumnInfo>, Vec<Wire>, Vec<Vec<Cell>>, bool) {
        let mut r = In::new(reply);
        assert_eq!(r.varint().unwrap(), 0);
        assert_eq!(r.u8().unwrap(), 1);
        let cursor = r.varint().unwrap() as u32;
        let (cols, plan) = read_columns(&mut r).unwrap();
        let mut rows = VecDeque::new();
        let more = read_batch(&mut r, &plan, &mut rows).unwrap();
        (cursor, cols, plan, rows.into(), more)
    }

    #[test]
    fn rows_decode_with_nulls_and_types() {
        let cols = [
            ("id", "serial", 4, 0, W_INT),
            ("nombre", "varchar", 12, 0, W_TEXT),
            ("activo", "boolean", 16, 0, W_BOOL),
            ("importe", "decimal", 3, 2, W_TEXT),
            ("ratio", "float", 8, 0, W_DOUBLE),
            ("foto", "byte", -4, 0, W_BYTES),
            ("momento", "datetime year to fraction(3)", 93, 3, W_TEXT),
            ("alta", "date", 91, 0, W_TEXT),
            ("big", "int8", -5, 0, W_INT),
        ];
        let rows = vec![
            vec![enc(|o| o.zigzag(1)), enc(|o| o.str("Zoë")), enc(|o| o.u8(1)), enc(|o| o.str("120.50")), enc(|o| o.f64(0.25)), enc(|o| o.bytes(&[0xCA, 0xFE])), enc(|o| o.str("2024-03-15 10:20:30.500")), enc(|o| o.str("2024-03-15")), enc(|o| o.zigzag(i64::MAX))],
            vec![enc(|o| o.zigzag(-2)), None, None, None, None, None, None, None, None],
        ];
        let (cursor, cols, plan, got, more) = decode(&sample(&cols, &rows, true));
        assert_eq!(cursor, 7);
        assert!(more);
        assert_eq!(cols.iter().map(|c| c.kind).collect::<Vec<_>>(), vec![ColKind::Number, ColKind::Text, ColKind::Bool, ColKind::Number, ColKind::Number, ColKind::Binary, ColKind::Date, ColKind::Date, ColKind::Number]);
        assert_eq!(plan[6].frac, Some(3));
        assert!(matches!(got[0][0], Cell::Int(1)));
        assert!(matches!(&got[0][1], Cell::Text(s) if s == "Zoë"));
        assert!(matches!(got[0][2], Cell::Bool(true)));
        assert!(matches!(&got[0][3], Cell::Text(s) if s == "120.50"));
        assert!(matches!(got[0][4], Cell::Num(v) if v == 0.25));
        assert!(matches!(&got[0][5], Cell::Text(s) if s == "0xCAFE"));
        assert!(matches!(&got[0][6], Cell::Text(s) if s == "2024-03-15 10:20:30.500"));
        // Beyond JavaScript's safe range: text.
        assert!(matches!(&got[0][8], Cell::Text(s) if s == &i64::MAX.to_string()));
        assert!(matches!(got[1][0], Cell::Int(-2)));
        assert!(got[1][1..].iter().all(|c| matches!(c, Cell::Null)), "the second byte of the bitmap too");
    }

    #[test]
    fn datetime_fractions_follow_the_qualifier() {
        assert_eq!(fraction_digits("datetime year to fraction(5)", 0), 5);
        assert_eq!(fraction_digits("datetime year to fraction", 0), 3);
        assert_eq!(fraction_digits("datetime year to second", 6), 0);
        assert_eq!(fraction_digits("datetime hour to minute", 6), 0);
        assert_eq!(fraction_digits("timestamp", 6), 6);
        // A Timestamp.toString() value is cut to the column's digits.
        let cols = [("m", "datetime year to minute", 93, 0, W_TEXT)];
        let rows = vec![vec![enc(|o| o.str("2024-01-15 10:30:00.0"))]];
        let (_, _, _, got, more) = decode(&sample(&cols, &rows, false));
        assert!(!more);
        assert!(matches!(&got[0][0], Cell::Text(s) if s == "2024-01-15 10:30:00"));
    }

    #[test]
    fn update_counts_and_warnings() {
        let mut b = Out::default();
        b.varint(1);
        b.str("[01I01] Database has transactions");
        b.u8(0);
        b.zigzag(42);
        let mut r = In::new(&b.0);
        assert_eq!(r.varint().unwrap(), 1);
        assert_eq!(r.str().unwrap(), "[01I01] Database has transactions");
        assert_eq!(r.u8().unwrap(), 0);
        assert_eq!(r.zigzag().unwrap(), 42);
    }

    #[test]
    fn errors_read_and_explained() {
        let mut b = Out::default();
        b.str("Database locale information mismatch.");
        b.str("IX000");
        b.zigzag(-23197);
        let e = read_error(&b.0);
        assert_eq!(e.to_string(), "[IX000] Database locale information mismatch. (-23197)");
        let x = explain(e).to_string();
        assert!(x.starts_with("INFORMIX_GUIDE:locale: ") && x.contains("DB_LOCALE=") && x.contains("(-23197)"), "{x}");
        let server = explain(anyhow::Error::new(JdbcError { message: "INFORMIXSERVER does not match either DBSERVERNAME or DBSERVERALIASES.".into(), state: "IX000".into(), code: -761 })).to_string();
        assert!(server.starts_with("INFORMIX_GUIDE:server: "), "{server}");
        let refused = explain(anyhow::Error::new(JdbcError { message: "java.net.ConnectException: Connection refused".into(), state: String::new(), code: -79716 })).to_string();
        assert!(refused.starts_with("INFORMIX_GUIDE:server: "), "{refused}");
        let other = explain(anyhow::Error::new(JdbcError { message: "A syntax error has occurred.".into(), state: "42000".into(), code: -201 })).to_string();
        assert_eq!(other, "[42000] A syntax error has occurred. (-201)");
        assert_eq!(explain(anyhow!("otro")).to_string(), "otro");
        // The bridge cut the connection after a cancel: noted for the next operation, shown without its SQLSTATE.
        let reset = AtomicBool::new(false);
        let r: Result<()> = noting_reset(&reset, Err(anyhow::Error::new(JdbcError { message: "Consulta cancelada (se reabre la conexión…)".into(), state: RESET_STATE.into(), code: 0 })));
        assert!(reset.load(Ordering::SeqCst));
        assert_eq!(r.unwrap_err().to_string(), "Consulta cancelada (se reabre la conexión…)");
        let other = AtomicBool::new(false);
        let _ = noting_reset::<()>(&other, Err(anyhow!("[42000] x")));
        assert!(!other.load(Ordering::SeqCst));
    }

    fn informix_cfg() -> ConnConfig {
        ConnConfig {
            kind: DbKind::Informix,
            host: "db.example".into(),
            port: Some(9088),
            instance: "ol_test".into(),
            database: "stores".into(),
            user: "informix".into(),
            password: Some("s3cr;et".into()),
            informix_mode: "jdbc".into(),
            ..Default::default()
        }
    }

    #[test]
    fn url_and_properties() {
        let mut cfg = informix_cfg();
        assert_eq!(jdbc_url(&cfg, None), "jdbc:informix-sqli://db.example:9088/stores:INFORMIXSERVER=ol_test");
        assert_eq!(jdbc_url(&cfg, Some("otra")), "jdbc:informix-sqli://db.example:9088/otra:INFORMIXSERVER=ol_test");
        cfg.database.clear();
        cfg.instance.clear();
        cfg.port = None;
        assert_eq!(jdbc_url(&cfg, None), "jdbc:informix-sqli://db.example:9088");
        assert!(!jdbc_url(&cfg, None).contains("s3cr"), "never the password in the URL");

        let props = jdbc_props(&cfg);
        let get = |props: &[(String, String)], k: &str| props.iter().filter(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()).collect::<Vec<_>>();
        assert_eq!(get(&props, "password"), vec!["s3cr;et"]);
        assert_eq!(get(&props, "FET_BUF_SIZE"), vec![FET_BUF_SIZE.to_string()]);
        assert_eq!(get(&props, "INFORMIXCONTIME"), vec!["20"]);
        assert!(get(&props, "DELIMIDENT").is_empty());

        cfg.extra = " DB_LOCALE=es_ES.819 ; FET_BUF_SIZE=65536;IFX_LOCK_MODE_WAIT=10;;OPT=a=b ".into();
        let props = jdbc_props(&cfg);
        assert_eq!(get(&props, "DB_LOCALE"), vec!["es_ES.819"]);
        assert_eq!(get(&props, "FET_BUF_SIZE"), vec!["65536"], "the user's value, once");
        assert_eq!(get(&props, "IFX_LOCK_MODE_WAIT"), vec!["10"]);
        assert_eq!(get(&props, "OPT"), vec!["a=b"]);
    }

    /// A JVM warning on stdout (DBeaver's JRE has no base CDS archive) is shown, not dropped.
    #[test]
    fn stray_output_is_shown() {
        let warning = b"[0.003s][warning][cds] -XX:ArchiveClassesAtExit is unsupported when base CDS archive is not loaded.\r\n";
        let line = stray_output(warning);
        assert!(line.starts_with("Java escribió en la salida del puente: [0.003s][warning][cds]"), "{line}");
        assert!(!line.ends_with('\n'), "{line}");
    }

    /// The real bridge, when CI has a Java to run it (CELER_TEST_JAVA): it starts, says hello and answers errors.
    #[test]
    fn bridge_answers() {
        let Ok(java) = std::env::var("CELER_TEST_JAVA") else { return };
        assert!(bridge_included(), "CI builds the bridge (CELER_REQUIRE_BRIDGE=1)");
        let dir = std::env::temp_dir().join(format!("celer-bridge-test-{}", std::process::id()));
        let class = "com.informix.jdbc.IfxDriver";
        // CI runs Java 21: the bridge starts with the class-data archive options it gets from a JRE 19 and newer.
        let rt = Runtime { java: PathBuf::from(java), java_major: 21, driver_class: class.into(), jars: vec![dir.join("no-such-driver.jar")], dir: dir.clone() };
        let err = check(&rt).unwrap_err().to_string();
        assert!(err.contains("ClassNotFound") || err.contains(class), "{err}");
        // A connection whose driver cannot load fails cleanly, and the bridge keeps serving.
        let err = JdbcConn::connect(&informix_cfg(), rt.clone(), informix_params).err().expect("no driver").to_string();
        assert!(err.contains("ClassNotFound") || err.contains(class), "{err}");
        assert!(Bridge::get(&rt).unwrap().alive());
        let _ = std::fs::remove_dir_all(dir);
    }
}
