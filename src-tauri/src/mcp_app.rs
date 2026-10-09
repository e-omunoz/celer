//! The local channel between `celer --mcp` (the process an assistant talks to) and the running Celer, for the tools
//! that act in the app (#100: open a console, a table, a diagram, add a library script, read what is on screen).
//!
//! The app listens on a loopback TCP port chosen by the system and writes `mcp-app.json` in its data folder with the
//! port and a random token. `celer --mcp` reads that file, connects, checks that a Celer answers (a hello line with
//! its process id: a port left by a Celer that has gone may belong to another program now), sends one request with
//! the token and reads one answer. Same data folder, same user: whoever can read the token could already read
//! `mcp.json` and the connections. From WSL the MCP process is still a Windows process, so loopback is the
//! Windows one.
//!
//! The permission checks (connection levels, masking, the "Controlar la aplicación" switches) and the audit happen in
//! the MCP process, before a request is sent: the app only does what it is asked. In the app, a request goes to the
//! last focused full window through its inbox (windows.rs); the window does it and answers with `mcp_app_reply`.
//! What is on screen (`state`) is answered by the core from the layout every window reports.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const CHANNEL_FILE: &str = "mcp-app.json";
pub const NOT_RUNNING: &str = "Celer no está abierto: abre Celer para que la IA pueda usar la aplicación (las herramientas de bases de datos funcionan igualmente).";
/// A request may wait for the user (a password, a confirmation before running on production).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(150);
const HELLO: &str = "celer-app";
const MAX_LINE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Debug, Deserialize)]
struct Request {
    token: String,
    action: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    client: String,
}

// ───────────────────────────── MCP process side ─────────────────────────────

/// Sends one request to the running Celer of this data folder and waits for its answer.
pub fn request(dir: &Path, action: &str, args: Value, client: &str, timeout: Duration) -> Result<Value, String> {
    let text = std::fs::read_to_string(dir.join(CHANNEL_FILE)).map_err(|_| NOT_RUNNING.to_string())?;
    let ep: Endpoint = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| NOT_RUNNING.to_string())?;
    let addr = SocketAddr::from(([127, 0, 0, 1], ep.port));
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|_| NOT_RUNNING.to_string())?;
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?.take(MAX_LINE));
    // A Celer says hello at once; anything else on that port is not one.
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    let mut hello = String::new();
    if reader.read_line(&mut hello).is_err() || serde_json::from_str::<Value>(&hello).ok().and_then(|v| v.get(HELLO).cloned()).is_none() {
        return Err(NOT_RUNNING.to_string());
    }
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    writer.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let body = json!({"token": ep.token, "action": action, "args": args, "client": client});
    writeln!(writer, "{body}").and_then(|_| writer.flush()).map_err(|_| NOT_RUNNING.to_string())?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(n) if n > 0 => {}
        Ok(_) => return Err("Celer cerró la conexión sin responder".into()),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
            return Err(format!("Celer no respondió en {} s (puede estar esperando al usuario)", timeout.as_secs()));
        }
        Err(e) => return Err(format!("No se pudo leer la respuesta de Celer: {e}")),
    }
    let answer: Value = serde_json::from_str(&line).map_err(|e| format!("Respuesta de Celer no válida: {e}"))?;
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(answer.get("error").and_then(Value::as_str).unwrap_or("Celer no pudo hacerlo").to_string())
    }
}

// ───────────────────────────── App side ─────────────────────────────

/// What the app does with a request: answered by the core (`state`) or by a window.
pub trait Handler: Send + Sync + 'static {
    fn handle(&self, action: &str, args: Value, client: &str) -> Result<Value, String>;
}

/// Requests waiting for a window's answer, by id.
#[derive(Default)]
pub struct Pending {
    waiting: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
}

impl Pending {
    /// A new request id and the receiver of its answer.
    pub fn open(&self) -> (String, mpsc::Receiver<Result<Value, String>>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().insert(id.clone(), tx);
        (id, rx)
    }

    pub fn close(&self, id: &str) {
        self.waiting.lock().remove(id);
    }

    /// A window's answer (false when nobody waits for it any more).
    pub fn answer(&self, id: &str, result: Result<Value, String>) -> bool {
        match self.waiting.lock().remove(id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn serve(stream: TcpStream, token: &str, handler: &dyn Handler) {
    let _ = stream.set_nodelay(true);
    let Ok(mut writer) = stream.try_clone() else { return };
    let _ = writer.set_write_timeout(Some(Duration::from_secs(5)));
    if writeln!(writer, "{}", json!({ HELLO: std::process::id() })).and_then(|_| writer.flush()).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.take(MAX_LINE));
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let answer = match serde_json::from_str::<Request>(&line) {
        Ok(req) if same(&req.token, token) => match handler.handle(&req.action, req.args, &req.client) {
            Ok(result) => json!({"ok": true, "result": result}),
            Err(e) => json!({"ok": false, "error": e}),
        },
        Ok(_) => json!({"ok": false, "error": "Petición no autorizada"}),
        Err(e) => json!({"ok": false, "error": format!("Petición no válida: {e}")}),
    };
    let _ = writer.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = writeln!(writer, "{answer}").and_then(|_| writer.flush());
}

/// Starts listening and writes `mcp-app.json` in `dir`. Each connection is served on its own thread.
pub fn start(dir: &Path, handler: Arc<dyn Handler>) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let ep = Endpoint { port, token: token.clone(), pid: std::process::id() };
    let store = crate::store::Store::new(dir.to_path_buf());
    store.write_atomic(CHANNEL_FILE, &serde_json::to_string(&ep)?).map_err(std::io::Error::other)?;
    let token = Arc::new(token);
    std::thread::Builder::new().name("celer-mcp-app".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = handler.clone();
            let token = token.clone();
            let _ = std::thread::Builder::new().name("celer-mcp-app-req".into()).spawn(move || serve(stream, &token, handler.as_ref()));
        }
    })?;
    Ok(port)
}

/// Removes `mcp-app.json` when Celer closes (only if it is still this process's).
pub fn stop(dir: &Path) {
    let path = dir.join(CHANNEL_FILE);
    let mine = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Endpoint>(&t).ok()).is_some_and(|ep| ep.pid == std::process::id());
    if mine {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A stand-in for the app: answers every request with what `f` returns, and records them.
    pub struct FakeApp {
        pub seen: Mutex<Vec<(String, Value, String)>>,
        pub reply: Box<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>,
    }

    impl Handler for FakeApp {
        fn handle(&self, action: &str, args: Value, client: &str) -> Result<Value, String> {
            let r = (self.reply)(action, &args);
            self.seen.lock().push((action.to_string(), args, client.to_string()));
            r
        }
    }

    pub fn fake_app(dir: &Path, reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static) -> Arc<FakeApp> {
        let app = Arc::new(FakeApp { seen: Mutex::new(vec![]), reply: Box::new(reply) });
        start(dir, app.clone()).unwrap();
        app
    }

    fn temp_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("celer-mcp-app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_request_reaches_the_app_and_comes_back() {
        let dir = temp_dir();
        assert_eq!(request(&dir, "ping", json!({}), "Windows", Duration::from_secs(2)).unwrap_err(), NOT_RUNNING, "no file: not running");
        let app = fake_app(&dir, |action, args| match action {
            "echo" => Ok(json!({"got": args.clone()})),
            _ => Err("no sé hacerlo".into()),
        });
        let r = request(&dir, "echo", json!({"a": 1}), "WSL (Ubuntu)", Duration::from_secs(5)).unwrap();
        assert_eq!(r, json!({"got": {"a": 1}}));
        assert_eq!(request(&dir, "other", json!({}), "x", Duration::from_secs(5)).unwrap_err(), "no sé hacerlo");
        assert_eq!(app.seen.lock()[0].2, "WSL (Ubuntu)");

        // A wrong token is refused.
        let text = std::fs::read_to_string(dir.join(CHANNEL_FILE)).unwrap();
        let mut ep: Endpoint = serde_json::from_str(&text).unwrap();
        ep.token = "x".repeat(64);
        std::fs::write(dir.join(CHANNEL_FILE), serde_json::to_string(&ep).unwrap()).unwrap();
        assert_eq!(request(&dir, "echo", json!({}), "x", Duration::from_secs(5)).unwrap_err(), "Petición no autorizada");
        assert_eq!(app.seen.lock().len(), 2, "never handled");

        // A port where nobody answers (a Celer that has gone): not running, at once.
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        ep.port = free.local_addr().unwrap().port();
        drop(free);
        std::fs::write(dir.join(CHANNEL_FILE), serde_json::to_string(&ep).unwrap()).unwrap();
        assert_eq!(request(&dir, "echo", json!({}), "x", Duration::from_secs(5)).unwrap_err(), NOT_RUNNING);
        // A port taken by a program that says nothing: not running after the hello wait, not after the timeout.
        let silent = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        ep.port = silent.local_addr().unwrap().port();
        std::fs::write(dir.join(CHANNEL_FILE), serde_json::to_string(&ep).unwrap()).unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(request(&dir, "echo", json!({}), "x", Duration::from_secs(60)).unwrap_err(), NOT_RUNNING);
        assert!(t0.elapsed() < Duration::from_secs(10));
        drop(silent);

        stop(&dir);
        assert!(!dir.join(CHANNEL_FILE).exists(), "this process's endpoint is removed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pending_answers_reach_their_request() {
        let p = Pending::default();
        let (id, rx) = p.open();
        assert!(p.answer(&id, Ok(json!(1))));
        assert_eq!(rx.recv().unwrap().unwrap(), json!(1));
        assert!(!p.answer(&id, Ok(json!(2))), "answered once");
        let (id, _rx) = p.open();
        p.close(&id);
        assert!(!p.answer(&id, Ok(json!(3))));
    }
}
