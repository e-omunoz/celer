//! Local error log (Ayuda › Registro de errores): Rust panics, driver errors, unhandled UI errors and failed IPC calls,
//! one JSON line each in `<data>/logs/errors.log`, rotated to `errors.1.log` past `MAX_BYTES` (so at most twice that on
//! disk). Every entry is scrubbed before it is written: no SQL text, data values, passwords, connection strings, hosts
//! or user paths. Nothing here is ever sent anywhere; the report window (#112) attaches entries only when the user
//! ticks it, after a preview.

use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

const FILE: &str = "errors.log";
const OLD: &str = "errors.1.log";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_MESSAGE: usize = 2000;
const MAX_STACK: usize = 8000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Milliseconds since 1970.
    pub at: i64,
    pub version: String,
    /// panic, driver:postgres, driver:informix-drda, ui, ipc:<command>…
    pub area: String,
    pub message: String,
    #[serde(default)]
    pub stack: String,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITING: Mutex<()> = Mutex::new(());

/// Where the log goes (`<data>/logs`), and a panic hook that records every panic before the default one prints it.
pub fn init(data_dir: &Path) {
    let _ = DIR.set(data_dir.join("logs"));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "pánico sin mensaje".into());
        let place = info.location().map(|l| format!(" ({}:{})", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        let stack = format!("hilo {thread}\n{}", std::backtrace::Backtrace::force_capture());
        record("panic", &format!("{message}{place}"), &stack);
        previous(info);
    }));
}

/// The folder of the log (for «Abrir carpeta»).
pub fn folder() -> Option<PathBuf> {
    DIR.get().cloned()
}

/// Adds a scrubbed entry. Never fails: a log that cannot be written must not break what was being done.
pub fn record(area: &str, message: &str, stack: &str) {
    let Some(dir) = DIR.get() else { return };
    let entry = Entry {
        at: now_ms(),
        version: env!("CARGO_PKG_VERSION").into(),
        area: clean_area(area),
        message: cut(&scrub(message), MAX_MESSAGE),
        stack: cut(&scrub_stack(stack), MAX_STACK),
    };
    let Ok(line) = serde_json::to_string(&entry) else { return };
    let _w = WRITING.lock();
    let _ = fs::create_dir_all(dir);
    let path = dir.join(FILE);
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > MAX_BYTES {
        let _ = fs::rename(&path, dir.join(OLD));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// The newest `limit` entries, newest first (the rotated file after the current one).
pub fn entries(limit: usize) -> Vec<Entry> {
    let Some(dir) = DIR.get() else { return vec![] };
    let _w = WRITING.lock();
    let mut all = read(&dir.join(OLD));
    all.extend(read(&dir.join(FILE)));
    all.reverse();
    all.truncate(limit);
    all
}

/// «Vaciar»: both files go.
pub fn clear() -> std::io::Result<()> {
    let Some(dir) = DIR.get() else { return Ok(()) };
    let _w = WRITING.lock();
    for name in [FILE, OLD] {
        match fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

fn read(path: &Path) -> Vec<Entry> {
    let Ok(f) = fs::File::open(path) else { return vec![] };
    std::io::BufReader::new(f).lines().map_while(|l| l.ok()).filter_map(|l| serde_json::from_str(&l).ok()).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Areas are short labels the code chooses: anything else is cut down to letters, digits and `:-_`.
fn clean_area(area: &str) -> String {
    let s: String = area.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_')).take(48).collect();
    if s.is_empty() {
        "?".into()
    } else {
        s
    }
}

fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────── scrubbing

struct Rule {
    re: Regex,
    with: &'static str,
}

fn rule(re: &str, with: &'static str) -> Rule {
    Rule { re: Regex::new(re).expect("regla de limpieza"), with }
}

/// The rules, in order. The same ones (same order, same samples: dev/fixtures/scrub-samples.json) are in
/// src/errorLog.ts for the browser preview.
fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            // SQL Server (tiberius) wraps the server's message in quotes, which may hold quotes of its own.
            rule(r"Token error: '(.*)' on server \S+", "Token error: ${1} on server …"),
            rule(r"\bon server \S+", "on server …"),
            // URLs: scheme kept, the rest (user, password, host, path) not.
            rule(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s'\x22<>]+", "${1}…"),
            // Connection-string pairs and secrets.
            rule(
                r"(?i)\b(password|passwd|pwd|user ?id|uid|user(?:name)?|server|host(?:name)?|address|addr|data source|dsn|database|dbname|initial catalog|port|service|informixserver|api[_-]?key|token|secret)\s*=\s*(\{[^}]*\}|\x22[^\x22]*\x22|'[^']*'|[^;\s,)]*)",
                "${1}=…",
            ),
            rule(r"(?i)\b(password|passwd|pwd|secret|token|api[_ -]?key)\s*:\s*[^\s;,)]+", "${1}: …"),
            // The statement: PostgreSQL's LINE n: and its caret, MySQL's near '…' at line n, and SQL in a message.
            rule(r"(?m)^(\s*LINE \d+:).*$", "${1} ‹SQL›"),
            rule(r"(?m)^\s*\^\s*$\n?", ""),
            rule(r"near '.*' at line (\d+)", "near '…' at line ${1}"),
            rule(
                r"(?i)\b(?:select\b[^\n]*\bfrom\b|insert\s+into\b|update\b[^\n]*\bset\b|delete\s+from\b|merge\s+into\b|create\s+(?:or\s+replace\s+)?(?:table|view|index|procedure|function|trigger)\b|alter\s+table\b|drop\s+(?:table|view|index)\b|truncate\s+table\b)[^\n]*",
                "‹SQL›",
            ),
            // Values and names: PostgreSQL's Key (col)=(value) and failing row, quoted text, one-word parentheses.
            rule(r"\([^()\n]*\)=\([^()\n]*\)", "(…)=(…)"),
            rule(r"(?i)(row contains) \([^\n]*\)", "${1} (…)"),
            rule(r"'(?:[^'\n]|'')*'", "'…'"),
            rule(r"\x22[^\x22\n]*\x22", "\"…\""),
            rule(r"`[^`\n]*`", "`…`"),
            rule(r"«[^»\n]*»", "«…»"),
            rule(r"\(([^()\s]*[a-z][^()\s]*)\)", "(…)"),
            // Machines and people.
            rule(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "‹ip›"),
            rule(r"[\w.+-]+@[\w-]+\.[\w.-]+", "‹email›"),
        ]
    })
}

/// User folders: C:\Users\<name>\, /home/<name>/, /Users/<name>/ (any slash).
fn path_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            rule(r"(?i)\b([a-z]:[\\/]+(?:users|documents and settings)[\\/]+)[^\\/\s\x22';:]+", "${1}…"),
            rule(r"(/(?:home|Users)/)[^/\s\x22';:]+", "${1}…"),
        ]
    })
}

/// The name of the person using this machine, as paths and messages may carry it.
fn user_name() -> Option<String> {
    static NAME: OnceLock<Option<String>> = OnceLock::new();
    NAME.get_or_init(|| {
        ["USERNAME", "USER", "LOGNAME"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .map(|s| s.trim().to_string())
            .find(|s| s.chars().count() >= 3)
    })
    .clone()
}

fn apply(text: &str, rules: &[Rule]) -> String {
    rules.iter().fold(text.to_string(), |acc, r| r.re.replace_all(&acc, r.with).into_owned())
}

fn without_user(text: String, user: Option<&str>) -> String {
    match user {
        Some(name) => match Regex::new(&format!("(?i){}", regex::escape(name))) {
            Ok(re) => re.replace_all(&text, "‹usuario›").into_owned(),
            Err(_) => text,
        },
        None => text,
    }
}

/// A message without SQL text, values, secrets, connection strings, hosts or user paths.
pub fn scrub(text: &str) -> String {
    scrub_as(text, user_name().as_deref())
}

pub fn scrub_as(text: &str, user: Option<&str>) -> String {
    without_user(apply(&apply(text, path_rules()), rules()), user)
}

/// A stack trace keeps its frames (function, file, line): only user paths, the user's name and quoted text go.
pub fn scrub_stack(text: &str) -> String {
    let quoted = [rule(r"'(?:[^'\n]|'')*'", "'…'"), rule(r"\x22[^\x22\n]*\x22", "\"…\"")];
    without_user(apply(&apply(text, path_rules()), &quoted), user_name().as_deref())
}

/// Engine tests: the error a real server gave carries `secret` (so the check means something), and its log entry does
/// not; the start of the message (what failed) survives.
#[cfg(test)]
pub fn assert_scrubbed(engine: &str, error: &str, secret: &str) {
    assert!(error.contains(secret), "{engine}: el error del servidor no lleva «{secret}», la prueba no comprueba nada: {error}");
    let out = scrub_as(error, None);
    println!("registro de errores ({engine}): {out}");
    assert!(!out.contains(secret), "{engine}: «{secret}» sigue en la entrada: {out}");
    assert!(out.chars().filter(|c| c.is_alphabetic()).count() >= 10, "{engine}: no queda nada útil: {out}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Sample {
        engine: String,
        text: String,
        gone: Vec<String>,
        kept: Vec<String>,
    }

    /// Error texts of every engine (and paths, URLs, statements): what must go and what must stay. The browser's
    /// scrubber (src/errorLog.ts) is checked against the same file by dev/errorlog-check.ts.
    #[test]
    fn scrubs_every_engine_sample() {
        let samples: Vec<Sample> = serde_json::from_str(include_str!("../../dev/fixtures/scrub-samples.json")).unwrap();
        assert!(samples.len() >= 15);
        for s in samples {
            let out = scrub_as(&s.text, None);
            for g in &s.gone {
                assert!(!out.contains(g.as_str()), "{}: «{g}» sigue en\n{out}", s.engine);
            }
            for k in &s.kept {
                assert!(out.contains(k.as_str()), "{}: «{k}» se perdió en\n{out}", s.engine);
            }
        }
    }

    #[test]
    fn the_user_name_goes_anywhere() {
        assert_eq!(scrub_as("C:\\Temp\\Oscar-backup failed", Some("oscar")), "C:\\Temp\\‹usuario›-backup failed");
    }

    #[test]
    fn stacks_keep_their_frames() {
        let stack = "Error: x\n    at run (http://tauri.localhost/assets/index-AbC.js:12:34)\n    at C:\\Users\\ana\\x.js:1:2";
        let out = scrub_stack(stack);
        assert!(out.contains("at run (http://tauri.localhost/assets/index-AbC.js:12:34)"), "{out}");
        assert!(!out.contains("ana"), "{out}");
    }

    #[test]
    fn rotates_and_clears() {
        let dir = std::env::temp_dir().join(format!("celer-errlog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        init(&dir);
        // init keeps the first folder it was given (tests share the process): write where it points.
        let logs = folder().unwrap();
        clear().unwrap();
        record("driver:postgres", "db error: ERROR: invalid input syntax for type integer: \"celer-secret-42\"", "");
        let first = entries(10);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].area, "driver:postgres");
        assert!(!first[0].message.contains("celer-secret-42"));
        assert_eq!(first[0].version, env!("CARGO_PKG_VERSION"));
        record("ui<script>", &"x".repeat(5000), "");
        assert_eq!(entries(1)[0].area, "uiscript");
        assert!(entries(1)[0].message.chars().count() <= MAX_MESSAGE + 1);
        // Past the cap the file rotates: the total stays bounded and the newest entries are kept.
        for i in 0..400 {
            record("ui", &format!("error {i} {}", "y".repeat(1500)), "");
        }
        let size = |n: &str| fs::metadata(logs.join(n)).map(|m| m.len()).unwrap_or(0);
        assert!(size(FILE) <= MAX_BYTES && size(OLD) <= MAX_BYTES, "{} {}", size(FILE), size(OLD));
        assert!(entries(1)[0].message.starts_with("error 399"));
        clear().unwrap();
        assert!(entries(10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
