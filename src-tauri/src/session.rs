//! Sesiones de base de datos: cada sesión vive en su propio hilo, dueño de la conexión.
//! La interfaz envía trabajos (closures) por un canal y espera la respuesta de forma asíncrona,
//! así una consulta lenta nunca bloquea la ventana ni otras pestañas.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
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
    /// Every foreign key of a schema: `path` is the schema's node in the explorer ([database, schema], or [database]
    /// on engines without schemas), the keys of the tables in its tables folder. Drivers read them in one catalog
    /// query; by default (and as the reference the engine tests compare with) the keys of each table in turn.
    fn schema_foreign_keys(&mut self, path: &[String]) -> Result<Vec<SchemaForeignKey>> {
        per_table_foreign_keys(self, path)
    }
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
    /// Mantener viva (#97): si la sesión lleva `idle` parada y no tiene un resultado abierto, la comprueba como
    /// `health(true)` (y la reconecta si se había cortado); si no, nada (`None`). Solo las sesiones vigiladas.
    fn keep_alive(&mut self, _idle: std::time::Duration) -> Option<Health> {
        None
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

/// The foreign keys of a schema read table by table, through the explorer's "fks" folder of each table of its
/// tables folder (one query per table): the default of `Driver::schema_foreign_keys`.
pub fn per_table_foreign_keys<D: Driver + ?Sized>(d: &mut D, path: &[String]) -> Result<Vec<SchemaForeignKey>> {
    let folders = d.children(path)?;
    let Some(folder) = folders.iter().find(|n| n.kind == "folder" && (n.path.last().map(String::as_str) == Some("tables") || n.name.eq_ignore_ascii_case("tablas") || n.name.eq_ignore_ascii_case("tables"))) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for node in d.children(&folder.path.clone())? {
        let Some(table) = node.obj.clone().filter(|o| o.kind == "table") else { continue };
        if node.path.is_empty() {
            continue;
        }
        let fks = d.children(&[node.path.clone(), vec!["fks".to_string()]].concat())?;
        for fk in fks {
            let Some(target) = fk.obj.as_ref().filter(|_| fk.kind == "key") else { continue };
            let (columns, target_columns) = parse_fk_detail(fk.detail.as_deref().unwrap_or(""));
            let target = ObjectRef { database: if target.database.is_empty() { table.database.clone() } else { target.database.clone() }, ..target.clone() };
            out.push(SchemaForeignKey { name: fk.name, table: table.clone(), columns, target, target_columns });
        }
    }
    Ok(out)
}

/// One column pair of a foreign key, as a catalog query lists them (one row per column, in key order): the key's
/// identity (unique in the query), its name, the two tables and the column of each.
pub struct FkColumn {
    pub key: String,
    pub name: String,
    pub table: ObjectRef,
    pub column: String,
    pub target: ObjectRef,
    pub target_column: String,
}

/// Joins the rows of a schema's foreign keys (`FkColumn`, each key's columns in order) into keys, in the order the
/// keys first appear.
pub fn group_foreign_keys(rows: impl IntoIterator<Item = FkColumn>) -> Vec<SchemaForeignKey> {
    let mut out: Vec<SchemaForeignKey> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for r in rows {
        let i = *at.entry(r.key).or_insert_with(|| {
            out.push(SchemaForeignKey { name: r.name, table: r.table, columns: vec![], target: r.target, target_columns: vec![] });
            out.len() - 1
        });
        out[i].columns.push(r.column);
        out[i].target_columns.push(r.target_column);
    }
    out
}

/// The column lists of an explorer FK node's detail, "a, b → schema.table(x, y)", unquoted (as the interface reads it).
pub fn parse_fk_detail(detail: &str) -> (Vec<String>, Vec<String>) {
    let unquote = |s: &str| {
        let s = s.trim();
        let s = s.strip_prefix(['"', '`', '[']).unwrap_or(s);
        s.strip_suffix(['"', '`', ']']).unwrap_or(s).to_string()
    };
    let list = |s: &str| s.split(',').map(unquote).filter(|c| !c.is_empty()).collect::<Vec<_>>();
    let Some((left, right)) = detail.split_once('→') else { return (vec![], vec![]) };
    let right = right.trim_end();
    let inner = right.strip_suffix(')').and_then(|r| r.rfind('(').map(|i| &r[i + 1..])).unwrap_or("");
    (list(left), list(inner))
}

pub type Canceller = Arc<dyn Fn() + Send + Sync>;
pub type Progress = Arc<dyn Fn() -> Option<String> + Send + Sync>;

type Job = Box<dyn FnOnce(&mut dyn Driver) + Send>;

pub struct SessionHandle {
    tx: mpsc::Sender<Job>,
    canceller: Canceller,
    progress: Progress,
    /// Jobs sent and not answered yet (the session is at work, or has work waiting).
    in_flight: Arc<std::sync::atomic::AtomicUsize>,
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
            in_flight: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
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
        // Counted until the job is done or dropped (a panic in the driver, a closed session).
        struct Pending(Arc<std::sync::atomic::AtomicUsize>);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let pending = Pending(self.in_flight.clone());
        let job: Job = Box::new(move |d| {
            let r = f(d);
            drop(pending);
            let _ = tx.send(r);
        });
        if self.tx.send(job).is_err() {
            bail!("La sesión está cerrada");
        }
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

    /// The session has work running or waiting.
    pub fn busy(&self) -> bool {
        self.in_flight.load(std::sync::atomic::Ordering::SeqCst) > 0
    }

    pub fn progress(&self) -> Option<String> {
        (self.progress)()
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
    fn keywords() {
        assert_eq!(first_keyword("  -- hola\n /* x */ select 1"), "SELECT");
        assert_eq!(first_keyword("{ comentario } update t set a=1"), "UPDATE");
        assert_eq!(first_keyword("(select 1)"), "SELECT");
        assert!(is_mutating("delete from t"));
        assert!(!is_mutating("with x as (select 1) select * from x"));
    }

    #[test]
    fn fk_details_as_the_interface_reads_them() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_fk_detail("parent_id → dbo.celer_p(id)"), (v(&["parent_id"]), v(&["id"])));
        assert_eq!(parse_fk_detail("\"A b\", c → sales.\"T(1)\"(x, \"y\")"), (v(&["A b", "c"]), v(&["x", "y"])));
        assert_eq!(parse_fk_detail("[a], [b] → [s].[t]([k1], [k2])"), (v(&["a", "b"]), v(&["k1", "k2"])));
        assert_eq!(parse_fk_detail("sin flecha"), (vec![], vec![]));
    }
}
