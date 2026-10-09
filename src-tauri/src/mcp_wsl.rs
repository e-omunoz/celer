//! Claude Code inside WSL as an MCP client of the Windows Celer.
//!
//! A WSL distro runs Windows programs through interop with their stdio piped, so `/mnt/c/…/celer.exe --mcp` started
//! by Claude Code inside the distro is the very same Windows process as from Windows: it reads the Windows
//! `mcp.json`, the Windows credential store and writes the Windows audit log. The only differences are the path
//! (`C:\X` is `<automount root>c/X` in the distro) and where Claude Code keeps its servers (`~/.claude.json` of the
//! distro). This module finds the distros, converts the path, registers Celer in a distro with its own `claude mcp
//! add` and reads the distro's `~/.claude.json` to tell whether it is registered with the current path.
//!
//! The registration adds `--client=wsl:<distro>` after `--mcp`: the audit log then says which client called.
//! Parsing and conversion are plain functions (tested below); running `wsl.exe` is Windows only.

#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

/// Distros that Docker Desktop installs for itself: no shell, no Claude Code.
const INTERNAL_DISTROS: &[&str] = &["docker-desktop", "docker-desktop-data", "rancher-desktop", "rancher-desktop-data"];
const DEFAULT_ROOT: &str = "/mnt/";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    /// The distro `wsl.exe` starts without `-d`.
    pub default: bool,
    pub running: bool,
    /// Probed (it was running, or the user asked to check it, which starts it).
    pub checked: bool,
    /// Windows interop (running .exe files from the distro): `[interop] enabled` in /etc/wsl.conf and the binfmt
    /// entry WSL registers when it is on.
    pub interop: Option<bool>,
    pub home: String,
    /// Where `claude` is in the distro ("" when it was not found).
    pub claude: String,
    /// `[automount] root` of /etc/wsl.conf ("/mnt/" by default).
    pub automount_root: String,
    /// Celer's executable as the distro sees it ("" when it cannot: a network path).
    pub exe_path: String,
    /// The `claude mcp add` command that registers Celer in this distro.
    pub command: String,
    /// "yes" (registered with this executable), "stale" (registered with another path: an update or a reinstall
    /// moved it), "no" or "unknown" (not checked).
    pub registered: String,
    /// The command Claude Code has for `celer` in the distro, when it has one.
    pub registered_command: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslInfo {
    /// WSL can be used from here (Windows with `wsl.exe` and at least one distro).
    pub available: bool,
    pub distros: Vec<WslDistro>,
    pub error: String,
    /// When it was read (ms since the epoch).
    pub checked_at: i64,
}

// ───────────────────────────── Parsing ─────────────────────────────

/// `wsl.exe` writes UTF-16LE (unless WSL_UTF8 is set): text in either form, without BOM or NULs.
pub fn decode(bytes: &[u8]) -> String {
    // ASCII text in UTF-16LE has a NUL as its second byte.
    let utf16 = bytes.starts_with(&[0xff, 0xfe]) || (bytes.len() >= 2 && bytes[0] != 0 && bytes[1] == 0);
    let text = if utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };
    text.replace(['\u{feff}', '\0'], "")
}

/// `wsl.exe -l -q`: one distro per line (Docker Desktop's own ones left out).
pub fn parse_list(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !INTERNAL_DISTROS.iter().any(|d| d.eq_ignore_ascii_case(l)))
        .map(str::to_string)
        .collect()
}

/// `wsl.exe -l -v`: the default distro is the line marked with `*` (the headers and states are translated, the
/// mark is not).
pub fn parse_default(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.trim_start().strip_prefix('*')).and_then(|rest| rest.split_whitespace().next()).map(str::to_string)
}

/// /etc/wsl.conf: whether interop is enabled and the automount root.
pub fn parse_wsl_conf(text: &str) -> (bool, String) {
    let mut section = String::new();
    let mut interop = true;
    let mut root = DEFAULT_ROOT.to_string();
    for line in text.lines() {
        let line = line.split(['#', ';']).next().unwrap_or("").trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name.trim().to_lowercase();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().to_lowercase();
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        match (section.as_str(), key.as_str()) {
            ("interop", "enabled") => interop = !value.eq_ignore_ascii_case("false") && value != "0",
            ("automount", "root") if !value.is_empty() => {
                root = if value.ends_with('/') { value.to_string() } else { format!("{value}/") };
            }
            _ => {}
        }
    }
    (interop, root)
}

/// `C:\Program Files\Celer\celer.exe` → `/mnt/c/Program Files/Celer/celer.exe` (with the distro's automount
/// root). None for a path the distro cannot reach by its drive letter (a network share).
pub fn to_wsl_path(windows: &str, root: &str) -> Option<String> {
    let path = windows.strip_prefix(r"\\?\").unwrap_or(windows);
    let mut chars = path.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None;
    }
    let rest = chars.as_str().replace('\\', "/");
    let rest = rest.trim_start_matches('/');
    let root = if root.is_empty() { DEFAULT_ROOT.to_string() } else if root.ends_with('/') { root.to_string() } else { format!("{root}/") };
    Some(format!("{root}{}/{rest}", drive.to_ascii_lowercase()))
}

/// Single quotes for a POSIX shell.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The argument that tells the audit log which client called.
pub fn client_arg(distro: &str) -> String {
    let clean: String = distro.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    format!("--client=wsl:{clean}")
}

/// The command that registers Celer for Claude Code in a distro (user scope: every project of the distro).
pub fn register_command(claude: &str, exe: &str, distro: &str) -> String {
    let claude = if claude.is_empty() { "claude".to_string() } else if claude.contains(char::is_whitespace) { sh_quote(claude) } else { claude.to_string() };
    format!("{claude} mcp add --scope user celer -- {} --mcp {}", sh_quote(exe), client_arg(distro))
}

/// How a Claude Code config (`~/.claude.json`) has `celer`: ("yes" | "stale" | "no", the command it runs).
/// User scope first, then any project of the distro.
pub fn registration(config: &Value, exe: &str, same: impl Fn(&str, &str) -> bool) -> (String, String) {
    let mut entries: Vec<&Value> = Vec::new();
    if let Some(e) = config.pointer("/mcpServers/celer") {
        entries.push(e);
    }
    if let Some(projects) = config.get("projects").and_then(Value::as_object) {
        entries.extend(projects.values().filter_map(|p| p.pointer("/mcpServers/celer")));
    }
    let Some(first) = entries.first() else { return ("no".into(), String::new()) };
    let describe = |e: &Value| {
        let command = e.get("command").and_then(Value::as_str).unwrap_or("");
        let args: Vec<&str> = e.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        (command.to_string(), args.contains(&"--mcp"), format!("{command} {}", args.join(" ")).trim().to_string())
    };
    for e in &entries {
        let (command, mcp, text) = describe(e);
        if mcp && same(&command, exe) {
            return ("yes".into(), text);
        }
    }
    ("stale".into(), describe(first).2)
}

/// Key=value lines of the probe script; `conf:` lines are /etc/wsl.conf.
fn parse_probe(text: &str) -> (String, bool, String, String) {
    let mut home = String::new();
    let mut binfmt = true;
    let mut claude = String::new();
    let mut conf = String::new();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("home=") {
            home = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("interop=") {
            binfmt = v.trim() == "1";
        } else if let Some(v) = line.strip_prefix("claude=") {
            claude = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("conf:") {
            conf.push_str(v);
            conf.push('\n');
        }
    }
    (home, binfmt, claude, conf)
}

const PROBE: &str = r#"echo "home=$HOME"
if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then echo interop=1; else echo interop=0; fi
c=$(command -v claude 2>/dev/null)
if [ -z "$c" ]; then for p in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" /usr/local/bin/claude; do if [ -x "$p" ]; then c=$p; break; fi; done; fi
echo "claude=$c"
if [ -f /etc/wsl.conf ]; then sed 's/^/conf:/' /etc/wsl.conf; fi"#;

/// A distro as the probe found it (pure: the probe's output and the distro's `~/.claude.json`).
pub fn distro_from_probe(name: &str, default: bool, running: bool, probe: &str, claude_json: Option<&str>, exe: &str) -> WslDistro {
    let (home, binfmt, claude, conf) = parse_probe(probe);
    let (conf_interop, root) = parse_wsl_conf(&conf);
    let exe_path = to_wsl_path(exe, &root).unwrap_or_default();
    let command = if exe_path.is_empty() { String::new() } else { register_command(&claude, &exe_path, name) };
    let (registered, registered_command) = match claude_json.map(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}'))) {
        Some(Ok(v)) => registration(&v, &exe_path, |a, b| a == b),
        Some(Err(_)) => ("unknown".into(), String::new()),
        None => ("no".into(), String::new()),
    };
    WslDistro {
        name: name.to_string(),
        default,
        running,
        checked: true,
        interop: Some(conf_interop && binfmt),
        home,
        claude,
        automount_root: root,
        exe_path,
        command,
        registered,
        registered_command,
        error: String::new(),
    }
}

fn unchecked(name: &str, default: bool, running: bool, exe: &str) -> WslDistro {
    let exe_path = to_wsl_path(exe, DEFAULT_ROOT).unwrap_or_default();
    WslDistro {
        name: name.to_string(),
        default,
        running,
        checked: false,
        interop: None,
        home: String::new(),
        claude: String::new(),
        automount_root: DEFAULT_ROOT.into(),
        command: if exe_path.is_empty() { String::new() } else { register_command("", &exe_path, name) },
        exe_path,
        registered: "unknown".into(),
        registered_command: String::new(),
        error: String::new(),
    }
}

// ───────────────────────────── Running wsl.exe (Windows) ─────────────────────────────

/// Runs `wsl.exe` with these arguments, without a console window, up to `timeout`: (exit ok, stdout, stderr).
#[cfg(windows)]
fn wsl(args: &[&str], timeout: Duration) -> Result<(bool, String, String), String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let system = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
    let exe = system.join("System32").join("wsl.exe");
    let mut child = Command::new(if exe.is_file() { exe } else { "wsl.exe".into() })
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar wsl.exe: {e}"))?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut o = Vec::new();
        let mut e = Vec::new();
        if let Some(s) = out.as_mut() {
            let _ = s.read_to_end(&mut o);
        }
        if let Some(s) = err.as_mut() {
            let _ = s.read_to_end(&mut e);
        }
        (o, e)
    });
    let t0 = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if t0.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wsl.exe no respondió en {} s", timeout.as_secs()));
            }
        }
    };
    let (o, e) = reader.join().unwrap_or_default();
    Ok((status.success(), decode(&o), decode(&e)))
}

#[cfg(windows)]
fn read_claude_json(distro: &str, home: &str) -> Option<String> {
    if home.starts_with('/') {
        let rel = format!("{}/.claude.json", home.trim_end_matches('/')).replace('/', "\\");
        for host in [r"\\wsl.localhost\", r"\\wsl$\"] {
            if let Ok(text) = std::fs::read_to_string(format!("{host}{distro}{rel}")) {
                return Some(text);
            }
        }
    }
    // The network provider may be off: the distro reads it itself.
    match wsl(&["-d", distro, "-e", "sh", "-c", "cat \"$HOME/.claude.json\" 2>/dev/null"], Duration::from_secs(20)) {
        Ok((true, text, _)) if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

#[cfg(windows)]
fn probe(name: &str, default: bool, running: bool, exe: &str) -> WslDistro {
    match wsl(&["-d", name, "-e", "sh", "-lc", PROBE], Duration::from_secs(25)) {
        Ok((true, out, _)) => {
            let (home, ..) = parse_probe(&out);
            let json = read_claude_json(name, &home);
            distro_from_probe(name, default, true, &out, json.as_deref(), exe)
        }
        Ok((false, _, err)) | Err(err) => {
            let mut d = unchecked(name, default, running, exe);
            d.error = if err.trim().is_empty() { "No se pudo abrir la distribución".into() } else { err.trim().to_string() };
            d
        }
    }
}

/// The installed distros. `check`: also probe this stopped one (that starts it); the running ones always are.
#[cfg(windows)]
pub fn info(exe: &str, check: Option<&str>) -> WslInfo {
    let t = Duration::from_secs(15);
    let list = match wsl(&["-l", "-q"], t) {
        Ok((true, out, _)) => parse_list(&out),
        Ok((false, out, err)) => {
            return WslInfo { error: format!("{} {}", out.trim(), err.trim()).trim().to_string(), checked_at: crate::mcp::now_ms_pub(), ..Default::default() };
        }
        Err(e) => return WslInfo { error: e, checked_at: crate::mcp::now_ms_pub(), ..Default::default() },
    };
    let running = match wsl(&["-l", "-q", "--running"], t) {
        Ok((_, out, _)) => parse_list(&out),
        Err(_) => vec![],
    };
    let default = wsl(&["-l", "-v"], t).ok().and_then(|(_, out, _)| parse_default(&out));
    let distros = list
        .iter()
        .map(|name| {
            let is_default = default.as_deref() == Some(name.as_str());
            let is_running = running.contains(name);
            if is_running || check == Some(name.as_str()) {
                probe(name, is_default, is_running, exe)
            } else {
                unchecked(name, is_default, false, exe)
            }
        })
        .collect::<Vec<_>>();
    let info = WslInfo { available: !distros.is_empty(), distros, error: String::new(), checked_at: crate::mcp::now_ms_pub() };
    *cache().lock() = Some((Instant::now(), info.clone()));
    info
}

#[cfg(not(windows))]
pub fn info(_exe: &str, _check: Option<&str>) -> WslInfo {
    WslInfo { checked_at: crate::mcp::now_ms_pub(), ..Default::default() }
}

/// Registers Celer for Claude Code in a distro (an earlier `celer` entry of user scope is replaced). Returns what
/// the command said.
#[cfg(windows)]
pub fn register(exe: &str, distro: &str) -> Result<String, String> {
    let d = probe(distro, false, true, exe);
    if !d.error.is_empty() {
        return Err(d.error);
    }
    if d.interop == Some(false) {
        return Err(format!("La interoperabilidad con Windows está desactivada en {distro} ([interop] enabled en /etc/wsl.conf): desde ahí no se puede ejecutar celer.exe."));
    }
    if d.claude.is_empty() {
        return Err(format!("No se encontró Claude Code en {distro}. Instálalo allí (https://claude.com/claude-code) y vuelve a intentarlo."));
    }
    if d.exe_path.is_empty() {
        return Err("Celer está en una ruta de red: WSL no la ve por su letra de unidad.".into());
    }
    let script = format!("{} mcp remove --scope user celer >/dev/null 2>&1; {}", sh_quote(&d.claude), register_command(&d.claude, &d.exe_path, distro));
    match wsl(&["-d", distro, "-e", "sh", "-lc", &script], Duration::from_secs(60))? {
        (true, out, err) => {
            *cache().lock() = None;
            Ok(format!("{}{}", out.trim(), err.trim()).trim().to_string())
        }
        (false, out, err) => Err(format!("{} {}", out.trim(), err.trim()).trim().to_string()),
    }
}

#[cfg(not(windows))]
pub fn register(_exe: &str, _distro: &str) -> Result<String, String> {
    Err("Registrar Celer en WSL solo es posible desde Celer para Windows.".into())
}

fn cache() -> &'static Mutex<Option<(Instant, WslInfo)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, WslInfo)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The last reading when it is recent enough; otherwise None, and a new reading starts in the background (the
/// status bar asks often, and `wsl.exe` takes a moment).
pub fn cached(exe: &str, max_age: Duration) -> Option<WslInfo> {
    static REFRESHING: OnceLock<Mutex<bool>> = OnceLock::new();
    let current = cache().lock().clone();
    let fresh = current.as_ref().is_some_and(|(t, _)| t.elapsed() < max_age);
    if !fresh && cfg!(windows) {
        let flag = REFRESHING.get_or_init(|| Mutex::new(false));
        let mut busy = flag.lock();
        if !*busy {
            *busy = true;
            let exe = exe.to_string();
            std::thread::spawn(move || {
                let _ = info(&exe, None);
                *REFRESHING.get_or_init(|| Mutex::new(false)).lock() = false;
            });
        }
    }
    current.map(|(_, i)| i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wsl_output_is_decoded_from_utf16() {
        let text = "Ubuntu\r\ndocker-desktop\r\nDebian\r\n";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(parse_list(&decode(&bytes)), vec!["Ubuntu", "Debian"]);
        let no_bom: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(parse_list(&decode(&no_bom)), vec!["Ubuntu", "Debian"]);
        assert_eq!(parse_list(&decode(text.as_bytes())), vec!["Ubuntu", "Debian"]);
        let verbose = "  NOMBRE            ESTADO           VERSIÓN\r\n* Ubuntu-24.04      En ejecución     2\r\n  Debian            Detenido         2\r\n";
        assert_eq!(parse_default(verbose).as_deref(), Some("Ubuntu-24.04"));
        assert_eq!(parse_default("  NAME STATE\n  A Stopped 2\n"), None);
    }

    #[test]
    fn wsl_conf_interop_and_automount_root() {
        assert_eq!(parse_wsl_conf(""), (true, "/mnt/".into()));
        let conf = "[boot]\nsystemd=true\n\n[automount]\nroot = /win  # custom\n[interop]\nenabled=false\n";
        assert_eq!(parse_wsl_conf(conf), (false, "/win/".into()));
        assert_eq!(parse_wsl_conf("[Interop]\nEnabled = true\n[automount]\nroot=\"/\"\n"), (true, "/".into()));
    }

    #[test]
    fn windows_paths_become_wsl_paths() {
        let exe = r"C:\Users\Óscar\AppData\Local\Celer\celer.exe";
        assert_eq!(to_wsl_path(exe, "/mnt/").as_deref(), Some("/mnt/c/Users/Óscar/AppData/Local/Celer/celer.exe"));
        assert_eq!(to_wsl_path(r"D:\celer-target\release\celer.exe", "/").as_deref(), Some("/d/celer-target/release/celer.exe"));
        assert_eq!(to_wsl_path(r"\\?\C:\Program Files\Celer\celer.exe", "/win").as_deref(), Some("/win/c/Program Files/Celer/celer.exe"));
        assert_eq!(to_wsl_path(r"\\server\share\celer.exe", "/mnt/"), None);
        assert_eq!(to_wsl_path("celer", "/mnt/"), None);
    }

    #[test]
    fn the_register_command_quotes_the_path() {
        assert_eq!(
            register_command("/home/o/.local/bin/claude", "/mnt/c/Program Files/Celer/celer.exe", "Ubuntu"),
            "/home/o/.local/bin/claude mcp add --scope user celer -- '/mnt/c/Program Files/Celer/celer.exe' --mcp --client=wsl:Ubuntu"
        );
        assert_eq!(register_command("", "/mnt/c/it's/celer.exe", "Ubuntu 24.04;rm"), "claude mcp add --scope user celer -- '/mnt/c/it'\\''s/celer.exe' --mcp --client=wsl:Ubuntu24.04rm");
    }

    #[test]
    fn registration_is_read_from_claude_json() {
        let exe = "/mnt/c/Celer/celer.exe";
        let eq = |a: &str, b: &str| a == b;
        assert_eq!(registration(&json!({}), exe, eq).0, "no");
        let user = json!({"mcpServers": {"celer": {"type": "stdio", "command": exe, "args": ["--mcp", "--client=wsl:Ubuntu"]}}});
        assert_eq!(registration(&user, exe, eq).0, "yes");
        let old = json!({"mcpServers": {"celer": {"command": "/mnt/c/Old/celer.exe", "args": ["--mcp"]}}});
        let (state, command) = registration(&old, exe, eq);
        assert_eq!(state, "stale");
        assert_eq!(command, "/mnt/c/Old/celer.exe --mcp");
        let project = json!({"projects": {"/home/o/x": {"mcpServers": {"celer": {"command": exe, "args": ["--mcp"]}}}}});
        assert_eq!(registration(&project, exe, eq).0, "yes");
    }

    #[test]
    fn a_probed_distro() {
        let probe = "home=/home/oscar\ninterop=1\nclaude=/home/oscar/.local/bin/claude\nconf:[automount]\nconf:root=/w/\n";
        let json = r#"{"mcpServers":{"celer":{"command":"/w/c/Celer/celer.exe","args":["--mcp"]}}}"#;
        let d = distro_from_probe("Ubuntu", true, true, probe, Some(json), r"C:\Celer\celer.exe");
        assert_eq!(d.exe_path, "/w/c/Celer/celer.exe");
        assert_eq!(d.registered, "yes");
        assert_eq!(d.interop, Some(true));
        assert!(d.command.starts_with("/home/oscar/.local/bin/claude mcp add --scope user celer -- '/w/c/Celer/celer.exe' --mcp"));
        let d = distro_from_probe("Ubuntu", false, true, "home=/root\ninterop=0\nclaude=\n", None, r"C:\Celer\celer.exe");
        assert_eq!((d.interop, d.registered.as_str(), d.claude.as_str()), (Some(false), "no", ""));
        assert!(d.command.starts_with("claude mcp add"));
    }
}
