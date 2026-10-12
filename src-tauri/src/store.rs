//! Persistencia local: conexiones, ajustes, espacio de trabajo e historial.
//! Las contraseñas se guardan en el almacén de credenciales del sistema operativo.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::model::ConnConfig;

/// Queries kept by default (Ajustes › Historial changes it: `set_history_retention`).
const HISTORY_MAX: usize = 5000;
/// history.jsonl is compacted past twice what it keeps, down to that, so the next compaction is far away. It keeps
/// HISTORY_ENTRY_BYTES per entry of «Consultas que se guardan» (an entry is ~300 bytes on average, so the setting's
/// count is what limits), and at least HISTORY_KEEP_BYTES.
const HISTORY_KEEP_BYTES: usize = 4 * 1024 * 1024;
const HISTORY_ENTRY_BYTES: usize = 512;
/// The SQL of one entry is kept up to this many characters (a pasted dump would otherwise fill the history).
const HISTORY_SQL_MAX: usize = 100_000;

/// Servicio del almacén de credenciales. Una compilación de depuración con `CELER_DATA_DIR` escribe en
/// "Celer-dev" y solo lee "Celer" como alternativa: las pruebas nunca cambian las contraseñas de una copia
/// instalada.
pub(crate) fn keyring_service() -> &'static str {
    if crate::dev_data_dir().is_some() {
        "Celer-dev"
    } else {
        "Celer"
    }
}

/// Lee una credencial del servicio propio y, en desarrollo, de la copia instalada si no hay una propia (salvo
/// que se haya borrado en esta ejecución: borrar no debe devolver la de la copia instalada).
pub(crate) fn keyring_get(id: &str) -> Option<String> {
    let read = |service: &str| keyring::Entry::new(service, id).and_then(|e| e.get_password()).ok();
    read(keyring_service()).or_else(|| {
        if keyring_service() == "Celer" || dev_deleted().lock().map(|d| d.contains(id)).unwrap_or(false) {
            None
        } else {
            read("Celer")
        }
    })
}

/// Credenciales borradas en esta ejecución (solo cuenta en desarrollo, ver `keyring_get`).
fn dev_deleted() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static DELETED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    DELETED.get_or_init(Default::default)
}

/// Anota (o quita) una credencial borrada en esta ejecución.
pub(crate) fn mark_deleted(id: &str, deleted: bool) {
    if let Ok(mut set) = dev_deleted().lock() {
        if deleted {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
    }
}

/// Windows' credential store takes about 2.5 KB per credential: a longer secret (an RSA private key for an SSH
/// tunnel) is kept in parts of this many characters, `{id}#part1…`, and `{id}` says how many there are.
const PART_CHARS: usize = 1000;
const PARTS_MARK: &str = "\u{1}celer-parts:";

fn part_account(id: &str, i: usize) -> String {
    format!("{id}#part{i}")
}

fn parts_of(value: &str) -> Option<usize> {
    value.strip_prefix(PARTS_MARK).and_then(|n| n.parse().ok())
}

/// Writes a secret to the system's store, in parts when it is long. False when the store did not take it.
fn keyring_set(id: &str, value: &str) -> bool {
    let set = |account: &str, text: &str| keyring::Entry::new(keyring_service(), account).and_then(|e| e.set_password(text)).is_ok();
    delete_parts(id);
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= PART_CHARS {
        return set(id, value);
    }
    let parts: Vec<String> = chars.chunks(PART_CHARS).map(|c| c.iter().collect()).collect();
    for (i, part) in parts.iter().enumerate() {
        if !set(&part_account(id, i + 1), part) {
            return false;
        }
    }
    set(id, &format!("{PARTS_MARK}{}", parts.len()))
}

/// Removes the parts of a long secret, if `id` was one.
fn delete_parts(id: &str) {
    let Some(n) = keyring::Entry::new(keyring_service(), id).and_then(|e| e.get_password()).ok().as_deref().and_then(parts_of) else { return };
    for i in 1..=n {
        if let Ok(e) = keyring::Entry::new(keyring_service(), &part_account(id, i)) {
            let _ = e.delete_credential();
        }
    }
}

pub struct Store {
    pub dir: PathBuf,
    conns_file: parking_lot::Mutex<ConnsFile>,
    /// One writer of history.jsonl at a time (windows append from their own threads).
    history_lock: parking_lot::Mutex<()>,
    /// Secrets typed at connect time and kept only in memory (an imported SSH password that was never saved).
    session_secrets: parking_lot::Mutex<std::collections::HashMap<String, String>>,
    /// Ajustes › Historial: entries kept, and days an entry is kept (0: no limit).
    history_max: std::sync::atomic::AtomicUsize,
    history_days: std::sync::atomic::AtomicU64,
}

/// What the last read of connections.json left behind.
#[derive(Default)]
struct ConnsFile {
    /// It could not be read (locked, or damaged and not set aside): saving would replace connections still in it.
    unread: bool,
    /// Entries this version does not understand (another version's engine…), written back as they were on save.
    unknown: Vec<serde_json::Value>,
    /// For the UI, once.
    problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    pub conn_id: String,
    pub conn_name: String,
    pub database: String,
    pub at: i64,
    pub elapsed_ms: u64,
    pub ok: bool,
    pub rows: Option<i64>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        let _ = fs::create_dir_all(&dir);
        Store {
            dir,
            conns_file: Default::default(),
            history_lock: Default::default(),
            session_secrets: Default::default(),
            history_max: std::sync::atomic::AtomicUsize::new(HISTORY_MAX),
            history_days: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Escritura atómica: primero a un temporal y luego se renombra.
    pub fn write_atomic(&self, name: &str, data: &str) -> Result<()> {
        let tmp = self.path(&format!("{name}.tmp"));
        fs::write(&tmp, data)?;
        fs::rename(&tmp, self.path(name))?;
        Ok(())
    }

    pub fn read(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.path(name)).ok()
    }

    /// The saved connections. Like `load_json`: a locked file is retried, a damaged one is set aside, and then
    /// `connections_problem` says so. Entries are read one by one: one that is not understood is kept in the file.
    pub fn load_connections(&self) -> Vec<ConnConfig> {
        const NAME: &str = "connections.json";
        let mut file = ConnsFile::default();
        let mut conns = Vec::new();
        match self.load_json(NAME) {
            Ok(serde_json::Value::Null) => {}
            Ok(serde_json::Value::Array(items)) => {
                for item in items {
                    match serde_json::from_value::<ConnConfig>(item.clone()) {
                        Ok(mut c) => {
                            // In memory only: the file stays as it was until the connection is saved.
                            c.normalize_environment();
                            conns.push(c)
                        }
                        Err(_) => file.unknown.push(item),
                    }
                }
                if !file.unknown.is_empty() {
                    file.problem = Some(format!(
                        "{} conexión(es) de {NAME} no se entienden en esta versión de Celer: no se muestran, pero se conservan en el fichero",
                        file.unknown.len()
                    ));
                }
            }
            Ok(_) => match self.set_aside(NAME, "no es una lista de conexiones") {
                Ok(msg) => file.problem = Some(msg),
                Err(e) => {
                    file.unread = true;
                    file.problem = Some(e.to_string());
                }
            },
            Err(e) => {
                // Still there: it could not be read (or set aside), so it must not be written over.
                file.unread = self.path(NAME).exists();
                file.problem = Some(if file.unread {
                    format!("{e}. Las conexiones no se guardarán hasta reiniciar Celer, para no perder las del fichero")
                } else {
                    e.to_string()
                });
            }
        }
        *self.conns_file.lock() = file;
        conns
    }

    /// What went wrong reading connections.json at start, once.
    pub fn connections_problem(&self) -> Option<String> {
        self.conns_file.lock().problem.take()
    }

    pub fn save_connections(&self, conns: &[ConnConfig]) -> Result<()> {
        let file = self.conns_file.lock();
        if file.unread {
            return Err(anyhow!("connections.json no se pudo leer al iniciar Celer: no se guarda encima para no perder las conexiones que tiene. Reinicia Celer"));
        }
        let mut out = Vec::with_capacity(conns.len() + file.unknown.len());
        for c in conns {
            let mut c = c.clone();
            c.password = None;
            c.ssh = c.ssh.without_secrets();
            out.push(serde_json::to_value(c)?);
        }
        out.extend(file.unknown.iter().cloned());
        self.write_atomic("connections.json", &serde_json::to_string_pretty(&out)?)
    }

    fn secrets(&self) -> HashMap<String, String> {
        self.read("secrets.json")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_secrets(&self, map: &HashMap<String, String>) -> Result<()> {
        self.write_atomic("secrets.json", &serde_json::to_string(map)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                fs::set_permissions(self.path("secrets.json"), fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// El almacén del sistema es la vía principal. Si no hay servicio de secretos
    /// (sesión sin llavero), se guarda en `secrets.json` con permisos restringidos.
    pub fn get_password(&self, id: &str) -> Option<String> {
        if let Some(p) = self.session_secrets.lock().get(id) {
            return Some(p.clone());
        }
        if let Some(p) = keyring_get(id) {
            // A long secret kept in parts (`keyring_set`): all of them, or (a part missing) as if there were none.
            match parts_of(&p) {
                Some(n) => {
                    if let Some(whole) = (1..=n).map(|i| keyring_get(&part_account(id, i))).collect::<Option<String>>() {
                        return Some(whole);
                    }
                }
                None => return Some(p),
            }
        }
        self.secrets().get(id).cloned()
    }

    /// Keeps a secret for this run only (never written anywhere); an empty one forgets it.
    pub fn set_session_secret(&self, id: &str, value: &str) {
        let mut map = self.session_secrets.lock();
        if value.is_empty() {
            map.remove(id);
        } else {
            map.insert(id.to_string(), value.to_string());
        }
    }

    pub fn set_password(&self, id: &str, pwd: &str) -> Result<()> {
        // A saved secret replaces the one typed for this run (which would otherwise be read first).
        self.session_secrets.lock().remove(id);
        mark_deleted(id, false);
        if keyring_set(id, pwd) {
            let mut map = self.secrets();
            if map.remove(id).is_some() {
                let _ = self.write_secrets(&map);
            }
            return Ok(());
        }
        let mut map = self.secrets();
        map.insert(id.to_string(), pwd.to_string());
        self.write_secrets(&map)
    }

    pub fn delete_password(&self, id: &str) {
        self.session_secrets.lock().remove(id);
        mark_deleted(id, true);
        delete_parts(id);
        if let Ok(e) = keyring::Entry::new(keyring_service(), id) {
            let _ = e.delete_credential();
        }
        let mut map = self.secrets();
        if map.remove(id).is_some() {
            let _ = self.write_secrets(&map);
        }
    }

    /// The JSON file `name`, or Null when it does not exist. Errors (and the caller must then not save over it):
    /// a file that cannot be read (locked, not UTF-8…), and one that does not parse, which is first kept aside as
    /// `name.unreadable-<time>` so that the next save starts clean without destroying it.
    pub fn load_json(&self, name: &str) -> Result<serde_json::Value> {
        let path = self.path(name);
        let mut attempt = 0;
        let bytes = loop {
            match fs::read(&path) {
                Ok(bytes) => break bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Null),
                // A short lock (an antivirus scan, a backup) usually goes away.
                Err(_) if attempt < 3 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                Err(e) => return Err(anyhow!("No se pudo leer {name}: {e}")),
            }
        };
        // Not UTF-8 is damaged too (set aside like a file that does not parse).
        let parsed = String::from_utf8(bytes).map_err(|e| e.to_string()).and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()));
        match parsed {
            Ok(value) => Ok(value),
            Err(e) => Err(anyhow!(self.set_aside(name, &e)?)),
        }
    }

    /// Renames the damaged file `name` to `name.unreadable-<time>`; the message for the user, or an error when it
    /// could not be moved.
    fn set_aside(&self, name: &str, why: &str) -> Result<String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let aside = format!("{name}.unreadable-{stamp}");
        fs::rename(self.path(name), self.path(&aside)).map_err(|err| anyhow!("{name} está dañado ({why}) y no se pudo apartar: {err}"))?;
        Ok(format!("{name} estaba dañado ({why}): se ha guardado aparte como {aside} y se empieza de cero"))
    }

    pub fn add_history(&self, e: &HistoryEntry) -> Result<()> {
        let _lock = self.history_lock.lock();
        let path = self.path("history.jsonl");
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let line = match e.sql.char_indices().nth(HISTORY_SQL_MAX) {
            Some((cut, _)) => {
                let sql = format!("{}\n-- … (recortado en el historial)", &e.sql[..cut]);
                serde_json::to_string(&HistoryEntry { sql, ..e.clone() })?
            }
            None => serde_json::to_string(e)?,
        };
        writeln!(f, "{line}")?;
        // Compactación ocasional para mantener el fichero acotado: por tamaño, no solo por número, hasta la mitad.
        let keep_bytes = self.history_keep_bytes();
        if f.metadata().map(|m| m.len()).unwrap_or(0) > 2 * keep_bytes as u64 {
            drop(f);
            let lines: Vec<String> = self.history_all().iter().filter_map(|e| serde_json::to_string(e).ok()).collect();
            let mut bytes = 0;
            let keep = lines
                .iter()
                .rev()
                .take(self.history_max())
                .take_while(|l| {
                    bytes += l.len() + 1;
                    bytes <= keep_bytes
                })
                .count();
            let body: String = lines[lines.len() - keep..].iter().map(|l| format!("{l}\n")).collect();
            self.write_atomic("history.jsonl", &body)?;
        }
        Ok(())
    }

    fn history_max(&self) -> usize {
        self.history_max.load(std::sync::atomic::Ordering::Relaxed).max(1)
    }

    /// What history.jsonl keeps when it is compacted by size: grows with «Consultas que se guardan».
    fn history_keep_bytes(&self) -> usize {
        HISTORY_KEEP_BYTES.max(self.history_max().saturating_mul(HISTORY_ENTRY_BYTES))
    }

    /// Entries older than this (milliseconds since 1970) are past the retention; 0 when there is no limit.
    fn history_cutoff(&self) -> i64 {
        let days = self.history_days.load(std::sync::atomic::Ordering::Relaxed);
        if days == 0 {
            return 0;
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        now - days as i64 * 86_400_000
    }

    /// Ajustes › Historial: keep the newest `max` entries of the last `days` days (0: any age), from now on and in the
    /// file right away. Returns how many entries were dropped.
    pub fn set_history_retention(&self, max: usize, days: u64) -> Result<usize> {
        self.history_max.store(max.max(1), std::sync::atomic::Ordering::Relaxed);
        self.history_days.store(days, std::sync::atomic::Ordering::Relaxed);
        let _lock = self.history_lock.lock();
        let all = self.history_all();
        let cutoff = self.history_cutoff();
        let kept: Vec<&HistoryEntry> = all.iter().filter(|e| e.at >= cutoff).collect();
        let kept = &kept[kept.len().saturating_sub(self.history_max())..];
        let dropped = all.len() - kept.len();
        if dropped > 0 {
            let body: String = kept.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| format!("{l}\n")).collect();
            self.write_atomic("history.jsonl", &body)?;
        }
        Ok(dropped)
    }

    fn history_all(&self) -> Vec<HistoryEntry> {
        let Ok(f) = fs::File::open(self.path("history.jsonl")) else {
            return vec![];
        };
        std::io::BufReader::new(f)
            .lines()
            .map_while(|l| l.ok())
            .filter_map(|l| serde_json::from_str(&l).ok())
            .collect()
    }

    pub fn history(&self, filter: &str, limit: usize) -> Vec<HistoryEntry> {
        let f = filter.to_lowercase();
        let cutoff = self.history_cutoff();
        let mut all = self.history_all();
        all.reverse();
        all.into_iter()
            .take(self.history_max())
            .filter(|e| e.at >= cutoff)
            .filter(|e| {
                f.is_empty()
                    || e.sql.to_lowercase().contains(&f)
                    || e.conn_name.to_lowercase().contains(&f)
            })
            .take(limit)
            .collect()
    }

    pub fn clear_history(&self) -> Result<()> {
        let _lock = self.history_lock.lock();
        let _ = fs::remove_file(self.path("history.jsonl"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Store;

    #[test]
    fn a_saved_or_deleted_secret_replaces_the_one_typed_for_this_run() {
        let dir = std::env::temp_dir().join(format!("celer-store-session-{}", std::process::id()));
        let store = Store::new(dir.clone());
        let id = format!("celer-test-{}#ssh-password", std::process::id());
        store.set_session_secret(&id, "mistyped");
        assert_eq!(store.get_password(&id).as_deref(), Some("mistyped"));
        // Refused: forgotten, so the next connect asks again.
        store.set_session_secret(&id, "");
        assert_eq!(store.get_password(&id), None);
        store.set_session_secret(&id, "mistyped");
        store.set_password(&id, "right").unwrap();
        assert_eq!(store.get_password(&id).as_deref(), Some("right"), "the saved one wins over the typed one");
        store.set_session_secret(&id, "mistyped");
        store.delete_password(&id);
        assert_eq!(store.get_password(&id), None, "deleting it forgets the typed one too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_json_file_is_kept_aside() {
        let dir = std::env::temp_dir().join(format!("celer-store-{}", std::process::id()));
        let store = Store::new(dir.clone());
        std::fs::write(dir.join("library.json"), "{ \"scripts\": [ broken").unwrap();
        let err = store.load_json("library.json").unwrap_err().to_string();
        assert!(err.contains("library.json.unreadable-"), "{err}");
        assert!(!dir.join("library.json").exists(), "the broken file is not left to be overwritten");
        let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("library.json.unreadable-"));
        assert!(kept, "it is kept next to it");
        std::fs::write(dir.join("ok.json"), "{\"a\":1}").unwrap();
        assert_eq!(store.load_json("ok.json").unwrap()["a"], 1);
        assert!(store.load_json("missing.json").unwrap().is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_keeps_what_the_settings_say() {
        let dir = std::env::temp_dir().join(format!("celer-store-retention-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let day = 86_400_000;
        let entry = |sql: &str, at: i64| super::HistoryEntry { sql: sql.into(), conn_id: "c".into(), conn_name: "n".into(), database: String::new(), at, elapsed_ms: 1, ok: true, rows: None };
        for (i, age) in [40, 20, 5, 1, 0].iter().enumerate() {
            store.add_history(&entry(&format!("SELECT {i}"), now - age * day)).unwrap();
        }
        // Thirty days: the 40-day-old entry goes, from the file too.
        assert_eq!(store.set_history_retention(5000, 30).unwrap(), 1);
        assert_eq!(store.history("", 100).len(), 4);
        // Two entries at most: the newest two.
        assert_eq!(store.set_history_retention(2, 0).unwrap(), 2);
        let sqls: Vec<String> = store.history("", 100).into_iter().map(|e| e.sql).collect();
        assert_eq!(sqls, vec!["SELECT 4", "SELECT 3"]);
        // No limit again: nothing comes back, nothing more goes.
        assert_eq!(store.set_history_retention(5000, 0).unwrap(), 0);
        assert_eq!(store.history("", 100).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_compacts_by_size() {
        let dir = std::env::temp_dir().join(format!("celer-store-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        let entry = |sql: String| super::HistoryEntry {
            sql,
            conn_id: "c".into(),
            conn_name: "C".into(),
            database: String::new(),
            at: 0,
            elapsed_ms: 0,
            ok: true,
            rows: None,
        };
        // 20 KB statements: 5000 of them are far past the threshold, so the count cap alone would not help.
        let file = dir.join("history.jsonl");
        let mut compactions = 0;
        let mut last = 0;
        for i in 0..1000 {
            store.add_history(&entry(format!("SELECT {i} -- {}", "x".repeat(20_000)))).unwrap();
            let len = std::fs::metadata(&file).unwrap().len();
            if len < last {
                compactions += 1;
                assert!(len <= super::HISTORY_KEEP_BYTES as u64, "{len}");
            }
            last = len;
        }
        // ~20 MB written: compacted twice or so, not on every statement once past 8 MB.
        assert!((1..=5).contains(&compactions), "{compactions}");
        let newest = store.history("", 1);
        assert!(newest[0].sql.starts_with("SELECT 999 "));
        // A huge statement is cut.
        store.add_history(&entry("y".repeat(300_000))).unwrap();
        let cut = &store.history("", 1)[0].sql;
        assert!(cut.len() < 100_100 && cut.ends_with("(recortado en el historial)"));
        let _ = std::fs::remove_file(&file);
        // A larger «Consultas que se guardan» keeps that many typical statements: the size bound grows with it.
        store.set_history_retention(30_000, 0).unwrap();
        let mut body = String::new();
        for i in 0..28_000 {
            body.push_str(&serde_json::to_string(&entry(format!("SELECT * FROM clientes WHERE id = {i} AND nombre LIKE '%{}%'", "a".repeat(200)))).unwrap());
            body.push('\n');
        }
        std::fs::write(&file, body).unwrap();
        assert!(std::fs::metadata(&file).unwrap().len() > 8 * 1024 * 1024, "past where the fixed bound compacted to 4 MB");
        for i in 0..100 {
            store.add_history(&entry(format!("SELECT {i}"))).unwrap();
        }
        assert_eq!(store.history_all().len(), 28_100, "nothing dropped below the count");
        store.set_history_retention(super::HISTORY_MAX, 0).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn connections_file_is_never_lost() {
        let dir = std::env::temp_dir().join(format!("celer-store-conns-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        let file = dir.join("connections.json");
        // One entry this version does not understand: the others load, and it is written back on save.
        std::fs::write(&file, r#"[{"id":"a","name":"A","kind":"postgres"},{"id":"b","name":"B","kind":"oracle"}]"#).unwrap();
        let conns = store.load_connections();
        assert_eq!(conns.len(), 1);
        assert!(store.connections_problem().unwrap().contains("1 conexión"));
        assert!(store.connections_problem().is_none(), "told once");
        store.save_connections(&conns).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved.as_array().unwrap().len(), 2);
        assert_eq!(saved[1]["kind"], "oracle");
        // Damaged: set aside, and saving starts a new file.
        std::fs::write(&file, r#"[{"id":"a","name":"A","kind":"postgres"},]"#).unwrap();
        assert!(store.load_connections().is_empty());
        assert!(store.connections_problem().unwrap().contains("unreadable-"));
        assert!(!file.exists());
        store.save_connections(&[]).unwrap();
        // Unreadable (a folder in its place stands for a lock): it is not written over.
        let _ = std::fs::remove_file(&file);
        std::fs::create_dir(&file).unwrap();
        assert!(store.load_connections().is_empty());
        assert!(store.connections_problem().is_some());
        assert!(store.save_connections(&[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_secrets_are_kept_in_parts() {
        // A 4 KB RSA key does not fit in one Windows credential (2.5 KB): it goes in parts and comes back whole.
        let dir = std::env::temp_dir().join(format!("celer-store-parts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        let id = format!("celer-test-parts-{}#ssh-key", std::process::id());
        let key: String = (0..3300).map(|i| char::from(b'A' + (i % 26) as u8)).chain("€ñ".chars()).collect();
        store.set_password(&id, &key).unwrap();
        assert_eq!(store.get_password(&id).as_deref(), Some(key.as_str()));
        let in_keyring = keyring::Entry::new(super::keyring_service(), &id).and_then(|e| e.get_password()).ok();
        if let Some(head) = in_keyring {
            // The system store took it: a header, and four parts of at most 1000 characters.
            assert_eq!(head, format!("{}4", super::PARTS_MARK));
            let part = keyring::Entry::new(super::keyring_service(), &super::part_account(&id, 4)).unwrap().get_password().unwrap();
            assert_eq!(part.chars().count(), 302);
            // A short one replaces it and its parts go.
            store.set_password(&id, "corta").unwrap();
            assert_eq!(store.get_password(&id).as_deref(), Some("corta"));
            assert!(keyring::Entry::new(super::keyring_service(), &super::part_account(&id, 1)).unwrap().get_password().is_err());
            store.set_password(&id, &key).unwrap();
        } else {
            eprintln!("sin almacén de credenciales del sistema: secrets.json");
        }
        store.delete_password(&id);
        assert!(store.get_password(&id).is_none());
        if super::keyring_service() == "Celer" {
            assert!(keyring::Entry::new("Celer", &super::part_account(&id, 2)).unwrap().get_password().is_err(), "parts deleted too");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ssh_secrets_never_reach_the_file() {
        use crate::model::{ConnConfig, DbKind, SshConfig};
        let dir = std::env::temp_dir().join(format!("celer-store-ssh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        let ssh = SshConfig {
            enabled: true,
            host: "bastion".into(),
            user: "ops".into(),
            auth: "key".into(),
            jumps: vec!["edge:2022".into()],
            password: Some("ssh-pass-1".into()),
            passphrase: Some("frase-2".into()),
            private_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----key-3".into()),
            forwarded_to: "db:5432".into(),
            ..Default::default()
        };
        let with = ConnConfig { id: "a".into(), kind: DbKind::Postgres, password: Some("db-4".into()), ssh, ..Default::default() };
        let without = ConnConfig { id: "b".into(), kind: DbKind::Mysql, ..Default::default() };
        store.save_connections(&[with, without]).unwrap();
        let text = std::fs::read_to_string(dir.join("connections.json")).unwrap();
        for secret in ["ssh-pass-1", "frase-2", "key-3", "db-4", "privateKey", "passphrase", "forwardedTo"] {
            assert!(!text.contains(secret), "{secret} in connections.json");
        }
        let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(saved[0]["ssh"]["host"], "bastion");
        assert_eq!(saved[0]["ssh"]["jumps"][0], "edge:2022");
        assert!(saved[1].get("ssh").is_none(), "no ssh block for a connection without a tunnel");
        let back = store.load_connections();
        assert_eq!(back[0].ssh.auth, "key");
        assert!(back[0].ssh.password.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}