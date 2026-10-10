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
    /// Función que dice desde otro hilo qué hace la sesión cuando no es la consulta en sí (p. ej. leer el resto de un
    /// resultado para conservar la sesión), para mostrarlo mientras se ejecuta.
    fn progress(&self) -> Progress {
        Arc::new(|| None)
    }
    /// Comprobación barata de que la conexión sigue viva (una ida y vuelta con tiempo límite), para antes de usar una
    /// sesión que lleva un rato parada (suspensión del equipo, VPN, cortafuegos). Por defecto no hay nada que mirar.
    fn ping(&mut self) -> Result<()> {
        Ok(())
    }
    /// La conexión quedó inservible (se cortó): la operación siguiente necesita otra.
    fn broken(&self) -> bool {
        false
    }
    /// Lo que la sesión tiene que otra conexión no tendría, según el propio driver ("" si nada o si no lo sabe): la
    /// transacción abierta, las tablas temporales, los SET.
    fn session_state(&self) -> String {
        String::new()
    }
    /// Comprueba la sesión para la interfaz (siempre con `force`; si no, solo si lleva un rato parada). Las sesiones
    /// vigiladas (`guard.rs`) además reconectan si se cortó.
    fn health(&mut self, _force: bool) -> Health {
        match self.ping() {
            Ok(()) => Health { ok: true, ..Health::default() },
            Err(e) => Health { error: e.to_string(), ..Health::default() },
        }
    }
}

pub type Canceller = Arc<dyn Fn() + Send + Sync>;
pub type Progress = Arc<dyn Fn() -> Option<String> + Send + Sync>;

type Job = Box<dyn FnOnce(&mut dyn Driver) + Send>;

pub struct SessionHandle {
    tx: mpsc::Sender<Job>,
    canceller: Canceller,
    progress: Progress,
    pub conn_id: String,
}

impl SessionHandle {
    /// Abre la conexión en un hilo nuevo. `connect` se ejecuta dentro de ese hilo.
    pub async fn open<F>(conn_id: String, connect: F) -> Result<SessionHandle>
    where
        F: FnOnce() -> Result<Box<dyn Driver>> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(Canceller, Progress)>>();
        std::thread::Builder::new()
            .name(format!("celer-session-{conn_id}"))
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let mut driver =
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(connect)) {
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
                let _ = ready_tx.send(Ok((driver.canceller(), driver.progress())));
                while let Ok(job) = rx.recv() {
                    let d: &mut dyn Driver = driver.as_mut();
                    // Un pánico en un driver no debe tumbar la aplicación.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(d)));
                }
                // Al cerrarse el canal se libera el driver (y la conexión) en este hilo.
            })?;
        let (canceller, progress) = ready_rx
            .await
            .map_err(|_| anyhow!("La sesión terminó inesperadamente"))??;
        Ok(SessionHandle {
            tx,
            canceller,
            progress,
            conn_id,
        })
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
        self.tx
            .send(job)
            .map_err(|_| anyhow!("La sesión está cerrada"))?;
        match rx.await {
            Ok(r) => r,
            Err(_) => Err(anyhow!(
                "Error interno en la sesión (la operación se interrumpió)"
            )),
        }
    }

    pub fn cancel(&self) {
        (self.canceller)();
    }

    pub fn canceller(&self) -> Canceller {
        self.canceller.clone()
    }

    pub fn progress(&self) -> Option<String> {
        (self.progress)()
    }
}

/// Ajustes › Ejecución › tiempo máximo: cancels the running statement through the driver's own canceller (the same
/// path as the «Detener» button, so it works alike on every engine) once `secs` have passed, unless `stop` comes first.
pub struct Deadline {
    stop: mpsc::Sender<()>,
    fired: Arc<std::sync::atomic::AtomicBool>,
}

impl Deadline {
    pub fn start(cancel: Canceller, secs: u64) -> Deadline {
        let (stop, rx) = mpsc::channel::<()>();
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = fired.clone();
        let _ = std::thread::Builder::new().name("celer-deadline".into()).spawn(move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(std::time::Duration::from_secs(secs)) {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                cancel();
            }
        });
        Deadline { stop, fired }
    }

    /// The statement ended: no cancel from now on. True when the deadline had already cancelled it.
    pub fn stop(self) -> bool {
        let _ = self.stop.send(());
        self.fired.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// The error of a statement stopped by the deadline (the driver's own "cancelled" text says less).
pub fn timeout_error(secs: u64) -> String {
    format!("La consulta superó el tiempo máximo de {secs} s y se ha cancelado (Ajustes › Ejecución › Tiempo máximo de una consulta).")
}

/// A statement that ended anyway once the deadline asked to cancel it (MySQL's SLEEP returns 1 when interrupted).
pub fn timeout_note(secs: u64) -> String {
    format!("Se alcanzó el tiempo máximo de {secs} s: se pidió cancelar la consulta y el servidor la dio por terminada.")
}

/// Runs `f` (a statement) under a deadline of `secs` seconds (0: none) and words the outcome of a cancelled one.
pub fn with_deadline(cancel: Canceller, secs: u64, f: impl FnOnce() -> Result<crate::model::ExecOutput>) -> std::result::Result<crate::model::ExecOutput, String> {
    if secs == 0 {
        return f().map_err(|e| e.to_string());
    }
    let deadline = Deadline::start(cancel, secs);
    let r = f();
    match (deadline.stop(), r) {
        // A lost session (the bridge reopened the connection) keeps its own note: it says what was rolled back.
        (true, Err(e)) if e.to_string().starts_with("SESSION_LOST:") => Err(format!("{e}\n\n{}", timeout_error(secs))),
        (true, Err(_)) => Err(timeout_error(secs)),
        (true, Ok(mut out)) => {
            out.messages.push(timeout_note(secs));
            Ok(out)
        }
        (false, r) => r.map_err(|e| e.to_string()),
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
        let ids: Vec<String> = m
            .iter()
            .filter(|(_, h)| h.conn_id == conn_id)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter().filter_map(|k| m.remove(&k)).collect()
    }
}

/// Keepalive de TCP para las conexiones que Celer abre por su cuenta: a los 60 s parada, el sistema empieza a
/// comprobarla cada 15 s. Así un corte (suspensión, VPN) se nota antes y los cortafuegos no la dan por muerta.
pub fn tcp_keepalive() -> socket2::TcpKeepalive {
    socket2::TcpKeepalive::new().with_time(std::time::Duration::from_secs(60)).with_interval(std::time::Duration::from_secs(15))
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

/// A fetch with no open result: something else used the session and closed it (a fetch never ends one in silence).
pub const CURSOR_CLOSED: &str =
    "El resultado ya no está abierto (otra operación usó la sesión): vuelve a ejecutar la consulta para leer el resto.";

/// Message for a script whose statements wait behind a result left open (PostgreSQL, MySQL, SQLite, Informix): they run
/// only when that result is read to the end.
pub fn pending_note(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("Queda 1 sentencia del script sin ejecutar: se ejecuta al leer este resultado hasta el final; si ejecutas otra cosa antes, se descarta.".into()),
        n => Some(format!("Quedan {n} sentencias del script sin ejecutar: se ejecutan al leer este resultado hasta el final; si ejecutas otra cosa antes, se descartan.")),
    }
}

/// Message for statements of the previous script dropped when its open result was closed before its end.
pub fn discarded_note(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("No se ejecutó 1 sentencia del script anterior: su resultado se cerró antes de leerlo hasta el final.".into()),
        n => Some(format!("No se ejecutaron {n} sentencias del script anterior: su resultado se cerró antes de leerlo hasta el final.")),
    }
}

/// Indica si un lote modifica datos o estructura (para conexiones de solo lectura).
pub fn is_mutating(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "INSERT"
            | "UPDATE"
            | "DELETE"
            | "MERGE"
            | "TRUNCATE"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "GRANT"
            | "REVOKE"
            | "EXEC"
            | "EXECUTE"
            | "CALL"
            | "RENAME"
            | "LOAD"
            | "UNLOAD"
            | "BULK"
            | "DENY"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadline_cancels_only_after_its_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let cancel: Canceller = Arc::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        // Ends in time: never cancelled.
        let r = with_deadline(cancel.clone(), 5, || Ok(crate::model::ExecOutput::default()));
        assert!(r.is_ok());
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // Runs past it: cancelled once, and the error says why.
        let r = with_deadline(cancel.clone(), 1, || {
            std::thread::sleep(std::time::Duration::from_millis(1300));
            Err(anyhow!("Consulta cancelada"))
        });
        assert_eq!(r.unwrap_err(), timeout_error(1));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Ended anyway after the cancel: the output stays, with a note.
        let r = with_deadline(cancel, 1, || {
            std::thread::sleep(std::time::Duration::from_millis(1300));
            Ok(crate::model::ExecOutput::default())
        });
        assert_eq!(r.unwrap().messages, vec![timeout_note(1)]);
    }

    #[test]
    fn keywords() {
        assert_eq!(first_keyword("  -- hola\n /* x */ select 1"), "SELECT");
        assert_eq!(first_keyword("{ comentario } update t set a=1"), "UPDATE");
        assert_eq!(first_keyword("(select 1)"), "SELECT");
        assert!(is_mutating("delete from t"));
        assert!(!is_mutating("with x as (select 1) select * from x"));
    }
}
