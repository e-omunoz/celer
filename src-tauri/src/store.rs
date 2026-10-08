//! Persistencia local: conexiones, ajustes, espacio de trabajo e historial.
//! Las contraseñas se guardan en el almacén de credenciales del sistema operativo.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::Result;
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

/// Lee una credencial del servicio propio y, en desarrollo, de la copia instalada si no hay una propia.
pub(crate) fn keyring_get(id: &str) -> Option<String> {
    let read = |service: &str| keyring::Entry::new(service, id).and_then(|e| e.get_password()).ok();
    read(keyring_service()).or_else(|| if keyring_service() == "Celer" { None } else { read("Celer") })
}

pub struct Store {
    pub dir: PathBuf,
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
        Store { dir }
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

    pub fn load_connections(&self) -> Vec<ConnConfig> {
        self.read("connections.json")
            .and_then(|s| serde_json::from_str::<Vec<ConnConfig>>(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_connections(&self, conns: &[ConnConfig]) -> Result<()> {
        let clean: Vec<ConnConfig> = conns
            .iter()
            .cloned()
            .map(|mut c| {
                c.password = None;
                c
            })
            .collect();
        self.write_atomic("connections.json", &serde_json::to_string_pretty(&clean)?)
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
        if let Ok(e) = keyring::Entry::new(keyring_service(), id) {
            let _ = e.delete_credential();
        }
        let mut map = self.secrets();
        if map.remove(id).is_some() {
            let _ = self.write_secrets(&map);
        }
    }

    pub fn load_json(&self, name: &str) -> serde_json::Value {
        self.read(name)
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null)
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
