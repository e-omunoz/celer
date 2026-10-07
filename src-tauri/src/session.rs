//! Sesiones de base de datos: cada sesión vive en su propio hilo, dueño de la conexión.
//! La interfaz envía trabajos (closures) por un canal y espera la respuesta de forma asíncrona,
//! así una consulta lenta nunca bloquea la ventana ni otras pestañas.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;

use crate::model::*;

/// Operaciones que todo driver debe implementar. Se ejecutan siempre en el hilo de la sesión.
pub trait Driver: Send {
    /// Ejecuta un lote SQL. El primer resultado con más de `fetch` filas queda abierto.
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput>;
    /// Lee más filas del resultado abierto.
    fn fetch(&mut self, n: usize) -> Result<FetchOutput>;
    /// Cierra el resultado abierto, si lo hay.
    fn close_cursor(&mut self) -> Result<()>;
    fn set_autocommit(&mut self, on: bool) -> Result<bool>;
    fn commit(&mut self) -> Result<bool>;
    fn rollback(&mut self) -> Result<bool>;
    /// Hijos de un nodo del árbol de objetos (ruta vacía = raíz).
    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>>;
    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>>;
    fn ddl(&mut self, obj: &ObjectRef) -> Result<String>;
    fn completion(&mut self, database: &str) -> Result<CompletionSchema>;
    fn databases(&mut self) -> Result<Vec<String>>;
    fn current_database(&mut self) -> Result<String>;
    fn use_database(&mut self, db: &str) -> Result<()>;
    /// Nombre completo y entrecomillado del objeto para usarlo en SQL.
    fn qualified_name(&self, obj: &ObjectRef) -> String;
    fn quote_ident(&self, s: &str) -> String;
    /// Descripción del servidor (producto y versión).
    fn server_info(&mut self) -> Result<String>;
    /// Función para cancelar desde otro hilo la operación en curso.
    fn canceller(&self) -> Canceller;
}

pub type Canceller = Arc<dyn Fn() + Send + Sync>;

type Job = Box<dyn FnOnce(&mut dyn Driver) + Send>;

pub struct SessionHandle {
    tx: mpsc::Sender<Job>,
    canceller: Canceller,
    pub conn_id: String,
}

impl SessionHandle {
    /// Abre la conexión en un hilo nuevo. `connect` se ejecuta dentro de ese hilo.
    pub async fn open<F>(conn_id: String, connect: F) -> Result<SessionHandle>
    where
        F: FnOnce() -> Result<Box<dyn Driver>> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<Canceller>>();
        std::thread::Builder::new()
            .name(format!("celer-session-{conn_id}"))
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let mut driver = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(connect)) {
                    Ok(Ok(d)) => d,
                    Ok(Err(e)) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                    Err(_) => {
                        let _ = ready_tx.send(Err(anyhow!("Error interno al conectar")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(driver.canceller()));
                while let Ok(job) = rx.recv() {
                    let d: &mut dyn Driver = driver.as_mut();
                    // Un pánico en un driver no debe tumbar la aplicación.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(d)));
                }
                // Al cerrarse el canal se libera el driver (y la conexión) en este hilo.
            })?;
        let canceller = ready_rx.await.map_err(|_| anyhow!("La sesión terminó inesperadamente"))??;
        Ok(SessionHandle { tx, canceller, conn_id })
    }

    /// Ejecuta `f` en el hilo de la sesión y devuelve su resultado.
    pub async fn run<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn Driver) -> Result<T> + Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<T>>();
        let job: Job = Box::new(move |d| {
            let _ = tx.send(f(d));
        });
        self.tx.send(job).map_err(|_| anyhow!("La sesión está cerrada"))?;
        match rx.await {
            Ok(r) => r,
            Err(_) => Err(anyhow!("Error interno en la sesión (la operación se interrumpió)")),
        }
    }

    pub fn cancel(&self) {
        (self.canceller)();
    }
}

/// Registro de sesiones abiertas.
#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<SessionHandle>>>,
}

impl Sessions {
    pub fn insert(&self, id: String, h: Arc<SessionHandle>) {
        self.map.lock().insert(id, h);
    }
    pub fn get(&self, id: &str) -> Result<Arc<SessionHandle>> {
        self.map
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("Sesión no encontrada o ya cerrada"))
    }
    pub fn remove(&self, id: &str) -> Option<Arc<SessionHandle>> {
        self.map.lock().remove(id)
    }
    pub fn remove_for_conn(&self, conn_id: &str) -> Vec<Arc<SessionHandle>> {
        let mut m = self.map.lock();
        let ids: Vec<String> = m.iter().filter(|(_, h)| h.conn_id == conn_id).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|k| m.remove(&k)).collect()
    }
}

/// Primera palabra clave de una sentencia, ignorando comentarios y espacios.
pub fn first_keyword(sql: &str) -> String {
    let b = sql.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() || c == b'(' || c == b';' {
            i += 1;
        } else if c == b'-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else if c == b'{' {
            // comentario de Informix { ... }
            while i < b.len() && b[i] != b'}' {
                i += 1;
            }
            i += 1;
        } else {
            break;
        }
    }
    let start = i.min(b.len());
    let mut end = start;
    while end < b.len() && (b[end].is_ascii_alphanumeric() || b[end] == b'_') {
        end += 1;
    }
    sql[start..end].to_ascii_uppercase()
}

/// Indica si un lote modifica datos o estructura (para conexiones de solo lectura).
pub fn is_mutating(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "TRUNCATE" | "CREATE" | "ALTER" | "DROP" | "GRANT" | "REVOKE"
            | "EXEC" | "EXECUTE" | "CALL" | "RENAME" | "LOAD" | "UNLOAD" | "BULK" | "DENY"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keywords() {
        assert_eq!(first_keyword("  -- hola\n /* x */ select 1"), "SELECT");
        assert_eq!(first_keyword("{ comentario } update t set a=1"), "UPDATE");
        assert_eq!(first_keyword("(select 1)"), "SELECT");
        assert!(is_mutating("delete from t"));
        assert!(!is_mutating("with x as (select 1) select * from x"));
    }
}
