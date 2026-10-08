//! Persistencia local: conexiones, ajustes, espacio de trabajo e historial.
//! Las contraseñas se guardan en el almacén de credenciales del sistema operativo.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::model::ConnConfig;

const HISTORY_MAX: usize = 5000;

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

pub struct Store {
    pub dir: PathBuf,
    conns_file: parking_lot::Mutex<ConnsFile>,
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
        Store { dir, conns_file: Default::default() }
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
                        Ok(c) => conns.push(c),
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
        if let Some(p) = keyring_get(id) {
            return Some(p);
        }
        self.secrets().get(id).cloned()
    }

    pub fn set_password(&self, id: &str, pwd: &str) -> Result<()> {
        mark_deleted(id, false);
        if let Ok(e) = keyring::Entry::new(keyring_service(), id) {
            if e.set_password(pwd).is_ok() {
                let mut map = self.secrets();
                if map.remove(id).is_some() {
                    let _ = self.write_secrets(&map);
                }
                return Ok(());
            }
        }
        let mut map = self.secrets();
        map.insert(id.to_string(), pwd.to_string());
        self.write_secrets(&map)
    }

    pub fn delete_password(&self, id: &str) {
        mark_deleted(id, true);
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
        let path = self.path("history.jsonl");
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        writeln!(f, "{}", serde_json::to_string(e)?)?;
        // Compactación ocasional para mantener el fichero acotado.
        if f.metadata().map(|m| m.len()).unwrap_or(0) > 8 * 1024 * 1024 {
            drop(f);
            let mut all = self.history_all();
            let skip = all.len().saturating_sub(HISTORY_MAX);
            all.drain(..skip);
            let body: String = all
                .iter()
                .filter_map(|e| serde_json::to_string(e).ok())
                .map(|s| s + "\n")
                .collect();
            self.write_atomic("history.jsonl", &body)?;
        }
        Ok(())
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
        let mut all = self.history_all();
        all.reverse();
        all.into_iter()
            .filter(|e| {
                f.is_empty()
                    || e.sql.to_lowercase().contains(&f)
                    || e.conn_name.to_lowercase().contains(&f)
            })
            .take(limit)
            .collect()
    }

    pub fn clear_history(&self) -> Result<()> {
        let _ = fs::remove_file(self.path("history.jsonl"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Store;

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
}