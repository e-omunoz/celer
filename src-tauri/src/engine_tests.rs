//! Integration tests against real SQL Server and Informix servers (run in CI by .github/workflows/engines.yml).
//!   CELER_MSSQL_TEST="host=localhost port=1433 user=sa password=…"
//!   CELER_INFORMIX_TEST="host=localhost port=9089 user=informix password=in4mix database=celer" + CELER_IBM_LIB
//!   CELER_INFORMIX_JDBC_TEST="host=localhost port=9088 user=informix password=in4mix database=celer server=informix"
//!     + CELER_JAVA (java executable) + CELER_JDBC_JARS (the driver jar and bson, as a PATH-style list)
//! Informix runs the same suite over DRDA (IBM CLI) and over JDBC (Celer's bridge), and `informix_speed` reads
//! 200,000 rows through both.
//! Besides the driver itself (paging, types, transactions, cancel, metadata, startup script, plans), they run the
//! exact SQL the interface writes for each engine, produced by dev/engine-sql.ts from the tables as the driver
//! sees them: table filters, saved edits, generated scripts, UPSERT/MERGE, the FK lookup, the activity monitor
//! and the schema and data synchronization scripts.
//! The `library_*` tests run one saved library script (dev/library-sql.ts) on every engine: PostgreSQL
//! (CELER_PG_TEST), MySQL and MariaDB (CELER_MYSQL_TEST), SQL Server, Informix over DRDA and JDBC, SQLite in memory
//! and generic ODBC (CELER_ODBC_TEST, an ODBC connection string).

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;

use crate::model::{Cell, ColKind, ConnConfig, DbKind, ObjectRef, ResultSet};
use crate::session::Driver;

fn spec(var: &str) -> Option<Vec<(String, String)>> {
    let s = std::env::var(var).ok()?;
    Some(s.split_whitespace().filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

fn get(spec: &[(String, String)], key: &str) -> String {
    spec.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default()
}

fn txt(c: &Cell) -> String {
    match c {
        Cell::Null => "NULL".into(),
        Cell::Bool(b) => b.to_string(),
        Cell::Int(i) => i.to_string(),
        Cell::Num(f) => f.to_string(),
        Cell::Text(s) => s.clone(),
    }
}

/// Every row of the first result (paging through the cursor).
fn all_rows(d: &mut dyn Driver, sql: &str) -> (Vec<crate::model::ColumnInfo>, Vec<Vec<Cell>>) {
    let out = d.execute(sql, 5000).unwrap_or_else(|e| panic!("{sql}\n→ {e}"));
    let first = out.results.into_iter().find(|r| !r.columns.is_empty()).unwrap_or_else(|| panic!("{sql}\n→ no result set"));
    let mut rows = first.rows;
    let mut more = first.has_more;
    while more {
        let f = d.fetch(5000).unwrap();
        rows.extend(f.rows);
        more = f.has_more;
    }
    (first.columns, rows)
}

fn scalar(d: &mut dyn Driver, sql: &str) -> String {
    let (_, rows) = all_rows(d, sql);
    txt(&rows[0][0])
}

/// A session closed with its manual transaction still open (a console closed, Celer quitting) never commits it: the
/// other session `d` still counts the rows `change` touched. Rollback and Cancelar in the interface end the same way.
pub(crate) fn assert_close_never_commits(d: &mut dyn Driver, mut other: Box<dyn Driver>, change: &str, count: &str) {
    let before = scalar(d, count);
    other.set_autocommit(false).unwrap();
    let out = other.execute(change, 10).unwrap_or_else(|e| panic!("{change}\n→ {e}"));
    assert!(out.in_transaction, "manual mode: {change} leaves a transaction open");
    drop(other);
    // The server may still hold the rows' locks for a moment (Informix does not wait for them: error -244).
    let mut last = String::new();
    for _ in 0..50 {
        match d.execute(count, 10) {
            Ok(out) => {
                let after = txt(&out.results[0].rows[0][0]);
                assert_eq!(after, before, "closing a session with an open transaction must not commit it");
                return;
            }
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("{count}\n→ {last}");
}

#[derive(Deserialize)]
struct Statement {
    name: String,
    sql: String,
    rows: Option<usize>,
}

/// The statements the interface would write (dev/engine-sql.ts), for this shape of the test tables.
fn generated(shape: serde_json::Value) -> Vec<Statement> {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/engine-sql.ts");
    let node = std::env::var("CELER_NODE").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .args(["--experimental-strip-types", "--no-warnings", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node (CELER_NODE) para dev/engine-sql.ts");
    child.stdin.take().unwrap().write_all(shape.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "engine-sql.ts: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

/// Runs the generated statements like the interface does (changes in one transaction) and checks their rows.
fn run_generated(d: &mut dyn Driver, statements: &[Statement]) {
    let mut failures = Vec::new();
    for st in statements {
        if st.sql.trim().is_empty() {
            continue;
        }
        let result = if st.name == "table changes" {
            // saveTable: manual mode, the whole batch, commit (rollback on error).
            d.close_cursor().ok();
            d.set_autocommit(false).unwrap();
            let r = d.execute(&st.sql, 1).and_then(|o| d.commit().map(|_| o));
            if r.is_err() {
                d.rollback().ok();
            }
            d.set_autocommit(true).unwrap();
            r.map(|_| None)
        } else {
            d.execute(&st.sql, 10_000).map(|out| {
                let rs = out.results.into_iter().find(|r| !r.columns.is_empty());
                rs.map(|r| {
                    let mut n = r.rows.len();
                    let mut more = r.has_more;
                    while more {
                        let f = d.fetch(10_000).unwrap();
                        n += f.rows.len();
                        more = f.has_more;
                    }
                    n
                })
            })
        };
        match (result, st.rows) {
            (Err(e), _) => failures.push(format!("✗ {}: {e}\n    {}", st.name, st.sql.replace('\n', "\n    "))),
            (Ok(Some(n)), Some(want)) if n != want => failures.push(format!("✗ {}: {n} filas, se esperaban {want}\n    {}", st.name, st.sql)),
            (Ok(None), Some(want)) => failures.push(format!("✗ {}: sin resultado, se esperaban {want} filas\n    {}", st.name, st.sql)),
            _ => println!("✓ {}", st.name),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// The seed table as the driver reports it (columns, quoting, rows), for dev/engine-sql.ts.
fn table_shape(d: &mut dyn Driver, obj: &ObjectRef) -> serde_json::Value {
    let columns = d.table_columns(obj).unwrap();
    let quoted: Vec<String> = columns.iter().map(|c| d.quote_ident(&c.name)).collect();
    let qualified = d.qualified_name(obj);
    let (_, rows) = all_rows(d, &format!("SELECT * FROM {qualified} ORDER BY 1"));
    json!({ "qualified": qualified, "columns": columns, "quoted": quoted, "rows": rows })
}

fn result_set(d: &mut dyn Driver, sql: &str) -> ResultSet {
    let (columns, rows) = all_rows(d, sql);
    ResultSet { columns, rows, has_more: false, rows_affected: None }
}

/// A test that hangs fails instead: after `secs` it prints the JDBC bridge's threads (if it runs) and ends the process.
struct Watchdog(Option<std::sync::mpsc::Sender<()>>);

fn watchdog(what: &'static str, secs: u64) -> Watchdog {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(Duration::from_secs(secs)) {
            eprintln!("\n✗ {what}: sin respuesta en {secs} s");
            dump_bridge_threads();
            std::process::abort();
        }
    });
    Watchdog(Some(tx))
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

/// `jcmd <pid> Thread.print` on the bridge's JVM, with the JDK of CELER_JAVA.
fn dump_bridge_threads() {
    let (Some(pid), Ok(java)) = (crate::jdbc::bridge_pid(), std::env::var("CELER_JAVA")) else { return };
    let jcmd = std::path::Path::new(&java).with_file_name(if cfg!(windows) { "jcmd.exe" } else { "jcmd" });
    eprintln!("Hilos de la JVM del puente ({pid}):");
    let _ = Command::new(jcmd).args([pid.to_string().as_str(), "Thread.print"]).status();
}

fn assert_cancel(d: &mut dyn Driver, slow_sql: &str) {
    let _guard = watchdog("cancelar una consulta", 120);
    let cancel = d.canceller();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        cancel();
    });
    let t0 = Instant::now();
    let r = d.execute(slow_sql, 10);
    t.join().unwrap();
    println!("cancelar: la consulta paró {:?} después de cancelarla → {}", t0.elapsed().saturating_sub(Duration::from_millis(800)), r.as_ref().err().map(|e| e.to_string()).unwrap_or_default().replace('\n', " · "));
    assert!(r.is_err(), "la consulta lenta debía cancelarse");
    assert!(t0.elapsed() < Duration::from_secs(15), "cancelar tardó {:?}", t0.elapsed());
    // The session is usable again.
    assert_eq!(scalar(d, "SELECT 1 FROM (SELECT 1 AS x) q").trim(), "1");
}

/// Ajustes › Ejecución › tiempo máximo: the core's deadline (session::with_deadline) stops a slow statement through the
/// driver's canceller, says so in its error, and the session answers again.
fn assert_timeout(d: &mut dyn Driver, slow_sql: &str) {
    let _guard = watchdog("tiempo máximo de una consulta", 120);
    let t0 = Instant::now();
    let cancel = d.canceller();
    let r = crate::session::with_deadline(cancel, 2, || d.execute(slow_sql, 10));
    println!("tiempo máximo: paró a los {:?} → {}", t0.elapsed(), r.as_ref().err().cloned().unwrap_or_default());
    assert_eq!(r.err().as_deref(), Some(crate::session::timeout_error(2).as_str()), "la consulta lenta debía pararse por tiempo");
    assert!(t0.elapsed() >= Duration::from_secs(2), "paró antes de tiempo: {:?}", t0.elapsed());
    assert!(t0.elapsed() < Duration::from_secs(17), "el tiempo máximo tardó {:?}", t0.elapsed());
    assert_eq!(scalar(d, "SELECT 1 FROM (SELECT 1 AS x) q").trim(), "1");
}

// ───────────────────────────────────────────────────────────────── SQL Server

fn mssql_cfg(database: &str) -> Option<ConnConfig> {
    let s = spec("CELER_MSSQL_TEST")?;
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Mssql;
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = database.into();
    cfg.trust_cert = true;
    Some(cfg)
}

fn mssql(database: &str) -> Option<crate::mssql::MssqlDriver> {
    Some(crate::mssql::MssqlDriver::connect(mssql_cfg(database)?).expect("conexión SQL Server"))
}

const MSSQL_SEED: &str = "IF OBJECT_ID('dbo.celer_t') IS NOT NULL DROP TABLE dbo.celer_t;
IF OBJECT_ID('dbo.celer_p') IS NOT NULL DROP TABLE dbo.celer_p;
CREATE TABLE dbo.celer_p (id int PRIMARY KEY, nombre nvarchar(50) NOT NULL);
INSERT INTO dbo.celer_p VALUES (1, N'Uno'), (2, N'Dos');
CREATE TABLE dbo.celer_t (id int PRIMARY KEY, nombre nvarchar(100) NOT NULL, activo bit NULL, alta date NULL,
  importe decimal(12,2) NULL, notas nvarchar(max) NULL, parent_id int NULL REFERENCES dbo.celer_p(id), momento datetime NULL);
INSERT INTO dbo.celer_t VALUES
  (1, N'Ana Ruiz', 1, '2024-01-15', 120.50, N'nota 50% off', 1, '2024-01-15 10:30:00.003'),
  (2, N'Luis Peña', 0, '2024-02-20', 0.00, NULL, 2, NULL),
  (3, N'Zoë Martín', 1, NULL, -5.25, N'[corchetes]', NULL, NULL),
  (4, N'O''Neil', NULL, '2023-12-31', 99999.99, N'', 1, NULL);";

/// Generic ODBC (the driver manager of the system): a session closed with its manual transaction open is rolled back
/// first, never committed. CELER_ODBC_TEST is a connection string to a scratch database (for example the PostgreSQL
/// ODBC driver on the WSL engine: "DRIVER={PostgreSQL Unicode};SERVER=localhost;PORT=15432;DATABASE=celer;UID=celer;PWD=celer").
#[test]
fn odbc_close_never_commits() {
    let Ok(conn_str) = std::env::var("CELER_ODBC_TEST") else { return };
    let open = || {
        let cfg = ConnConfig { kind: DbKind::Odbc, odbc_conn_str: conn_str.clone(), ..Default::default() };
        Box::new(crate::odbc_driver::OdbcDriver::connect(cfg, crate::odbc::system_manager().to_string()).unwrap()) as Box<dyn Driver>
    };
    let mut d = open();
    let d: &mut dyn Driver = d.as_mut();
    let _ = d.execute("DROP TABLE odbc_tx_close", 10);
    d.execute("CREATE TABLE odbc_tx_close (id INT)", 10).unwrap();
    d.execute("INSERT INTO odbc_tx_close VALUES (1)", 10).unwrap();
    d.execute("INSERT INTO odbc_tx_close VALUES (2)", 10).unwrap();
    assert_close_never_commits(d, open(), "DELETE FROM odbc_tx_close WHERE id > 1", "SELECT COUNT(*) FROM odbc_tx_close");
    assert_close_never_commits(d, open(), "INSERT INTO odbc_tx_close VALUES (3)", "SELECT COUNT(*) FROM odbc_tx_close");
    d.execute("DROP TABLE odbc_tx_close", 10).unwrap();
}

#[test]
fn mssql_engine() {
    let Some(mut master) = mssql("master") else { return };
    master.execute("IF DB_ID('celer_test') IS NULL CREATE DATABASE celer_test", 10).unwrap();
    drop(master);
    let mut d = mssql("celer_test").unwrap();
    let d: &mut dyn Driver = &mut d;
    assert_eq!(d.current_database().unwrap(), "celer_test");
    assert!(d.server_info().unwrap().contains("SQL Server"), "{}", d.server_info().unwrap());
    d.execute(MSSQL_SEED, 10).unwrap();

    // Types as the grid gets them.
    let (cols, rows) = all_rows(d, "SELECT * FROM dbo.celer_t ORDER BY id");
    assert_eq!(rows.len(), 4);
    let kinds: Vec<ColKind> = cols.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, vec![ColKind::Number, ColKind::Text, ColKind::Bool, ColKind::Date, ColKind::Number, ColKind::Text, ColKind::Number, ColKind::Date]);
    assert!(matches!(rows[0][2], Cell::Bool(true)));
    assert_eq!(txt(&rows[0][3]), "2024-01-15");
    assert_eq!(txt(&rows[0][4]), "120.50");
    assert_eq!(txt(&rows[2][1]), "Zoë Martín");

    // Metadata: databases, schemas, tables, the FK as the interface parses it, columns, DDL, completion.
    let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(d.children(&[]).unwrap().iter().any(|n| n.name == "celer_test"));
    assert!(d.databases().unwrap().contains(&"celer_test".to_string()));
    let schemas = d.children(&p(&["celer_test"])).unwrap();
    assert!(schemas.iter().any(|n| n.name == "dbo" && n.kind == "schema"), "{:?}", schemas.iter().map(|n| (&n.name, &n.kind)).collect::<Vec<_>>());
    let folders = d.children(&p(&["celer_test", "dbo"])).unwrap();
    let tables_folder = folders.iter().find(|n| n.kind == "folder" && n.path.last().map(String::as_str) == Some("tables")).expect("carpeta de tablas");
    let tables = d.children(&tables_folder.path).unwrap();
    let t_node = tables.iter().find(|n| n.name == "celer_t").expect("celer_t");
    let obj = t_node.obj.clone().unwrap();
    assert_eq!(obj.kind, "table");
    let fks = d.children(&[t_node.path.clone(), vec!["fks".into()]].concat()).unwrap();
    let fk = fks.iter().find(|n| n.kind == "key").expect("la clave foránea");
    let fk_re = regex_lite(fk.detail.as_deref().unwrap_or(""));
    assert!(fk_re, "detalle de FK con otro formato: {:?}", fk.detail);
    assert_eq!(fk.obj.as_ref().unwrap().name, "celer_p");
    let columns = d.table_columns(&obj).unwrap();
    assert!(columns[0].primary_key && !columns[0].nullable);
    assert!(d.ddl(&obj).unwrap().to_uppercase().contains("CREATE TABLE"));
    assert!(d.completion("celer_test").unwrap().tables.iter().any(|t| t.name == "celer_t"));
    // Key and index columns joined in the driver (no FOR XML PATH): order, brackets and DESC as SQL Server has them.
    assert!(!d.server_info().unwrap().contains("Synapse"));
    d.execute("CREATE INDEX ix_celer_t_alta ON dbo.celer_t (alta DESC, nombre); CREATE UNIQUE INDEX [ux_celer_t_mom]]] ON dbo.celer_t (momento, id)", 10).unwrap();
    let ddl = d.ddl(&obj).unwrap();
    assert!(ddl.contains("    [id] int NOT NULL,"), "{ddl}");
    assert!(ddl.contains("] PRIMARY KEY CLUSTERED ([id])"), "{ddl}");
    assert!(ddl.contains(" FOREIGN KEY ([parent_id]) REFERENCES [dbo].[celer_p] ([id])"), "{ddl}");
    assert!(ddl.contains("\nCREATE NONCLUSTERED INDEX [ix_celer_t_alta] ON [celer_test].[dbo].[celer_t] ([alta] DESC, [nombre]);"), "{ddl}");
    assert!(ddl.contains("\nCREATE UNIQUE NONCLUSTERED INDEX [ux_celer_t_mom]]] ON [celer_test].[dbo].[celer_t] ([momento], [id]);"), "{ddl}");
    let indexes = d.children(&[t_node.path.clone(), vec!["indexes".into()]].concat()).unwrap();
    let ix = indexes.iter().find(|n| n.name == "ix_celer_t_alta").expect("ix_celer_t_alta");
    assert_eq!(ix.detail.as_deref(), Some("(alta, nombre) · nonclustered"));
    assert!(indexes.iter().any(|n| n.detail.as_deref() == Some("(id) · PK · clustered")), "{:?}", indexes.iter().map(|n| &n.detail).collect::<Vec<_>>());
    assert_eq!(fk.detail.as_deref(), Some("parent_id → dbo.celer_p(id)"));
    // Identity seed, CHECK, PERSISTED, INCLUDE, filters and other kinds of index, as SQL Server has them.
    d.execute("IF OBJECT_ID('dbo.ddl_f') IS NOT NULL DROP TABLE dbo.ddl_f;
               CREATE TABLE dbo.ddl_f (id int IDENTITY(1000,5) PRIMARY KEY, q int CONSTRAINT ck_ddl_f_q CHECK (q > 0), s nvarchar(10), doble AS (q * 2) PERSISTED, doc xml, g geometry);
               CREATE INDEX ix_ddl_f ON dbo.ddl_f (q) INCLUDE (s) WHERE q > 10;
               CREATE PRIMARY XML INDEX px_ddl_f ON dbo.ddl_f (doc);
               CREATE XML INDEX sx_ddl_f ON dbo.ddl_f (doc) USING XML INDEX px_ddl_f FOR PATH;
               CREATE SPATIAL INDEX gx_ddl_f ON dbo.ddl_f (g) WITH (BOUNDING_BOX = (0, 0, 100, 100));", 10).unwrap();
    let f_obj = ObjectRef { database: "celer_test".into(), schema: "dbo".into(), name: "ddl_f".into(), kind: "table".into() };
    let ddl = d.ddl(&f_obj).unwrap();
    for want in [
        "[id] int IDENTITY(1000,5) NOT NULL",
        "[doble] AS ([q]*(2)) PERSISTED",
        "CONSTRAINT [ck_ddl_f_q] CHECK ([q]>(0))",
        "CREATE NONCLUSTERED INDEX [ix_ddl_f] ON [celer_test].[dbo].[ddl_f] ([q]) INCLUDE ([s]) WHERE ([q]>(10));",
        "CREATE PRIMARY XML INDEX [px_ddl_f] ON [celer_test].[dbo].[ddl_f] ([doc]);",
        "CREATE XML INDEX [sx_ddl_f] ON [celer_test].[dbo].[ddl_f] ([doc]) USING XML INDEX [px_ddl_f] FOR PATH;",
        "CREATE SPATIAL INDEX [gx_ddl_f] ON [celer_test].[dbo].[ddl_f] ([g]) USING GEOMETRY_",
        " WITH (BOUNDING_BOX = (0, 0, 100, 100));",
    ] {
        assert!(ddl.contains(want), "{want}\n{ddl}");
    }
    d.execute("IF OBJECT_ID('dbo.ddl_c') IS NOT NULL DROP TABLE dbo.ddl_c; CREATE TABLE dbo.ddl_c (a int, b int); CREATE NONCLUSTERED COLUMNSTORE INDEX cs_ddl_c ON dbo.ddl_c (b, a)", 10).unwrap();
    let c_ddl = d.ddl(&ObjectRef { database: "celer_test".into(), schema: "dbo".into(), name: "ddl_c".into(), kind: "table".into() }).unwrap();
    assert!(c_ddl.contains("CREATE NONCLUSTERED COLUMNSTORE INDEX [cs_ddl_c] ON [celer_test].[dbo].[ddl_c] ("), "{c_ddl}");
    // It runs back as it is (under another name, GO-free since every index is its own statement).
    let copy = ddl.replace("ddl_f", "ddl_f2").replace("[PK__", "[PK2__");
    d.execute("IF OBJECT_ID('dbo.ddl_f2') IS NOT NULL DROP TABLE dbo.ddl_f2", 10).unwrap();
    d.execute(&copy, 10).unwrap_or_else(|e| panic!("{e}\n{copy}"));

    // Paging through a cursor, closing it half way.
    d.execute("IF OBJECT_ID('dbo.many') IS NOT NULL DROP TABLE dbo.many; SELECT TOP 3000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n INTO dbo.many FROM sys.all_objects a CROSS JOIN sys.all_objects b", 10).unwrap();
    let out = d.execute("SELECT n FROM dbo.many ORDER BY n", 1000).unwrap();
    assert!(out.results[0].has_more && out.results[0].rows.len() == 1000);
    let f = d.fetch(1500).unwrap();
    assert_eq!(f.rows.len(), 1500);
    d.close_cursor().unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.many"), "3000");

    // Transactions (manual mode) and their state.
    d.set_autocommit(false).unwrap();
    let out = d.execute("UPDATE dbo.many SET n = n WHERE n = 1", 10).unwrap();
    assert!(out.in_transaction);
    assert!(!d.rollback().unwrap());
    d.execute("DELETE FROM dbo.many WHERE n > 2990", 10).unwrap();
    d.commit().unwrap();
    d.set_autocommit(true).unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.many"), "2990");
    assert_close_never_commits(d, Box::new(mssql("celer_test").unwrap()), "DELETE FROM dbo.many WHERE n > 2980", "SELECT COUNT(*) FROM dbo.many");

    // Errors with SQL Server's own message.
    let err = d.execute("SELECT nope FROM dbo.celer_t", 10).unwrap_err().to_string();
    assert!(err.contains("Msg 207"), "{err}");

    // PRINT and RAISERROR below severity 11 reach the Output area (the patched tiberius, #67); 11 and above fail.
    let out = d.execute("PRINT 'hola'; SELECT 1 AS uno", 10).unwrap();
    assert!(out.messages.iter().any(|m| m == "hola"), "{:?}", out.messages);
    assert_eq!(out.results.len(), 1);
    assert_eq!(txt(&out.results[0].rows[0][0]), "1");
    let out = d.execute("PRINT 'solo un mensaje'", 10).unwrap();
    assert!(out.results.is_empty() && out.messages.iter().any(|m| m == "solo un mensaje"), "{:?}", out.messages);
    d.execute("CREATE OR ALTER PROCEDURE dbo.celer_progreso AS BEGIN RAISERROR('progreso', 0, 1) WITH NOWAIT; SELECT 2 AS dos; PRINT 'fin del procedimiento'; END", 10).unwrap();
    let out = d.execute("EXEC dbo.celer_progreso", 10).unwrap();
    assert!(out.messages.iter().any(|m| m == "Msg 50000, nivel 0: progreso"), "{:?}", out.messages);
    assert!(out.messages.iter().any(|m| m == "fin del procedimiento"), "{:?}", out.messages);
    assert_eq!(txt(&out.results[0].rows[0][0]), "2");
    let err = d.execute("RAISERROR('fallo', 16, 1)", 10).unwrap_err().to_string();
    assert!(err.contains("fallo") && err.contains("Msg 50000"), "{err}");
    // USE's "Changed database context" is left out: it only echoes the USE.
    let out = d.execute("USE celer_test; SELECT MAX(alta) FROM dbo.celer_t", 10).unwrap();
    assert!(!out.messages.iter().any(|m| m.contains("5701") || m.contains("database context")), "{:?}", out.messages);
    // A single INSERT goes as DML (a row count): a trigger's PRINT is still told.
    d.execute("IF OBJECT_ID('dbo.celer_msg') IS NOT NULL DROP TABLE dbo.celer_msg; CREATE TABLE dbo.celer_msg (a int)", 10).unwrap();
    d.execute("CREATE TRIGGER dbo.celer_msg_ins ON dbo.celer_msg AFTER INSERT AS PRINT 'fila insertada'", 10).unwrap();
    let out = d.execute("INSERT INTO dbo.celer_msg VALUES (1)", 10).unwrap();
    assert!(out.messages.iter().any(|m| m == "fila insertada"), "{:?}", out.messages);
    assert_eq!(out.results[0].rows_affected, Some(1));
    // A PRINT after a result read in pages comes with the page that reaches it.
    let out = d.execute("SELECT TOP 50 a.object_id FROM sys.all_objects a; PRINT 'tras el resultado'", 10).unwrap();
    assert!(out.results[0].has_more);
    let mut later = Vec::new();
    loop {
        let f = d.fetch(10).unwrap();
        later.extend(f.messages);
        if !f.has_more {
            break;
        }
    }
    assert!(later.iter().any(|m| m == "tras el resultado"), "{later:?}");
    d.execute("DROP TABLE dbo.celer_msg; DROP PROCEDURE dbo.celer_progreso", 10).unwrap();

    // Dates: what the grid shows must be accepted back as it is (datetime is .003 precision).
    d.execute("IF OBJECT_ID('dbo.dt') IS NOT NULL DROP TABLE dbo.dt; CREATE TABLE dbo.dt (id int PRIMARY KEY, a datetime, b datetime2(7), c time(7), e smalldatetime, f datetimeoffset(7), g date);
               INSERT INTO dbo.dt VALUES (1, '2024-03-15 10:20:30.003', '2024-03-15 10:20:30.1234567', '08:30:00.5', '2024-03-15 10:20', '2024-03-15 10:20:30.25 +02:00', '2024-03-15'),
                                         (2, '2024-03-15 23:59:59.997', '2024-03-15 00:00:00', '00:00:00', '2024-03-15 00:00', '2024-03-15 00:00:00 -05:00', '2024-12-31')", 10).unwrap();
    let (_, dt) = all_rows(d, "SELECT a, b, c, e, f, g FROM dbo.dt ORDER BY id");
    assert_eq!(txt(&dt[0][0]), "2024-03-15 10:20:30.003");
    assert_eq!(txt(&dt[0][1]), "2024-03-15 10:20:30.1234567");
    assert_eq!(txt(&dt[0][2]), "08:30:00.5");
    for (i, col) in ["a", "b", "c", "e", "f", "g"].iter().enumerate() {
        for row in &dt {
            let shown = txt(&row[i]);
            let n = scalar(d, &format!("SELECT COUNT(*) FROM dbo.dt WHERE {col} = N'{shown}'"));
            assert_eq!(n, "1", "{col} = '{shown}' no encuentra su fila");
            d.execute(&format!("UPDATE dbo.dt SET {col} = N'{shown}' WHERE {col} = N'{shown}'"), 10).unwrap_or_else(|e| panic!("{col} = '{shown}': {e}"));
        }
    }

    // money / smallmoney: exact, with their 4 decimals.
    let (_, m) = all_rows(d, "SELECT CAST(123456789012.3456 AS money), CAST(12.5 AS money), CAST(-214748.3648 AS smallmoney), CAST(NULL AS money)");
    assert_eq!(m[0].iter().map(txt).collect::<Vec<_>>(), vec!["123456789012.3456", "12.5000", "-214748.3648", "NULL"]);

    // Unicode through N'' literals (as the interface writes them).
    d.execute("IF OBJECT_ID('dbo.uni') IS NOT NULL DROP TABLE dbo.uni; CREATE TABLE dbo.uni (id int PRIMARY KEY, s nvarchar(50), v varchar(50))", 10).unwrap();
    d.execute("INSERT INTO dbo.uni VALUES (1, N'😀 李 ñ ж', N'ñandú')", 10).unwrap();
    assert_eq!(scalar(d, "SELECT s FROM dbo.uni"), "😀 李 ñ ж");
    assert_eq!(scalar(d, "SELECT v FROM dbo.uni"), "ñandú");

    // Execution plans: SHOWPLAN_XML on a SELECT and on an UPDATE (which then must not run), and off again.
    d.execute("SET SHOWPLAN_XML ON", 1).unwrap();
    for (name, sql) in [("select", "SELECT t.nombre, p.nombre FROM dbo.celer_t t JOIN dbo.celer_p p ON p.id = t.parent_id WHERE t.importe > 10"), ("update", "UPDATE dbo.celer_t SET importe = importe + 1 WHERE id = 1")] {
        let out = d.execute(sql, 10).unwrap();
        let xml = out.results.iter().find(|r| !r.columns.is_empty()).map(|r| txt(&r.rows[0][0])).unwrap_or_default();
        assert!(xml.contains("<ShowPlanXML") && xml.contains("<QueryPlan"), "{name}: {xml:.200}");
        let _ = std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../target-showplan-").to_string() + name + ".xml", &xml);
    }
    d.execute("SET SHOWPLAN_XML OFF", 1).unwrap();
    assert_eq!(scalar(d, "SELECT importe FROM dbo.celer_t WHERE id = 1"), "120.50", "el UPDATE bajo SHOWPLAN no debe ejecutarse");
    let out = d.execute("UPDATE dbo.celer_t SET importe = importe WHERE id = 1", 10).unwrap();
    assert_eq!(out.results.iter().find_map(|r| r.rows_affected), Some(1));
    // A DML batch with a later SELECT and no ';' keeps the SELECT's grid.
    let out = d.execute("UPDATE dbo.many SET n = n WHERE n = 1\nSELECT n FROM dbo.many WHERE n <= 5", 100).unwrap();
    assert!(out.results.iter().any(|r| r.columns.len() == 1 && r.rows.len() == 5), "{:?}", out.results);
    // GO batches, as SSMS writes them: CREATE VIEW must start its own batch; GO n repeats one.
    d.execute("IF OBJECT_ID('dbo.go_v') IS NOT NULL DROP VIEW dbo.go_v\nGO\nIF OBJECT_ID('dbo.go_a') IS NOT NULL DROP TABLE dbo.go_a\nCREATE TABLE dbo.go_a (id int IDENTITY)\nGO\nCREATE VIEW dbo.go_v AS SELECT id FROM dbo.go_a\nGO\nINSERT dbo.go_a DEFAULT VALUES\nGO 3\n", 10).unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.go_v"), "3");
    let err = d.execute("SELECT 1\nGO\nSELECT nope FROM dbo.go_a\nGO\nINSERT dbo.go_a DEFAULT VALUES", 10).unwrap_err().to_string();
    assert!(err.starts_with("Lote 2 de 3:"), "{err}");
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.go_a"), "3", "the batches after an error are not sent");
    // Batches behind a paged result: sent once it is read, or told as dropped.
    let out = d.execute("SELECT n FROM dbo.many\nGO\nINSERT dbo.go_a DEFAULT VALUES\nGO\nSELECT 7", 100).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("Quedan 2 lotes")), "{:?}", out.messages);
    let f = d.fetch(5000).unwrap();
    assert!(!f.has_more && f.extra.iter().any(|r| r.rows.len() == 1 && txt(&r.rows[0][0]) == "7"), "{:?}", f.extra);
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.go_a"), "4");
    d.execute("SELECT n FROM dbo.many\nGO\nINSERT dbo.go_a DEFAULT VALUES", 100).unwrap();
    let out = d.execute("SELECT 1", 10).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("No se ejecutó 1 lote")), "{:?}", out.messages);
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dbo.go_a"), "4");

    // Cancel a running statement.
    let e = d.execute("SELECT * FROM celer_secret_42 WHERE x = 'celer-secret-42'", 10).expect_err("tabla inexistente").to_string();
    crate::errlog::assert_scrubbed("SQL Server", &e, "celer_secret_42");
    crate::assert_report_banner("SQL Server", &d.server_info().unwrap(), &["localhost", "1433", "celerdemo"]);
    assert_cancel(d, "WAITFOR DELAY '00:00:30'");
    assert_timeout(d, "WAITFOR DELAY '00:00:30'");

    // The SQL the interface writes, run for real.
    let dt_obj = ObjectRef { database: "celer_test".into(), schema: "dbo".into(), name: "dt".into(), kind: "table".into() };
    let mut shape = json!({ "kind": "mssql", "t": table_shape(d, &obj), "dt": table_shape(d, &dt_obj) });
    // Schema comparison: two schemas with known differences.
    // Drops in a batch of their own: SQL Server compiles a whole batch first, so an INSERT next to them would be
    // checked against a table of another shape left by an earlier run (Msg 213) before the DROP ran.
    d.execute("IF SCHEMA_ID('sc_a') IS NULL EXEC('CREATE SCHEMA sc_a'); IF SCHEMA_ID('sc_b') IS NULL EXEC('CREATE SCHEMA sc_b');
               IF OBJECT_ID('sc_a.cli') IS NOT NULL DROP TABLE sc_a.cli; IF OBJECT_ID('sc_b.cli') IS NOT NULL DROP TABLE sc_b.cli;
               IF OBJECT_ID('sc_a.fac') IS NOT NULL DROP TABLE sc_a.fac; IF OBJECT_ID('sc_b.fac') IS NOT NULL DROP TABLE sc_b.fac;
               IF OBJECT_ID('sc_b.old') IS NOT NULL DROP TABLE sc_b.old;", 10).unwrap();
    d.execute("CREATE TABLE sc_a.cli (id int NOT NULL PRIMARY KEY, nombre nvarchar(120) NOT NULL, email nvarchar(200) NULL, vip bit NULL);
               CREATE TABLE sc_a.fac (id int NOT NULL PRIMARY KEY, importe decimal(12,2) NOT NULL);
               CREATE TABLE sc_b.cli (id int NOT NULL PRIMARY KEY, nombre nvarchar(100) NOT NULL, email nvarchar(200) NOT NULL, legacy nvarchar(10) NULL);
               CREATE TABLE sc_b.old (id bigint NOT NULL PRIMARY KEY);
               INSERT INTO sc_b.cli VALUES (1, N'Ana', N'ana@x.es', N'L1');", 10).unwrap();
    shape["schemas"] = schema_shape(d, "celer_test", "sc_a", "sc_b");
    // Data comparison: same structure, different rows; the target has an identity key.
    d.execute("IF OBJECT_ID('dbo.dc_a') IS NOT NULL DROP TABLE dbo.dc_a; IF OBJECT_ID('dbo.dc_b') IS NOT NULL DROP TABLE dbo.dc_b;", 10).unwrap();
    d.execute("CREATE TABLE dbo.dc_a (id int NOT NULL PRIMARY KEY, nombre nvarchar(50), activo bit, alta datetime2(3), importe decimal(10,2));
               CREATE TABLE dbo.dc_b (id int IDENTITY(1,1) NOT NULL PRIMARY KEY, nombre nvarchar(50), activo bit, alta datetime2(3), importe decimal(10,2));
               INSERT INTO dbo.dc_a VALUES (1, N'Ana', 1, '2024-01-01 10:00:00.125', 1.50), (2, N'Luis', 0, NULL, NULL), (4, N'Zoë 李', NULL, '2024-12-31', -2.25);
               SET IDENTITY_INSERT dbo.dc_b ON; INSERT INTO dbo.dc_b (id, nombre, activo, alta, importe) VALUES (1, N'Ana', 1, '2024-01-01 10:00:00.125', 1.50), (2, N'Luís', 1, NULL, 3.00), (3, N'Viejo', 1, NULL, NULL); SET IDENTITY_INSERT dbo.dc_b OFF;", 10).unwrap();
    let dc_b = ObjectRef { database: "celer_test".into(), schema: "dbo".into(), name: "dc_b".into(), kind: "table".into() };
    shape["data"] = json!({
        "source": result_set(d, "SELECT * FROM dbo.dc_a ORDER BY id"),
        "target": result_set(d, "SELECT * FROM dbo.dc_b ORDER BY id"),
        "key": ["id"],
        "table": d.qualified_name(&dc_b),
        "targetColumns": d.table_columns(&dc_b).unwrap(),
    });
    let statements = generated(shape);
    run_generated(d, &statements);
    // After the scripts: the target schema has the source's columns, and dc_b the rows of dc_a (plus its own extra).
    let cols: Vec<String> = d.table_columns(&ObjectRef { database: "celer_test".into(), schema: "sc_b".into(), name: "cli".into(), kind: "table".into() }).unwrap().iter().map(|c| format!("{} {} {}", c.name, c.type_name, c.nullable)).collect();
    assert!(cols.iter().any(|c| c.starts_with("vip ")), "{cols:?}");
    assert!(cols.iter().any(|c| c.starts_with("nombre ") && c.contains("120")), "{cols:?}");
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM sc_b.fac"), "0");
    let (_, rows) = all_rows(d, "SELECT id, nombre, activo, importe FROM dbo.dc_b ORDER BY id");
    let got: Vec<String> = rows.iter().map(|r| r.iter().map(txt).collect::<Vec<_>>().join("|")).collect();
    assert_eq!(got, vec!["1|Ana|true|1.50", "2|Luis|false|NULL", "3|Viejo|true|NULL", "4|Zoë 李|NULL|-2.25"]);
    // The identity of dc_b goes on from there (IDENTITY_INSERT left off).
    d.execute("INSERT INTO dbo.dc_b (nombre) VALUES (N'siguiente')", 10).unwrap();

    // Startup script: run on connect; a broken one says so.
    let mut cfg = mssql_cfg("celer_test").unwrap();
    cfg.startup_sql = "SET LANGUAGE Spanish; SET DATEFORMAT ymd".into();
    let mut s = crate::mssql::MssqlDriver::connect(cfg.clone()).unwrap();
    assert_eq!(scalar(&mut s, "SELECT @@LANGUAGE"), "Español");
    cfg.startup_sql = "SELEC 1".into();
    let err = crate::mssql::MssqlDriver::connect(cfg).err().expect("script erróneo").to_string();
    assert!(err.contains("script de inicio"), "{err}");

    // Activity: ending another session.
    let mut other = mssql("celer_test").unwrap();
    let spid = scalar(&mut other, "SELECT @@SPID");
    d.execute(&format!("KILL {spid}"), 10).unwrap();
    // The killed session reconnects on its next statement (or reports the loss once).
    let again = other.execute("SELECT 1", 10).or_else(|_| other.execute("SELECT 1", 10));
    assert!(again.is_ok(), "{:?}", again.err());

    // USE moves the session; use_database too.
    d.execute("USE master", 10).unwrap();
    assert_eq!(d.current_database().unwrap(), "master");
    d.use_database("celer_test").unwrap();
    assert_eq!(scalar(d, "SELECT DB_NAME()"), "celer_test");
}

/// A big result left half read (a page of 500, as the interface asks for). Without session state, the next statement
/// goes on at once in the session's reserve connection; with a transaction or #temp tables, the session keeps its
/// connection (same SPID) and they survive.
#[test]
fn mssql_abandoned_cursor() {
    let Some(mut d) = mssql("tempdb") else { return };
    let d: &mut dyn Driver = &mut d;
    // 200.000 rows of ~200 bytes: far more than the network buffers hold, so the server is still sending.
    d.execute("IF OBJECT_ID('dbo.celer_big') IS NOT NULL DROP TABLE dbo.celer_big;
               SELECT TOP 200000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n, REPLICATE(N'x', 100) AS relleno
               INTO dbo.celer_big FROM sys.all_objects a CROSS JOIN sys.all_objects b", 10).unwrap();
    let page = |d: &mut dyn Driver| {
        let t0 = Instant::now();
        let out = d.execute("SELECT n, relleno FROM dbo.celer_big", 500).unwrap();
        assert!(out.results[0].has_more && out.results[0].rows.len() == 500);
        t0.elapsed().as_millis()
    };
    for round in 1..=3 {
        let first = page(d);
        let t0 = Instant::now();
        let out = d.execute("SELECT DB_NAME(), @@LANGUAGE", 10).unwrap();
        let next = t0.elapsed().as_millis();
        eprintln!("cursor abandonado sin estado, ronda {round}: primera página {first} ms, siguiente consulta {next} ms; {:?}", out.messages);
        assert!(next < 500, "la consulta tras el cursor abandonado tardó {next} ms");
        assert!(out.messages.iter().any(|m| m.contains("sigue en la conexión de reserva")), "{:?}", out.messages);
        // Same database (and startup script) on the reserve.
        assert_eq!(txt(&out.results[0].rows[0][0]), "tempdb");
        // How the old connection was cut and closed, in the background, comes with the next statement.
        let later = d.execute("SELECT 1", 10).unwrap();
        eprintln!("  después: {:?}", later.messages);
    }
    // "Pedir más" still works after a cut: a new cursor pages on.
    page(d);
    assert_eq!(d.fetch(500).unwrap().rows.len(), 500);
    // The rest of a batch cut with its result is told, before and after.
    let out = d.execute("SELECT n, relleno FROM dbo.celer_big\nSELECT 1", 500).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("Lo que quede del lote")), "{:?}", out.messages);
    let out = d.execute("SELECT 2", 10).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("Lo que quedaba del lote anterior no se ejecutó")), "{:?}", out.messages);

    // A #temp table and an open transaction (autocommit mode, BEGIN TRAN) across an abandoned cursor.
    let spid = scalar(d, "SELECT @@SPID");
    d.execute("CREATE TABLE #celer_tmp (id int); INSERT INTO #celer_tmp VALUES (1)", 10).unwrap();
    let out = d.execute("BEGIN TRAN; INSERT INTO #celer_tmp VALUES (2)", 10).unwrap();
    assert!(out.in_transaction);
    page(d);
    let t0 = Instant::now();
    let out = d.execute("SELECT COUNT(*), @@TRANCOUNT, @@SPID FROM #celer_tmp", 10).unwrap();
    eprintln!("#temp y transacción tras el cursor abandonado: {} ms; {:?}", t0.elapsed().as_millis(), out.messages);
    let row: Vec<String> = out.results[0].rows[0].iter().map(txt).collect();
    assert_eq!(row, vec!["2".to_string(), "1".to_string(), spid.clone()]);
    assert!(out.in_transaction);
    d.rollback().unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM #celer_tmp"), "1");

    // EXECUTE AS is session state: the session keeps its connection across a cut.
    d.execute("GRANT SELECT ON dbo.celer_big TO guest; EXECUTE AS USER = 'guest'", 10).unwrap();
    page(d);
    assert_eq!(scalar(d, "SELECT USER_NAME()"), "guest");
    assert_eq!(scalar(d, "SELECT @@SPID"), spid);
    d.execute("REVERT", 10).unwrap();

    // Manual mode keeps its transaction across a cut too.
    d.set_autocommit(false).unwrap();
    d.execute("INSERT INTO #celer_tmp VALUES (3)", 10).unwrap();
    page(d);
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM #celer_tmp"), "2");
    assert_eq!(scalar(d, "SELECT @@SPID"), spid);
    assert!(!d.rollback().unwrap());
    d.set_autocommit(true).unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM #celer_tmp"), "1");

    // A closed session without state of its own leaves its connection to the next one: no new login.
    let mut a = mssql("tempdb").unwrap();
    let spid_a = scalar(&mut a, "SELECT @@SPID");
    drop(a);
    let t0 = Instant::now();
    let mut b = mssql("tempdb").unwrap();
    let reused = t0.elapsed().as_millis();
    assert_eq!(scalar(&mut b, "SELECT @@SPID"), spid_a, "la sesión nueva debía reutilizar la conexión libre");
    eprintln!("sesión nueva con la conexión libre de otra: {reused} ms");
    assert_eq!(b.current_database().unwrap(), "tempdb");
}

/// "cols → table(cols)": the format the interface reads FK nodes with.
fn regex_lite(detail: &str) -> bool {
    let Some((left, right)) = detail.split_once('→') else { return false };
    !left.trim().is_empty() && right.trim_end().ends_with(')') && right.contains('(')
}

/// Two schemas' tables (columns as the driver reports them) and the source's DDL, for the schema comparison.
fn schema_shape(d: &mut dyn Driver, database: &str, source: &str, target: &str) -> serde_json::Value {
    let mut side = |schema: &str| {
        let mut path = vec![database.to_string()];
        if !schema.is_empty() {
            path.push(schema.to_string());
        }
        let folders = d.children(&path).unwrap();
        let folder = folders.iter().find(|n| n.kind == "folder" && n.path.last().map(String::as_str) == Some("tables")).expect("tablas").path.clone();
        let objs: Vec<ObjectRef> = d.children(&folder).unwrap().into_iter().filter_map(|n| n.obj).filter(|o| o.kind == "table").collect();
        let mut tables = vec![];
        let mut ddl = serde_json::Map::new();
        for o in objs {
            let columns = d.table_columns(&o).unwrap();
            ddl.insert(o.name.clone(), json!(d.ddl(&o).unwrap()));
            tables.push(json!({ "name": o.name, "columns": columns }));
        }
        (tables, ddl)
    };
    let (src, ddl) = side(source);
    let (dst, _) = side(target);
    json!({ "source": src, "target": dst, "sourceDdl": ddl, "schema": target, "sourceSchema": source })
}

// ───────────────────────────────────────────────────────────────── Informix (DRDA and JDBC)

type Connect = dyn Fn(ConnConfig) -> anyhow::Result<Box<dyn Driver>>;

fn informix_cfg() -> Option<(ConnConfig, String)> {
    let s = spec("CELER_INFORMIX_TEST")?;
    let lib = std::env::var("CELER_IBM_LIB").ok()?;
    // Celer's db2dsdriver.cfg (no reconnection by the CLI driver itself), as the app writes it in its data folder.
    crate::drivers::use_cli_cfg_dir(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/target/celer-engine-tests")));
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Informix;
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = get(&s, "database");
    Some((cfg, lib))
}

/// Informix over JDBC: the connection, and Java with the driver's jars.
fn informix_jdbc_cfg() -> Option<(ConnConfig, crate::jdbc::Runtime)> {
    let s = spec("CELER_INFORMIX_JDBC_TEST")?;
    let java = std::env::var("CELER_JAVA").ok()?;
    let jars: Vec<std::path::PathBuf> = std::env::split_paths(&std::env::var_os("CELER_JDBC_JARS")?).collect();
    let dir = std::env::temp_dir().join("celer-engine-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let found = crate::drivers::find_java(Some(&java), &dir, false);
    let java_major = found.first().map(|j| j.major).expect("la versión de CELER_JAVA");
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Informix;
    cfg.informix_mode = "jdbc".into();
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = get(&s, "database");
    cfg.instance = get(&s, "server");
    Some((cfg, crate::jdbc::Runtime { java: java.into(), java_major, driver_class: crate::drivers::INFORMIX_JDBC.class.into(), jars, dir }))
}

fn drda_connect(lib: String) -> Box<Connect> {
    Box::new(move |cfg| Ok(Box::new(crate::odbc_driver::OdbcDriver::connect(cfg, lib.clone())?) as Box<dyn Driver>))
}

fn jdbc_connect(rt: crate::jdbc::Runtime) -> Box<Connect> {
    Box::new(move |cfg| Ok(Box::new(crate::jdbc::connect(cfg, rt.clone())?) as Box<dyn Driver>))
}

const INFORMIX_SEED: &str = "DROP TABLE IF EXISTS celer_t;
DROP TABLE IF EXISTS celer_p;
CREATE TABLE celer_p (id INT PRIMARY KEY, nombre VARCHAR(50) NOT NULL);
INSERT INTO celer_p VALUES (1, 'Uno');
INSERT INTO celer_p VALUES (2, 'Dos');
CREATE TABLE celer_t (id INT PRIMARY KEY, nombre VARCHAR(100) NOT NULL, activo BOOLEAN, alta DATE,
  importe DECIMAL(12,2), notas LVARCHAR(2000), parent_id INT REFERENCES celer_p(id), momento DATETIME YEAR TO MINUTE);
INSERT INTO celer_t VALUES (1, 'Ana Ruiz', 't', MDY(1, 15, 2024), 120.50, 'nota 50% off', 1, DATETIME(2024-01-15 10:30) YEAR TO MINUTE);
INSERT INTO celer_t VALUES (2, 'Luis Peña', 'f', MDY(2, 20, 2024), 0.00, NULL, 2, NULL);
INSERT INTO celer_t VALUES (3, 'Zoë Martín', 't', NULL, -5.25, '[corchetes]', NULL, NULL);
INSERT INTO celer_t VALUES (4, 'O''Neil', NULL, MDY(12, 31, 2023), 99999.99, '', 1, NULL)";

#[test]
fn informix_engine() {
    let Some((cfg, lib)) = informix_cfg() else { return };
    informix_suite("DRDA", cfg, &drda_connect(lib));
}

#[test]
fn informix_jdbc_engine() {
    let Some((cfg, rt)) = informix_jdbc_cfg() else { return };
    let t0 = Instant::now();
    let mut d = jdbc_connect(rt.clone())(cfg.clone()).expect("conexión Informix por JDBC");
    println!("JDBC: Java arrancado y conectado en {:?}", t0.elapsed());
    let t1 = Instant::now();
    let again = jdbc_connect(rt.clone())(cfg.clone()).expect("segunda conexión por JDBC");
    println!("JDBC: otra conexión con Java ya en marcha: {:?}", t1.elapsed());
    drop(again);
    // JDBC brings Informix's own types: BOOLEAN is a boolean, not DRDA's SMALLINT.
    d.execute("DROP TABLE IF EXISTS jt; CREATE TABLE jt (b BOOLEAN, i8 INT8, f FLOAT, m MONEY(8,2), t TEXT, bt BYTE, iv INTERVAL DAY TO SECOND)", 10).unwrap();
    d.execute("INSERT INTO jt (b, i8, f, m, iv) VALUES ('t', 9007199254740993, 1.5, 12.34, INTERVAL(1 02:03:04) DAY TO SECOND)", 10).unwrap();
    d.execute("INSERT INTO jt (b) VALUES (NULL)", 10).unwrap();
    let (cols, rows) = all_rows(d.as_mut(), "SELECT * FROM jt ORDER BY 1");
    println!("JDBC tipos: {:?}", cols.iter().map(|c| (&c.name, &c.type_name, c.kind)).collect::<Vec<_>>());
    println!("JDBC filas: {:?}", rows.iter().map(|r| r.iter().map(txt).collect::<Vec<_>>()).collect::<Vec<_>>());
    let full = rows.iter().find(|r| !matches!(r[0], Cell::Null)).unwrap();
    assert!(matches!(full[0], Cell::Bool(true)), "{:?}", full[0]);
    assert_eq!(txt(&full[1]), "9007199254740993", "INT8 beyond JavaScript's safe integers, exact");
    assert_eq!(txt(&full[3]), "12.34");
    assert!(rows.iter().any(|r| r.iter().all(|c| matches!(c, Cell::Null))), "a row of NULLs");
    drop(d);
    informix_suite("JDBC", cfg, &jdbc_connect(rt));
}

/// Two JDBC sessions: while one is being cancelled (the bridge may have to cut its connection), the other keeps
/// answering; the cancelled one works again afterwards, and a transaction lost with a cut connection is reported.
/// `proxied` reaches the server through Docker's port proxy, which may drop the TCP urgent data of Informix's cancel.
#[test]
fn informix_jdbc_sessions() {
    let Some((cfg, rt)) = informix_jdbc_cfg() else { return };
    let mut slow_cfg = cfg.clone();
    if let Some(proxied) = spec("CELER_INFORMIX_JDBC_TEST").map(|s| get(&s, "proxied")).filter(|h| !h.is_empty()) {
        slow_cfg.host = proxied;
    }
    let connect = jdbc_connect(rt);
    let mut a = connect(slow_cfg).expect("sesión A");
    let mut b = connect(cfg).expect("sesión B");
    let _guard = watchdog("dos sesiones JDBC", 180);
    a.execute("DROP TABLE IF EXISTS jtx; CREATE TABLE jtx (n INT)", 1).unwrap();
    a.set_autocommit(false).unwrap();
    a.execute("INSERT INTO jtx VALUES (1)", 1).unwrap();
    let cancel = a.canceller();
    let worker = std::thread::spawn(move || {
        let r = a.execute("SELECT COUNT(*) FROM systables a, systables b, systables c, systables d, systables e", 10).map(|_| ());
        (a, r, Instant::now())
    });
    std::thread::sleep(Duration::from_millis(800));
    let cancelled_at = Instant::now();
    cancel();
    // B answers all the while.
    let mut slowest = Duration::ZERO;
    let mut answers = 0;
    while !worker.is_finished() && cancelled_at.elapsed() < Duration::from_secs(30) {
        let t = Instant::now();
        assert_eq!(scalar(b.as_mut(), "SELECT COUNT(*) FROM systables WHERE tabid = 1"), "1");
        slowest = slowest.max(t.elapsed());
        answers += 1;
        std::thread::sleep(Duration::from_millis(100));
    }
    let (mut a, r, ended) = worker.join().unwrap();
    let err = r.expect_err("la consulta lenta debía cancelarse").to_string();
    let stopped = ended.duration_since(cancelled_at);
    let cut = err.contains("se reabre la conexión");
    println!(
        "JDBC cancelar: paró en {stopped:?} ({}); la otra sesión respondió {answers} veces mientras, la más lenta en {slowest:?}\n  {}",
        if cut { "el servidor no obedeció: conexión cortada y reabierta" } else { "cancelada por el servidor" },
        err.replace('\n', " · ")
    );
    assert!(stopped < Duration::from_secs(15), "cancelar tardó {stopped:?}");
    assert!(answers > 0 && slowest < Duration::from_secs(3), "la otra sesión no respondió a tiempo ({answers}, {slowest:?})");
    if cut {
        assert!(err.contains("transacción"), "se perdió una transacción abierta y debe decirlo: {err}");
    }
    // A works again (a new connection when it was cut: the insert is gone either way after a rollback).
    a.rollback().ok();
    assert_eq!(scalar(a.as_mut(), "SELECT COUNT(*) FROM jtx"), "0");
    a.set_autocommit(true).unwrap();
}

fn informix_suite(via: &str, cfg: ConnConfig, connect: &Connect) {
    println!("── Informix por {via}");
    let mut d = connect(cfg.clone()).unwrap_or_else(|e| panic!("conexión Informix por {via}: {e}"));
    let d: &mut dyn Driver = d.as_mut();
    let db = d.current_database().unwrap();
    assert_eq!(db.trim(), "celer");
    println!("servidor: {}", d.server_info().unwrap());
    d.execute(INFORMIX_SEED, 10).unwrap();

    // Types as the grid gets them.
    let (cols, rows) = all_rows(d, "SELECT * FROM celer_t ORDER BY id");
    assert_eq!(rows.len(), 4);
    println!("columnas: {:?}", cols.iter().map(|c| (&c.name, &c.type_name, c.kind)).collect::<Vec<_>>());
    println!("fila 1: {:?}", rows[0].iter().map(txt).collect::<Vec<_>>());
    assert_eq!(txt(&rows[2][1]), "Zoë Martín");
    assert_eq!(txt(&rows[1][1]), "Luis Peña");
    // Over DRDA a BOOLEAN arrives as SMALLINT (0 / 1): what every DRDA client shows.
    assert!(matches!(cols[2].kind, ColKind::Bool | ColKind::Number), "BOOLEAN: {:?}", cols[2]);
    assert_eq!(cols[3].kind, ColKind::Date, "DATE");
    assert_eq!(cols[4].kind, ColKind::Number, "DECIMAL");

    // Metadata: databases, tables, FK format, columns, DDL, completion.
    let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let root = d.children(&[]).unwrap();
    assert!(root.iter().any(|n| n.name.trim() == "celer"), "{:?}", root.iter().map(|n| &n.name).collect::<Vec<_>>());
    let folders = d.children(&p(&["celer"])).unwrap();
    let tables_folder = folders.iter().find(|n| n.kind == "folder" && n.path.last().map(String::as_str) == Some("tables")).unwrap_or_else(|| panic!("carpeta de tablas: {:?}", folders.iter().map(|n| (&n.name, &n.path)).collect::<Vec<_>>()));
    let tables = d.children(&tables_folder.path).unwrap();
    let t_node = tables.iter().find(|n| n.name == "celer_t").expect("celer_t");
    let obj = t_node.obj.clone().unwrap();
    let fks = d.children(&[t_node.path.clone(), vec!["fks".into()]].concat()).unwrap();
    let fk = fks.iter().find(|n| n.kind == "key").expect("la clave foránea");
    assert!(regex_lite(fk.detail.as_deref().unwrap_or("")), "detalle de FK: {:?}", fk.detail);
    assert_eq!(fk.obj.as_ref().unwrap().name, "celer_p");
    assert_eq!(fk.detail.as_deref(), Some("parent_id → celer_p(id)"));
    // The table viewer asks in the other engines' order [db, owner, "tables", table, …].
    let owner = obj.schema.clone();
    let viewer_fks = d.children(&p(&["celer", &owner, "tables", "celer_t", "fks"])).unwrap();
    assert_eq!(viewer_fks.len(), 1, "claves pedidas por el visor de tablas");
    let viewer_idx = d.children(&p(&["celer", &owner, "tables", "celer_t", "indexes"])).unwrap();
    assert!(!viewer_idx.is_empty(), "índices pedidos por el visor de tablas");
    let columns = d.table_columns(&obj).unwrap();
    assert!(columns[0].primary_key, "{columns:?}");
    assert!(d.ddl(&obj).unwrap().to_uppercase().contains("CREATE TABLE"));
    assert!(d.completion("celer").unwrap().tables.iter().any(|t| t.name == "celer_t"));
    // Every key of the database at once (the E-R diagram), as the explorer gives them table by table.
    informix_schema_fks(via, d);
    // Keys in the DDL: the primary key in its own order, UNIQUE and FOREIGN KEY constraints.
    d.execute("DROP TABLE IF EXISTS ddl_c; DROP TABLE IF EXISTS ddl_p; CREATE TABLE ddl_p (a INT, b INT, PRIMARY KEY (b, a));
               CREATE TABLE ddl_c (id INT PRIMARY KEY, code CHAR(5) UNIQUE, pb INT, pa INT, FOREIGN KEY (pb, pa) REFERENCES ddl_p ON DELETE CASCADE)", 10).unwrap();
    let ddl_of = |d: &mut dyn Driver, name: &str| d.ddl(&ObjectRef { database: "celer".into(), schema: owner.clone(), name: name.into(), kind: "table".into() }).unwrap();
    let p_ddl = ddl_of(d, "ddl_p");
    assert!(p_ddl.contains("PRIMARY KEY (b, a)"), "{p_ddl}");
    d.execute("DROP TABLE IF EXISTS ddl_iv; CREATE TABLE ddl_iv (d INTERVAL DAY(5) TO HOUR, m INTERVAL MINUTE TO FRACTION(3))", 10).unwrap();
    let iv_ddl = ddl_of(d, "ddl_iv");
    assert!(iv_ddl.contains("d INTERVAL DAY(5) TO HOUR") && iv_ddl.contains("m INTERVAL MINUTE TO FRACTION(3)"), "{iv_ddl}");
    let c_ddl = ddl_of(d, "ddl_c");
    assert!(c_ddl.contains("UNIQUE (code)") && c_ddl.contains(&format!("FOREIGN KEY (pb, pa) REFERENCES {owner}.ddl_p (b, a) ON DELETE CASCADE")), "{c_ddl}");

    // Paging and closing a cursor half way.
    d.execute("DROP TABLE IF EXISTS many; CREATE TABLE many (n INT)", 10).unwrap();
    d.execute("INSERT INTO many SELECT FIRST 3000 ROW_NUMBER() OVER (ORDER BY a.tabid) FROM systables a, systables b", 10)
        .or_else(|_| {
            // Older servers: build it with a procedure-free loop of inserts.
            for i in 1..=3000 {
                d.execute(&format!("INSERT INTO many VALUES ({i})"), 1)?;
            }
            Ok::<_, anyhow::Error>(Default::default())
        })
        .unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM many"), "3000");
    let out = d.execute("SELECT n FROM many ORDER BY n", 1000).unwrap();
    assert!(out.results[0].has_more && out.results[0].rows.len() == 1000);
    let f = d.fetch(1500).unwrap();
    assert_eq!(f.rows.len(), 1500);
    d.close_cursor().unwrap();
    // Statements behind a paged result: told when it opens, and when they are dropped.
    let out = d.execute("SELECT n FROM many; DELETE FROM many WHERE n = 1", 500).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("Queda 1 sentencia")), "{:?}", out.messages);
    let out = d.execute("SELECT COUNT(*) FROM many", 10).unwrap();
    assert!(out.messages.iter().any(|m| m.starts_with("No se ejecutó 1 sentencia")), "{:?}", out.messages);
    assert_eq!(txt(&out.results[0].rows[0][0]), "3000");

    // Transactions.
    d.set_autocommit(false).unwrap();
    let out = d.execute("DELETE FROM many WHERE n > 2990", 10).unwrap();
    assert!(out.in_transaction, "en modo manual hay transacción abierta");
    assert!(!d.rollback().unwrap());
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM many"), "3000");
    d.execute("DELETE FROM many WHERE n > 2990", 10).unwrap();
    d.commit().unwrap();
    d.set_autocommit(true).unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM many"), "2990");
    // Over DRDA the IBM CLI and over JDBC the bridge are told to roll back before they disconnect.
    assert_close_never_commits(d, connect(cfg.clone()).unwrap(), "DELETE FROM many WHERE n > 2980", "SELECT COUNT(*) FROM many WHERE n >= 0");

    // Errors with the server's message.
    let err = d.execute("SELECT nope FROM celer_t", 10).unwrap_err().to_string();
    assert!(!err.is_empty(), "{err}");
    println!("error de ejemplo: {err}");

    // DATETIME and DATE: what the grid shows is accepted back as it is.
    // DATETIME qualifiers: DRDA sends every one as a TIMESTAMP (six fraction digits); the interface fits the value
    // to the column (from the catalog) when it writes it: checked below with the generated SQL ("dt").
    d.execute("DROP TABLE IF EXISTS dt; CREATE TABLE dt (id INT PRIMARY KEY, a DATETIME YEAR TO FRACTION(5), b DATETIME YEAR TO SECOND, c DATE, h DATETIME HOUR TO SECOND, m DATETIME YEAR TO MINUTE, f DATETIME YEAR TO FRACTION(3))", 10).unwrap();
    d.execute("INSERT INTO dt VALUES (1, DATETIME(2024-03-15 10:20:30.12345) YEAR TO FRACTION(5), DATETIME(2024-03-15 10:20:30) YEAR TO SECOND, MDY(3, 15, 2024), DATETIME(08:30:00) HOUR TO SECOND, DATETIME(2024-03-15 10:20) YEAR TO MINUTE, DATETIME(2024-03-15 10:20:30.5) YEAR TO FRACTION(3))", 10).unwrap();
    let (_, dt) = all_rows(d, "SELECT a, b, c, h, m, f FROM dt");
    println!("fechas: {:?}", dt[0].iter().map(txt).collect::<Vec<_>>());
    let dt_obj = ObjectRef { database: "celer".into(), schema: obj.schema.clone(), name: "dt".into(), kind: "table".into() };

    // Cancel a long statement.
    let e = d.execute("SELECT * FROM celer_secret_42", 10).expect_err("tabla inexistente").to_string();
    crate::errlog::assert_scrubbed(&format!("Informix {via}"), &e, "celer_secret_42");
    // (The user is "informix", which the product name holds too: not a check here.)
    crate::assert_report_banner(&format!("Informix {via}"), &d.server_info().unwrap(), &[&cfg.host, &cfg.password.clone().unwrap_or_default()]);
    assert_cancel(d, "SELECT COUNT(*) FROM systables a, systables b, systables c, systables d, systables e");
    assert_timeout(d, "SELECT COUNT(*) FROM systables a, systables b, systables c, systables d, systables e");

    // The SQL the interface writes, run for real.
    let mut shape = json!({ "kind": "informix", "t": table_shape(d, &obj), "dt": table_shape(d, &dt_obj) });
    d.execute("DROP TABLE IF EXISTS dc_a; DROP TABLE IF EXISTS dc_b;
               CREATE TABLE dc_a (id INT PRIMARY KEY, nombre VARCHAR(50), activo BOOLEAN, alta DATE, importe DECIMAL(10,2), momento DATETIME YEAR TO MINUTE);
               CREATE TABLE dc_b (id SERIAL PRIMARY KEY, nombre VARCHAR(50), activo BOOLEAN, alta DATE, importe DECIMAL(10,2), momento DATETIME YEAR TO MINUTE);
               INSERT INTO dc_a VALUES (1, 'Ana', 't', MDY(1, 1, 2024), 1.50, DATETIME(2024-01-01 10:00) YEAR TO MINUTE);
               INSERT INTO dc_a VALUES (2, 'Luis', 'f', NULL, NULL, NULL);
               INSERT INTO dc_a VALUES (4, 'Zoë', NULL, MDY(12, 31, 2024), -2.25, DATETIME(2024-12-31 23:59) YEAR TO MINUTE);
               INSERT INTO dc_b VALUES (1, 'Ana', 't', MDY(1, 1, 2024), 1.50, NULL);
               INSERT INTO dc_b VALUES (2, 'Luís', 't', NULL, 3.00, NULL);
               INSERT INTO dc_b VALUES (3, 'Viejo', 't', NULL, NULL, NULL)", 10).unwrap();
    let dc_b = ObjectRef { database: "celer".into(), schema: obj.schema.clone(), name: "dc_b".into(), kind: "table".into() };
    shape["data"] = json!({
        "source": result_set(d, "SELECT * FROM dc_a ORDER BY id"),
        "target": result_set(d, "SELECT * FROM dc_b ORDER BY id"),
        "key": ["id"],
        "table": d.qualified_name(&dc_b),
        "targetColumns": d.table_columns(&dc_b).unwrap(),
    });
    let statements = generated(shape);
    run_generated(d, &statements);
    let (_, rows) = all_rows(d, "SELECT id, nombre, activo, importe FROM dc_b ORDER BY id");
    // Booleans as true/false or 1/0 (DRDA).
    let got: Vec<String> = rows.iter().map(|r| r.iter().map(txt).collect::<Vec<_>>().join("|")).collect();
    let norm = |s: &str| s.replace("|true|", "|1|").replace("|false|", "|0|");
    assert_eq!(got.iter().map(|g| norm(g)).collect::<Vec<_>>(), vec!["1|Ana|1|1.50", "2|Luis|0|NULL", "3|Viejo|1|NULL", "4|Zoë|NULL|-2.25"]);
    // DATETIME YEAR TO MINUTE values written by the script (fitted to the qualifier).
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dc_b WHERE id = 1 AND momento = DATETIME(2024-01-01 10:00) YEAR TO MINUTE"), "1");
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM dc_b WHERE id = 4 AND momento = DATETIME(2024-12-31 23:59) YEAR TO MINUTE"), "1");

    // Startup script: run on connect; a broken one says so.
    let mut cfg = cfg;
    cfg.startup_sql = "SET LOCK MODE TO WAIT 5".into();
    let mut s = connect(cfg.clone()).unwrap();
    assert_eq!(scalar(s.as_mut(), "SELECT COUNT(*) FROM celer_t"), "5", "4 seeded, one deleted, one inserted, one upserted");
    cfg.startup_sql = "SELEC 1".into();
    let err = connect(cfg.clone()).err().expect("script erróneo").to_string();
    assert!(err.contains("script de inicio"), "{err}");

    // Another database: the session reconnects there and back.
    d.use_database("sysmaster").unwrap();
    assert_eq!(d.current_database().unwrap().trim(), "sysmaster");
    d.use_database("celer").unwrap();
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM celer_t"), "5");
}

/// Reading 200,000 rows the way "Cargar todo" does (pages of 5,000), over DRDA and over JDBC with several fetch
/// buffers. The numbers go to the log and to target-informix-speed.txt (an artifact of the engines workflow).
#[test]
fn informix_speed() {
    let mut runs: Vec<(String, Box<dyn Fn() -> Box<dyn Driver>>)> = Vec::new();
    if let Some((cfg, lib)) = informix_cfg() {
        let connect = drda_connect(lib);
        runs.push(("DRDA (IBM CLI)".into(), Box::new(move || connect(cfg.clone()).unwrap())));
    }
    if let Some((cfg, rt)) = informix_jdbc_cfg() {
        let variants: [(&str, &str, bool); 6] = [
            ("JDBC, como lo usa Celer", "", true),
            ("JDBC, FET_BUF_SIZE del driver", "FET_BUF_SIZE=0", false),
            ("JDBC, FET_BUF_SIZE=32767", "FET_BUF_SIZE=32767", false),
            ("JDBC, FET_BUF_SIZE=262144", "FET_BUF_SIZE=262144", false),
            ("JDBC, FET_BUF_SIZE=1048576", "FET_BUF_SIZE=1048576", false),
            ("JDBC, FET_BUF_SIZE=4194304", "FET_BUF_SIZE=4194304", false),
        ];
        for (name, extra, page_fetch) in variants {
            let (mut cfg, rt) = (cfg.clone(), rt.clone());
            cfg.extra = extra.into();
            runs.push((name.into(), Box::new(move || Box::new(crate::jdbc::connect_tuned(cfg.clone(), rt.clone(), page_fetch).unwrap()) as Box<dyn Driver>)));
        }
    }
    if runs.is_empty() {
        return;
    }
    // The table, once: a RAW table (no logging for 200,000 inserts) filled from a cross join of digits.
    {
        let mut d = (runs[0].1)();
        let d = d.as_mut();
        let ready = d.execute("SELECT COUNT(*) FROM perf", 1).ok().and_then(|o| o.results.first().map(|r| txt(&r.rows[0][0]))).is_some_and(|n| n == "200000");
        if !ready {
            d.execute("DROP TABLE IF EXISTS perf; DROP TABLE IF EXISTS digits; CREATE TABLE digits (n INT)", 1).unwrap();
            for i in 0..10 {
                d.execute(&format!("INSERT INTO digits VALUES ({i})"), 1).unwrap();
            }
            d.execute("CREATE RAW TABLE perf (id INT, nombre VARCHAR(40), importe DECIMAL(12,2), alta DATE, momento DATETIME YEAR TO SECOND, activo BOOLEAN, notas LVARCHAR(200))", 1).unwrap();
            d.execute(
                "INSERT INTO perf SELECT a.n + b.n * 10 + c.n * 100 + e.n * 1000 + f.n * 10000 + g.n * 100000, \
                   'nombre ' || TRIM(CAST(a.n + b.n * 10 + c.n * 100 AS VARCHAR(12))), (a.n + b.n * 10 + c.n * 100 + e.n * 1000) / 7.0, \
                   MDY(1 + b.n, 1 + c.n, 2000 + e.n), DATETIME(2024-01-01 00:00:00) YEAR TO SECOND + (a.n + b.n * 10) UNITS MINUTE, \
                   CASE WHEN a.n > 4 THEN 't' ELSE 'f' END, 'una nota algo más larga para que la fila pese lo normal ' || TRIM(CAST(f.n AS VARCHAR(2))) \
                 FROM digits a, digits b, digits c, digits e, digits f, digits g WHERE g.n < 2",
                1,
            )
            .unwrap();
        }
        assert_eq!(scalar(d, "SELECT COUNT(*) FROM perf"), "200000");
    }
    let read_all = |d: &mut dyn Driver| {
        let t0 = Instant::now();
        let out = d.execute("SELECT * FROM perf", 5000).unwrap();
        let mut n = out.results[0].rows.len();
        let mut more = out.results[0].has_more;
        while more {
            let f = d.fetch(5000).unwrap();
            n += f.rows.len();
            more = f.has_more;
        }
        assert_eq!(n, 200_000);
        t0.elapsed()
    };
    let mut report = vec![format!("{:<34} {:>11} {:>10} {:>10} {:>10}", "200.000 filas, páginas de 5.000", "conexión", "mejor", "mediana", "filas/s")];
    for (name, open) in &runs {
        let t0 = Instant::now();
        let mut d = open();
        let connect = t0.elapsed();
        read_all(d.as_mut()); // warm-up: server cache, JIT
        let mut times: Vec<Duration> = (0..3).map(|_| read_all(d.as_mut())).collect();
        times.sort();
        let (best, median) = (times[0], times[1]);
        report.push(format!("{name:<34} {:>8} ms {:>7} ms {:>7} ms {:>10.0}", connect.as_millis(), best.as_millis(), median.as_millis(), 200_000.0 / median.as_secs_f64()));
    }
    let text = report.join("\n");
    println!("\n{text}\n");
    let _ = std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../target-informix-speed.txt"), text);
}

// ───────────────────────────────────────────────────────────────── reconnection and the pool (guard.rs)

use crate::guard::{Connector, Guarded, Opts, RECOVERED};

/// A watched session, as the interface opens them (`key` "" = without the generic pool).
fn guarded(kind: DbKind, connect: &Connector, key: &str, database: &str) -> Guarded {
    Guarded::open(connect.clone(), Opts { kind, owner: format!("engine-test-{key}"), key: key.into(), database: database.into(), autocommit: true }).expect("sesión vigilada")
}

/// The connection a SQL Server session runs on. SQL Server gives a killed session's SPID to the next login, so the
/// SPID alone does not tell two connections apart; `connection_id` is new for every connection.
const MSSQL_CONN_ID: &str = "SELECT CONVERT(varchar(36), connection_id) FROM sys.dm_exec_connections WHERE session_id = @@SPID AND parent_connection_id IS NULL";

/// Ends a SQL Server session from another one (KILL), as a DBA or a failover would; returns its connection's
/// `connection_id`.
fn mssql_kill(admin: &mut dyn Driver, g: &mut Guarded) -> String {
    let spid = scalar(g, "SELECT @@SPID");
    let conn = scalar(g, MSSQL_CONN_ID);
    admin.execute(&format!("KILL {spid}"), 10).unwrap_or_else(|e| panic!("KILL {spid}: {e}"));
    std::thread::sleep(Duration::from_millis(500));
    conn
}

/// A session killed on the server comes back on its own when nothing would be lost (the read runs again, the output
/// says so), says so when a transaction or #temp tables went with it, never repeats a write, and is checked before
/// use after a pause.
#[test]
fn mssql_reconnects() {
    let Some(cfg) = mssql_cfg("tempdb") else { return };
    let Some(mut admin) = mssql("master") else { return };
    let connect: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::mssql::MssqlDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let mut g = guarded(DbKind::Mssql, &connect, "", "tempdb");

    let killed = mssql_kill(&mut admin, &mut g);
    let t0 = Instant::now();
    let out = g.execute(&format!("SELECT ({MSSQL_CONN_ID}), DB_NAME()"), 10).unwrap_or_else(|e| panic!("tras KILL: {e}"));
    eprintln!("SQL Server, sesión terminada con KILL: {} ms; {:?}", t0.elapsed().as_millis(), out.messages);
    assert_ne!(txt(&out.results[0].rows[0][0]), killed, "otra conexión");
    assert_eq!(txt(&out.results[0].rows[0][1]), "tempdb", "en la misma base");
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{:?}", out.messages);

    // A transaction and a #temp table are never lost in silence.
    let out = g.execute("BEGIN TRAN; CREATE TABLE #celer_rc (a int)", 10).unwrap();
    assert!(out.in_transaction);
    mssql_kill(&mut admin, &mut g);
    let e = g.execute("SELECT 1", 10).unwrap_err().to_string();
    eprintln!("con transacción: {e}");
    assert!(e.starts_with("SESSION_LOST:") && e.contains("transacción"), "{e}");
    assert_eq!(scalar(&mut g, "SELECT @@TRANCOUNT"), "0", "the session goes on, without the transaction");

    // A write is not repeated: it is not known whether it ran.
    g.execute("IF OBJECT_ID('dbo.celer_rc') IS NOT NULL DROP TABLE dbo.celer_rc; CREATE TABLE dbo.celer_rc (a int)", 10).unwrap();
    mssql_kill(&mut admin, &mut g);
    let e = g.execute("INSERT INTO dbo.celer_rc VALUES (1)", 10).unwrap_err().to_string();
    assert!(e.starts_with("CONN_RESET:"), "{e}");
    assert_eq!(scalar(&mut g, "SELECT COUNT(*) FROM dbo.celer_rc"), "0");

    // After a pause (suspension, VPN), the session is checked before use: the statement runs once, on the new one.
    let killed = mssql_kill(&mut admin, &mut g);
    g.pretend_idle(Duration::from_secs(300));
    let out = g.execute(MSSQL_CONN_ID, 10).unwrap();
    assert!(out.messages.first().is_some_and(|m| m.starts_with(RECOVERED) && m.contains("sin usarse")), "{:?}", out.messages);
    assert_ne!(txt(&out.results[0].rows[0][0]), killed, "otra conexión");

    // The interface's check (after the computer wakes up) reconnects too.
    mssql_kill(&mut admin, &mut g);
    let health = g.health(true);
    assert!(health.ok && health.reconnected && health.lost.is_empty(), "{health:?}");
    assert_eq!(scalar(&mut g, "SELECT 1"), "1");
    g.execute("DROP TABLE dbo.celer_rc", 10).unwrap();
}

/// Ends an Informix session from outside, as a DBA would with `onmode -z`: through the SQL admin API
/// (sysadmin:task) or with onmode in the container (CELER_INFORMIX_CONTAINER). false when neither works here.
fn informix_kill(admin: &mut dyn Driver, sid: &str) -> bool {
    let done = match admin.execute(&format!("EXECUTE FUNCTION task('onmode', 'z', '{sid}')"), 10) {
        Ok(out) => {
            eprintln!("task('onmode', 'z', {sid}): {:?}", out.results.first().map(|r| r.rows.iter().map(|row| row.iter().map(txt).collect::<Vec<_>>()).collect::<Vec<_>>()));
            true
        }
        Err(e) => {
            eprintln!("sysadmin:task no disponible ({e}); se prueba onmode en el contenedor");
            match std::env::var("CELER_INFORMIX_CONTAINER") {
                Ok(container) => {
                    let onmode = format!("onmode -z {sid}");
                    Command::new("docker").args(["exec", container.as_str(), "bash", "-lc", onmode.as_str()]).status().is_ok_and(|s| s.success())
                }
                Err(_) => false,
            }
        }
    };
    std::thread::sleep(Duration::from_millis(1500));
    done
}

/// The same for Informix (DRDA and JDBC): reconnection after `onmode -z`, the transaction never lost in silence, and
/// the generic pool (a session closed without state leaves its connection to the next one).
fn informix_reconnect_suite(via: &str, connect: &Connector, admin: &mut dyn Driver) {
    const SID: &str = "SELECT DBINFO('sessionid') FROM systables WHERE tabid = 1";
    let mut g = guarded(DbKind::Informix, connect, "", "celer");
    let sid = scalar(&mut g, SID);
    if !informix_kill(admin, &sid) {
        eprintln!("{via}: no se puede terminar una sesión en este servidor; sin prueba de reconexión");
        return;
    }
    let t0 = Instant::now();
    let out = g.execute(SID, 10).unwrap_or_else(|e| panic!("{via}: tras onmode -z → {e}"));
    eprintln!("{via}: sesión terminada con onmode -z: {} ms; {:?}", t0.elapsed().as_millis(), out.messages);
    assert_ne!(txt(&out.results[0].rows[0][0]), sid, "{via}: otra sesión");
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{via}: {:?}", out.messages);

    // Manual mode with work done: the transaction is lost with the session, and that is said.
    g.set_autocommit(false).unwrap();
    let sid = scalar(&mut g, SID);
    assert!(informix_kill(admin, &sid));
    let e = g.execute("SELECT COUNT(*) FROM systables", 10).unwrap_err().to_string();
    eprintln!("{via}, con transacción: {e}");
    assert!(e.starts_with("SESSION_LOST:") && e.contains("transacción"), "{via}: {e}");
    assert_eq!(scalar(&mut g, "SELECT 1 FROM systables WHERE tabid = 1"), "1", "{via}: the session goes on (still in manual mode)");
    g.rollback().unwrap();
    g.set_autocommit(true).unwrap();
    drop(g);

    // The pool: no new login for the next session of the same settings, unless the closed one had state.
    let key = format!("engine-test-informix-{via}");
    let mut a = guarded(DbKind::Informix, connect, &key, "celer");
    let sid_a = scalar(&mut a, SID);
    drop(a);
    let t0 = Instant::now();
    let mut b = guarded(DbKind::Informix, connect, &key, "celer");
    eprintln!("{via}: sesión nueva con la conexión libre de otra: {} ms", t0.elapsed().as_millis());
    assert!(b.reused, "{via}: la conexión libre se reutiliza");
    assert_eq!(scalar(&mut b, SID), sid_a, "{via}: misma sesión del servidor");
    b.set_autocommit(false).unwrap();
    drop(b);
    let c = guarded(DbKind::Informix, connect, &key, "celer");
    assert!(!c.reused, "{via}: una sesión en modo manual no deja su conexión");
    drop(c);
    crate::guard::pool_forget(&format!("engine-test-{key}"));
}

#[test]
fn informix_reconnects() {
    let Some((cfg, lib)) = informix_cfg() else { return };
    let mut admin_cfg = cfg.clone();
    admin_cfg.database = "sysadmin".into();
    let mut admin = crate::odbc_driver::OdbcDriver::connect(admin_cfg, lib.clone()).expect("conexión a sysadmin");
    let connect: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone())?) as Box<dyn Driver>) });
    informix_reconnect_suite("DRDA", &connect, &mut admin);
}

#[test]
fn informix_jdbc_reconnects() {
    let Some((cfg, rt)) = informix_jdbc_cfg() else { return };
    let mut admin_cfg = cfg.clone();
    admin_cfg.database = "sysadmin".into();
    let mut admin = crate::jdbc::connect(admin_cfg, rt.clone()).expect("conexión a sysadmin por JDBC");
    let connect: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::jdbc::connect(cfg.clone(), rt.clone())?) as Box<dyn Driver>) });
    informix_reconnect_suite("JDBC", &connect, &mut admin);
}

// ───────────────────────────────────────────────────────────────── the library on every engine

/// What the interface sends when one library script runs on a connection of `kind` («Ejecutar en…»), from
/// dev/library-sql.ts: the same saved entry everywhere, with its declared parameter (and, from the variables
/// feature on, its variables) resolved the way the console does it.
fn library_statements(input: serde_json::Value) -> Vec<Statement> {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/library-sql.ts");
    let node = std::env::var("CELER_NODE").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .args(["--experimental-strip-types", "--no-warnings", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node (CELER_NODE) para dev/library-sql.ts");
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "library-sql.ts: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

/// celer_lib_check (ids 1 to 3) in `schema` (or the session's default one), the library's statements, and clean up.
fn library_suite(d: &mut dyn Driver, kind: &str, schema: Option<&str>) {
    let table = match schema {
        Some(s) => format!("{s}.celer_lib_check"),
        None => "celer_lib_check".to_string(),
    };
    if let Some(s) = schema {
        d.execute(&format!("CREATE SCHEMA IF NOT EXISTS {s}"), 10).unwrap();
    }
    d.execute(&format!("DROP TABLE IF EXISTS {table}"), 10).unwrap();
    d.execute(&format!("CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY, nombre VARCHAR(40) NOT NULL)"), 10).unwrap();
    // One row per INSERT: Informix has no multi-row VALUES.
    for (id, name) in [(1, "uno"), (2, "dos"), (3, "tres")] {
        d.execute(&format!("INSERT INTO {table} (id, nombre) VALUES ({id}, '{name}')"), 10).unwrap();
    }
    let statements = library_statements(json!({ "kind": kind, "schema": schema, "table": table }));
    run_generated(d, &statements);
    // The MCP tools substitute ${variables} in the core (variables.rs): the same query, on the same engine.
    let kind_of = match kind {
        "postgres" => DbKind::Postgres,
        "mysql" => DbKind::Mysql,
        "mssql" => DbKind::Mssql,
        "sqlite" => DbKind::Sqlite,
        "informix" => DbKind::Informix,
        _ => DbKind::Odbc,
    };
    let vars: std::collections::HashMap<String, crate::variables::Var> = [
        ("tabla".to_string(), crate::variables::Var { value: table.clone(), raw: true }),
        ("desde".to_string(), crate::variables::Var { value: "2".into(), raw: false }),
    ]
    .into_iter()
    .collect();
    let sql = crate::variables::substitute("SELECT id, nombre FROM ${tabla} WHERE id >= ${desde} AND nombre <> '${desde}' ORDER BY id", kind_of, &vars);
    let (_, rows) = all_rows(d, &sql);
    assert_eq!(rows.len(), 2, "{sql}");
    println!("✓ MCP variables (core)");
    d.execute(&format!("DROP TABLE {table}"), 10).unwrap();
}

#[test]
fn library_postgres() {
    let Some(s) = spec("CELER_PG_TEST") else { return };
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Postgres;
    cfg.encryption = "off".into();
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = get(&s, "dbname");
    let mut d = crate::postgres::PostgresDriver::connect(cfg).expect("conexión PostgreSQL");
    // In a schema outside search_path: only the target's schema (SET search_path) makes the script find it.
    library_suite(&mut d, "postgres", Some("celer_lib"));
    d.execute("DROP SCHEMA celer_lib", 10).unwrap();
}

/// MySQL, and MariaDB in the second run of dev/wsl/engines.sh (it runs the tests named "mysql").
#[test]
fn library_mysql() {
    let Ok(url) = std::env::var("CELER_MYSQL_TEST") else { return };
    let rest = url.trim().trim_start_matches("mysql://");
    let (auth, hostdb) = rest.rsplit_once('@').expect("mysql://user:pass@host:port/db");
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let (hostport, db) = hostdb.split_once('/').unwrap_or((hostdb, ""));
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "3306"));
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Mysql;
    cfg.host = host.into();
    cfg.port = port.parse().ok();
    cfg.user = user.into();
    cfg.password = Some(pass.into());
    cfg.database = db.into();
    cfg.encryption = "login".into();
    let mut d = crate::mysql::MysqlDriver::connect(cfg).expect("conexión MySQL / MariaDB");
    println!("{}", d.server_info().unwrap_or_default());
    library_suite(&mut d, "mysql", None);
}

#[test]
fn library_sqlite() {
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Sqlite;
    cfg.id = "library-sqlite-test".into();
    cfg.file_path = ":memory:".into();
    let mut d = crate::sqlite::SqliteDriver::connect(cfg).expect("SQLite en memoria");
    library_suite(&mut d, "sqlite", None);
}

#[test]
fn library_mssql() {
    let Some(mut master) = mssql("master") else { return };
    master.execute("IF DB_ID('celer_test') IS NULL CREATE DATABASE celer_test", 10).unwrap();
    drop(master);
    let mut d = mssql("celer_test").unwrap();
    library_suite(&mut d, "mssql", None);
}

#[test]
fn library_informix() {
    let Some((cfg, lib)) = informix_cfg() else { return };
    let mut d = drda_connect(lib)(cfg).expect("conexión Informix por DRDA");
    library_suite(d.as_mut(), "informix", None);
}

/// Generic ODBC: CELER_ODBC_TEST is a connection string to any source (e.g. the PostgreSQL ODBC driver to the test
/// server: "Driver={PostgreSQL Unicode};Server=localhost;Port=15432;Database=celer;Uid=celer;Pwd=celer;").
#[test]
fn library_odbc() {
    let Ok(conn_str) = std::env::var("CELER_ODBC_TEST") else { return };
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Odbc;
    cfg.odbc_conn_str = conn_str;
    let mut d = crate::odbc_driver::OdbcDriver::connect(cfg, crate::odbc::system_manager().to_string()).expect("conexión ODBC");
    library_suite(&mut d, "odbc", None);
}

#[test]
fn library_informix_jdbc() {
    let Some((cfg, rt)) = informix_jdbc_cfg() else { return };
    let mut d = jdbc_connect(rt)(cfg).expect("conexión Informix por JDBC");
    library_suite(d.as_mut(), "informix", None);
}

// ───────────────────────────────────────────────────────────────── migration assistant (#102)

/// A data folder of its own (its known_hosts starts empty) with the Informix drivers of the environment in its
/// settings, as the app keeps them: what `lib.rs prepare` reads.
fn sample_store(name: &str) -> crate::store::Store {
    // The IBM CLI reads one db2dsdriver.cfg per process: the suite's (as informix_cfg), not this throwaway folder's.
    crate::drivers::use_cli_cfg_dir(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/target/celer-engine-tests")));
    let dir = std::env::temp_dir().join(format!("celer-sample-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jar = std::env::var_os("CELER_JDBC_JARS").and_then(|j| std::env::split_paths(&j).next()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let settings = json!({
        "ibmDriverPath": std::env::var("CELER_IBM_LIB").unwrap_or_default(),
        "javaPath": std::env::var("CELER_JAVA").unwrap_or_default(),
        "informixJdbcPath": jar,
    });
    std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
    crate::store::Store::new(dir)
}

/// The connections the migration assistant makes of the DBeaver and DbVisualizer samples (dev/fixtures/migrate, one
/// per engine of dev/wsl/compose.yml, printed by dev/migrate-sample.ts) open as imported, through lib.rs `prepare`,
/// and answer a query. ODBC needs the DSN CelerPG (a PostgreSQL ODBC data source); without it, it is skipped.
#[test]
fn migrated_connections_connect() {
    if spec("CELER_PG_TEST").is_none() {
        return;
    }
    let node = std::env::var("CELER_NODE").unwrap_or_else(|_| "node".into());
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/migrate-sample.ts");
    let out = Command::new(node).args(["--experimental-strip-types", "--no-warnings", script]).output().expect("node (CELER_NODE) para dev/migrate-sample.ts");
    assert!(out.status.success(), "migrate-sample.ts: {}", String::from_utf8_lossy(&out.stderr));
    let imported: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(imported.len(), 19, "9 de DBeaver y 10 de DbVisualizer");
    let store = sample_store("imported");
    let odbc_dsn = Command::new("odbcinst").args(["-q", "-s"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains("[CelerPG]")).unwrap_or(false);
    let mut failures = Vec::new();
    for item in imported {
        let tool = item["tool"].as_str().unwrap_or("").to_string();
        let mut cfg: ConnConfig = serde_json::from_value(item).expect("ConnConfig");
        let label = format!("{tool} «{}»", cfg.name);
        if cfg.kind == DbKind::Odbc && !odbc_dsn {
            eprintln!("⚠ {label}: sin el DSN CelerPG en este equipo");
            continue;
        }
        if cfg.kind == DbKind::Informix && cfg.informix_mode == "drda" && std::env::var("CELER_IBM_LIB").is_err() {
            eprintln!("⚠ {label}: sin el driver IBM CLI (CELER_IBM_LIB)");
            continue;
        }
        if cfg.ssh.enabled && spec("CELER_SSH_TEST").is_none() {
            eprintln!("⚠ {label}: sin el bastión SSH de prueba (CELER_SSH_TEST)");
            continue;
        }
        cfg.id = String::new();
        let probe = if cfg.kind == DbKind::Informix { "SELECT 1 FROM systables WHERE tabid = 1" } else { "SELECT 1" };
        let connect = || crate::prepare(&store, cfg.clone()).map_err(anyhow::Error::msg).and_then(|p| (p.connector)().map(|d| (d, p.route)));
        // Through SSH, each host key not seen yet is shown first; here the user trusts the test bastion's.
        let mut result = connect();
        for _ in 0..3 {
            let token = match &result {
                Err(e) if e.to_string().starts_with("SSH_HOST_UNKNOWN:") => e.to_string().split(':').nth(1).unwrap_or("").to_string(),
                _ => break,
            };
            crate::ssh::trust(&store.dir, &token).expect("confiar en la clave");
            result = connect();
        }
        match result {
            Ok((mut d, route)) => match d.execute(probe, 10) {
                Ok(out) => {
                    assert_eq!(txt(&out.results[0].rows[0][0]), "1", "{label}");
                    eprintln!("✔ {label}: {} {}", d.server_info().unwrap_or_default(), route);
                }
                Err(e) => failures.push(format!("{label}: {e}")),
            },
            Err(e) => failures.push(format!("{label}: {e}")),
        }
    }
    let _ = std::fs::remove_dir_all(&store.dir);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ───────────────────────────────────────────────────────────────── export with passwords (#101)

/// Export «con contraseñas» → import elsewhere, on every engine: the connections of the migration samples (one per
/// engine, two through the SSH bastion) with their passwords kept as the credential store keeps them; their secrets
/// collected and sealed with a passphrase as `export_secrets` does, opened as `open_secrets` does (a wrong passphrase
/// opens nothing), and given back to the connections as the interface does on import; each one then connects from a
/// fresh data folder without any password typed.
#[test]
fn migrated_passwords_connect_after_export_and_import() {
    if spec("CELER_PG_TEST").is_none() {
        return;
    }
    let node = std::env::var("CELER_NODE").unwrap_or_else(|_| "node".into());
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/migrate-sample.ts");
    let out = Command::new(node).args(["--experimental-strip-types", "--no-warnings", script]).output().expect("node (CELER_NODE) para dev/migrate-sample.ts");
    assert!(out.status.success(), "migrate-sample.ts: {}", String::from_utf8_lossy(&out.stderr));
    let samples: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    // The source machine: connections saved without secrets, the secrets in its credential store.
    let mut keyring = std::collections::HashMap::new();
    let mut conns = Vec::new();
    for (i, item) in samples.into_iter().filter(|i| i["tool"] == "dbeaver").enumerate() {
        let mut cfg: ConnConfig = serde_json::from_value(item).unwrap();
        cfg.id = format!("src-{i}");
        if let Some(p) = cfg.password.take().filter(|p| !p.is_empty()) {
            keyring.insert(cfg.id.clone(), p);
        }
        for account in crate::model::SshConfig::ACCOUNTS {
            if let Some(v) = cfg.ssh.secret_mut(account).take() {
                keyring.insert(crate::model::ssh_account(&cfg.id, account), v);
            }
        }
        conns.push(cfg);
    }
    let requests = conns.iter().map(|c| (c.id.clone(), None)).collect();
    let sets = crate::secrets::collect(&conns, requests, |account| keyring.get(account).cloned());
    let block = crate::secrets::seal(&sets, Some("una frase de exportación")).unwrap();
    let text = block.to_string();
    assert!(keyring.values().all(|secret| !text.contains(secret.as_str())), "no secret in clear");
    assert!(crate::secrets::open(&block, Some("otra")).unwrap_err().to_string().starts_with("SECRETS_PASSPHRASE:"));
    let opened = crate::secrets::open(&block, Some("una frase de exportación")).unwrap();

    // The other machine: a fresh data folder; each connection gets its secrets from the file, none typed.
    let fresh = sample_store("fresh-import");
    let odbc_dsn = Command::new("odbcinst").args(["-q", "-s"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains("[CelerPG]")).unwrap_or(false);
    let mut failures = Vec::new();
    for (index, mut cfg) in conns.into_iter().enumerate() {
        let label = format!("«{}»", cfg.name);
        if (cfg.kind == DbKind::Odbc && !odbc_dsn) || (cfg.ssh.enabled && spec("CELER_SSH_TEST").is_none()) || (cfg.informix_mode == "drda" && std::env::var("CELER_IBM_LIB").is_err()) {
            eprintln!("⚠ {label}: no disponible en este equipo");
            continue;
        }
        let set = opened.get(&index.to_string()).cloned().unwrap_or_default();
        assert!(cfg.kind == DbKind::Sqlite || set.password.is_some(), "{label}: su contraseña viaja en el fichero");
        cfg.id = String::new();
        cfg.password = set.password.clone();
        cfg.ssh.password = set.ssh_password.clone();
        cfg.ssh.passphrase = set.ssh_passphrase.clone();
        cfg.ssh.private_key = set.ssh_key.clone();
        let probe = if cfg.kind == DbKind::Informix { "SELECT 1 FROM systables WHERE tabid = 1" } else { "SELECT 1" };
        let connect = || crate::prepare(&fresh, cfg.clone()).map_err(anyhow::Error::msg).and_then(|p| (p.connector)());
        let mut result = connect();
        // A new machine has not seen the bastion's key: shown and trusted once, as in the app.
        while let Err(e) = &result {
            let text = e.to_string();
            let Some(token) = text.strip_prefix("SSH_HOST_UNKNOWN:").and_then(|t| t.split(':').next()) else { break };
            crate::ssh::trust(&fresh.dir, token).unwrap();
            result = connect();
        }
        match result.and_then(|mut d| d.execute(probe, 10)) {
            Ok(out) => {
                assert_eq!(txt(&out.results[0].rows[0][0]), "1", "{label}");
                eprintln!("✔ {label}: conecta tras importar, sin escribir contraseñas");
            }
            Err(e) => failures.push(format!("{label}: {e}")),
        }
    }
    let _ = std::fs::remove_dir_all(&fresh.dir);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ───────────────────────────────────────────────────────────────── SSH tunnels (ssh.rs)
//   CELER_SSH_TEST="host=localhost port=2222 user=celer password=celer key=<private key> container=celer-sshd
//                   pg=celer-pg:5432 mysql=celer-mysql:3306 mariadb=celer-mariadb:3306 mssql=celer-mssql:1433 ifx=celer-ifx"
// The engine addresses only resolve inside the Docker network of dev/wsl/compose.yml: the tunnel is the only route.

/// One engine reached through the bastion: its settings with the target as the bastion sees it.
struct Tunnelled {
    name: &'static str,
    cfg: ConnConfig,
    probe: &'static str,
}

fn ssh_spec() -> Option<Vec<(String, String)>> {
    spec("CELER_SSH_TEST")
}

fn split_target(text: &str, default_port: u16) -> (String, Option<u16>) {
    match text.split_once(':') {
        Some((host, port)) => (host.into(), port.parse().ok()),
        None => (text.into(), Some(default_port)),
    }
}

/// Every engine of the environment, through the tunnel, authenticated with the test key.
fn tunnelled_engines(s: &[(String, String)]) -> Vec<Tunnelled> {
    let ssh = crate::model::SshConfig {
        enabled: true,
        host: get(s, "host"),
        port: get(s, "port").parse().ok(),
        user: get(s, "user"),
        auth: "key".into(),
        key_path: get(s, "key"),
        ..Default::default()
    };
    let mut out = Vec::new();
    let mut add = |name: &'static str, mut cfg: ConnConfig, target: &str, port: u16, probe: &'static str| {
        let (host, p) = split_target(target, port);
        cfg.id = format!("ssh-test-{name}");
        cfg.host = host;
        cfg.port = p;
        cfg.ssh = ssh.clone();
        out.push(Tunnelled { name, cfg, probe });
    };
    if let Some(pg) = spec("CELER_PG_TEST") {
        let cfg = ConnConfig { kind: DbKind::Postgres, user: get(&pg, "user"), password: Some(get(&pg, "password")), database: get(&pg, "dbname"), encryption: "off".into(), ..Default::default() };
        add("PostgreSQL", cfg, &get(s, "pg"), 5432, "SELECT 1");
    }
    if let Some(url) = std::env::var("CELER_MYSQL_TEST").ok().and_then(|u| u.strip_prefix("mysql://").map(str::to_string)) {
        let (auth, rest) = url.rsplit_once('@').unwrap_or(("", ""));
        let (user, password) = auth.split_once(':').unwrap_or((auth, ""));
        let database = rest.split_once('/').map(|(_, d)| d).unwrap_or("");
        let cfg = ConnConfig { kind: DbKind::Mysql, user: user.into(), password: Some(password.into()), database: database.into(), encryption: "login".into(), ..Default::default() };
        add("MySQL", cfg.clone(), &get(s, "mysql"), 3306, "SELECT 1");
        add("MariaDB", cfg, &get(s, "mariadb"), 3306, "SELECT 1");
    }
    if let Some(cfg) = mssql_cfg("master") {
        add("SQL Server", cfg, &get(s, "mssql"), 1433, "SELECT 1");
    }
    if let Some((mut cfg, _)) = informix_cfg() {
        cfg.informix_mode = "drda".into();
        add("Informix DRDA", cfg, &format!("{}:9089", get(s, "ifx")), 9089, "SELECT 1 FROM systables WHERE tabid = 1");
    }
    if let Some((cfg, _)) = informix_jdbc_cfg() {
        add("Informix JDBC", cfg, &format!("{}:9088", get(s, "ifx")), 9088, "SELECT 1 FROM systables WHERE tabid = 1");
    }
    out.retain(|t| !t.cfg.host.is_empty());
    out
}

/// The connector the app would use (lib.rs `prepare`).
fn ssh_prepared(store: &crate::store::Store, cfg: &ConnConfig) -> crate::Prepared {
    crate::prepare(store, cfg.clone()).unwrap_or_else(|e| panic!("{}: {e}", cfg.name))
}

/// The bastion's host key is unknown to a new data folder: nothing connects until it is trusted. Returns whether it
/// had to be trusted (the user's own ~/.ssh/known_hosts may know it already).
fn trust_bastion(store: &crate::store::Store, cfg: &ConnConfig) -> bool {
    let prepared = ssh_prepared(store, cfg);
    match (prepared.connector)() {
        Ok(_) => false,
        Err(e) => {
            let text = e.to_string();
            assert!(text.starts_with("SSH_HOST_UNKNOWN:"), "la primera vez, la clave es desconocida: {text}");
            let token = text.split(':').nth(1).unwrap().to_string();
            let info = crate::ssh::pending_info(&token).expect("clave pendiente");
            assert!(info.fingerprint.starts_with("SHA256:"), "{info:?}");
            assert!(text.contains(&info.fingerprint), "the error shows the fingerprint: {text}");
            crate::ssh::trust(&store.dir, &token).expect("confiar en la clave");
            true
        }
    }
}

/// Every network engine through the bastion: the host key is not accepted until trusted, each engine connects only
/// through the tunnel (its address does not resolve outside Docker), the sessions of a connection share one tunnel,
/// «Probar conexión» reports the SSH steps apart, and a restarted bastion is crossed again on the next query.
#[test]
fn ssh_tunnel_every_engine() {
    let Some(s) = ssh_spec() else { return };
    let engines = tunnelled_engines(&s);
    assert!(!engines.is_empty(), "CELER_SSH_TEST sin motores de prueba");
    let store = sample_store("engines");
    let trusted = trust_bastion(&store, &engines[0].cfg);
    eprintln!("SSH: clave del bastión {}", if trusted { "confirmada por el usuario" } else { "ya conocida en ~/.ssh/known_hosts" });

    let mut sessions = Vec::new();
    for t in &engines {
        // Not reachable without the tunnel.
        let host = t.cfg.host.clone();
        assert!(std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), 1)).is_err(), "{}: {host} no debe resolverse fuera de Docker", t.name);

        // «Probar conexión»: SSH, forward, login and database, each apart.
        let prepared = ssh_prepared(&store, &t.cfg);
        assert!(prepared.route.contains("túnel SSH"), "{}: {}", t.name, prepared.route);
        let report = crate::probe::run(&t.cfg, prepared.connector.clone(), &prepared.route, prepared.ssh.as_deref());
        let steps: Vec<(&str, &str)> = report.steps.iter().map(|s| (s.id, s.status)).collect();
        assert!(report.ok, "{}: {steps:?} {}", t.name, report.error);
        assert_eq!(steps, [("ssh", "ok"), ("forward", "ok"), ("login", "ok"), ("database", "ok")], "{}", t.name);

        // Two sessions of the connection, one tunnel.
        let key = if t.cfg.kind == DbKind::Mssql { String::new() } else { prepared.key.clone() };
        let mut a = guarded(t.cfg.kind, &prepared.connector, &key, "");
        let mut b = guarded(t.cfg.kind, &prepared.connector, &key, "");
        assert_eq!(scalar(&mut a, t.probe), "1", "{}", t.name);
        assert_eq!(scalar(&mut b, t.probe), "1", "{}", t.name);
        let plan = prepared.ssh.clone().unwrap();
        let port = plan.tunnel().unwrap().local_port;
        assert_eq!(plan.tunnel().unwrap().local_port, port, "{}: un túnel por conexión", t.name);
        eprintln!("SSH ✔ {}: por el túnel (puerto local {port}) · {}", t.name, report.steps[0].detail);
        sessions.push((t, a, b, key));
    }

    // The bastion restarts: every tunnel drops; the next query brings tunnel and session back (reads are repeated).
    let container = get(&s, "container");
    if !container.is_empty() {
        let restarted = Command::new("docker").args(["restart", &container]).output().expect("docker restart");
        assert!(restarted.status.success(), "{}", String::from_utf8_lossy(&restarted.stderr));
        std::thread::sleep(Duration::from_millis(1500));
        for (t, a, _, _) in &mut sessions {
            let t0 = Instant::now();
            let out = a.execute(t.probe, 10).unwrap_or_else(|e| panic!("{} tras reiniciar el bastión: {e}", t.name));
            eprintln!("SSH ✔ {}: túnel y sesión recuperados en {} ms {:?}", t.name, t0.elapsed().as_millis(), out.messages);
            assert_eq!(txt(&out.results[0].rows[0][0]), "1", "{}", t.name);
        }
    }
    for (_, a, b, key) in sessions {
        drop(a);
        drop(b);
        crate::guard::pool_forget(&format!("engine-test-{key}"));
    }
    let _ = std::fs::remove_dir_all(&store.dir);
}

/// Password authentication, a jump host (the bastion through itself), a forward the bastion refuses and a host key
/// that changed: each says which step failed and why.
#[test]
fn ssh_tunnel_auth_jumps_and_refusals() {
    let Some(s) = ssh_spec() else { return };
    let Some(first) = tunnelled_engines(&s).into_iter().next() else { return };
    let store = sample_store("auth");
    trust_bastion(&store, &first.cfg);

    // Password, and a chain: localhost:2222 → the same sshd as seen from inside (127.0.0.1:22).
    let mut cfg = first.cfg.clone();
    cfg.id = "ssh-test-password".into();
    cfg.ssh.auth = "password".into();
    cfg.ssh.key_path.clear();
    cfg.ssh.password = Some(get(&s, "password"));
    cfg.ssh.jumps = vec![format!("{}@{}:{}", get(&s, "user"), get(&s, "host"), get(&s, "port"))];
    cfg.ssh.host = "127.0.0.1".into();
    cfg.ssh.port = Some(22);
    // The inner hop has a key of its own (127.0.0.1:22 for Celer): trusted like the first.
    let prepared = ssh_prepared(&store, &cfg);
    if let Err(e) = (prepared.connector)() {
        let text = e.to_string();
        assert!(text.starts_with("SSH_HOST_UNKNOWN:") && text.contains("127.0.0.1:22"), "{text}");
        crate::ssh::trust(&store.dir, text.split(':').nth(1).unwrap()).unwrap();
    }
    let prepared = ssh_prepared(&store, &cfg);
    let report = crate::probe::run(&cfg, prepared.connector.clone(), &prepared.route, prepared.ssh.as_deref());
    assert!(report.ok, "{:?} {}", report.steps, report.error);
    assert!(report.steps[0].detail.contains("→") && report.steps[0].detail.contains("contraseña"), "{}", report.steps[0].detail);
    eprintln!("SSH ✔ contraseña y salto: {}", report.steps[0].detail);

    // The SSH agent (ssh-agent here; Pageant or the OpenSSH agent on Windows) holding the test key.
    #[cfg(unix)]
    if Command::new("ssh-agent").arg("-h").output().is_ok() {
        let sock = std::env::temp_dir().join(format!("celer-ssh-agent-{}", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let mut agent = Command::new("ssh-agent").arg("-D").arg("-a").arg(&sock).stdout(Stdio::null()).spawn().expect("ssh-agent");
        for _ in 0..50 {
            if sock.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let added = Command::new("ssh-add").arg(get(&s, "key")).env("SSH_AUTH_SOCK", &sock).output().expect("ssh-add");
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
        std::env::set_var("SSH_AUTH_SOCK", &sock);
        let mut by_agent = first.cfg.clone();
        by_agent.id = "ssh-test-agent".into();
        by_agent.ssh.auth = "agent".into();
        by_agent.ssh.key_path.clear();
        let prepared = ssh_prepared(&store, &by_agent);
        let report = crate::probe::run(&by_agent, prepared.connector.clone(), &prepared.route, prepared.ssh.as_deref());
        let _ = agent.kill();
        std::env::remove_var("SSH_AUTH_SOCK");
        let _ = std::fs::remove_file(&sock);
        assert!(report.ok, "{:?} {}", report.steps, report.error);
        assert!(report.steps[0].detail.contains("agente SSH"), "{}", report.steps[0].detail);
        eprintln!("SSH ✔ agente: {}", report.steps[0].detail);
    }

    // A wrong password: the SSH step fails, the database is not tried.
    let mut wrong = cfg.clone();
    wrong.id = "ssh-test-wrong".into();
    wrong.ssh.password = Some("mala".into());
    let prepared = ssh_prepared(&store, &wrong);
    let report = crate::probe::run(&wrong, prepared.connector.clone(), &prepared.route, prepared.ssh.as_deref());
    assert_eq!(report.steps.iter().map(|s| (s.id, s.status)).collect::<Vec<_>>(), [("ssh", "failed")], "{}", report.error);
    assert!(report.error.contains("no aceptó la autenticación"), "{}", report.error);

    // A port nobody listens on behind the bastion: the forward step fails, the SSH one is fine.
    let mut closed = first.cfg.clone();
    closed.id = "ssh-test-closed".into();
    closed.port = Some(1);
    let prepared = ssh_prepared(&store, &closed);
    let report = crate::probe::run(&closed, prepared.connector.clone(), &prepared.route, prepared.ssh.as_deref());
    assert_eq!(report.steps.iter().map(|s| (s.id, s.status)).collect::<Vec<_>>(), [("ssh", "ok"), ("forward", "failed")], "{}", report.error);
    // And a session through it says it was the forward.
    let e = (prepared.connector)().err().expect("sin servidor detrás").to_string();
    assert!(e.contains("no pudo abrir la conexión"), "{e}");

    // Another key kept for the bastion: refused, never replaced in silence.
    let changed = sample_store("changed");
    let other_key = "AAAAC3NzaC1lZDI1NTE5AAAAIC41+NZJQtVUMQCd674m8Rz7ExbU516UV7jdMruaJXwy";
    let known = |host: &str, port: &str| if port == "22" { host.to_string() } else { format!("[{host}]:{port}") };
    std::fs::write(changed.dir.join("known_hosts"), format!("{} ssh-ed25519 {other_key}\n", known(&get(&s, "host"), &get(&s, "port")))).unwrap();
    let mut cfg = first.cfg.clone();
    cfg.id = "ssh-test-changed".into();
    let e = (ssh_prepared(&changed, &cfg).connector)().err().expect("clave cambiada").to_string();
    assert!(e.starts_with("SSH_HOST_CHANGED: ") && e.contains("known_hosts, línea 1"), "{e}");
    eprintln!("SSH ✔ clave cambiada rechazada: {e}");
    let _ = std::fs::remove_dir_all(&changed.dir);
    let _ = std::fs::remove_dir_all(&store.dir);
}

// ───────────────────────────────────────────────────────────────── a schema's foreign keys at once (#98)

use crate::model::SchemaForeignKey;

/// A foreign key as a comparable tuple: the two tables (database, schema, name), its name and both column lists.
type FkTuple = ([String; 3], String, Vec<String>, [String; 3], Vec<String>);

fn fk_tuples(keys: &[SchemaForeignKey]) -> Vec<FkTuple> {
    let obj = |o: &ObjectRef| [o.database.clone(), o.schema.clone(), o.name.clone()];
    let mut out: Vec<FkTuple> = keys.iter().map(|k| (obj(&k.table), k.name.clone(), k.columns.clone(), obj(&k.target), k.target_columns.clone())).collect();
    out.sort();
    out
}

/// The schema's foreign keys read in one catalog query are exactly the ones the explorer gives table by table (its
/// "fks" folder of each table: what the E-R diagram read before), and the SQL joining each key's tables column pair
/// by column pair, written for the dialect by dev/engine-sql.ts, finds every row that has the key set.
fn assert_schema_fks(d: &mut dyn Driver, kind: &str, path: &[&str]) -> Vec<SchemaForeignKey> {
    let path: Vec<String> = path.iter().map(|s| s.to_string()).collect();
    let t0 = Instant::now();
    let one = d.schema_foreign_keys(&path).unwrap_or_else(|e| panic!("{kind} {path:?}: {e}"));
    let one_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let each = crate::session::per_table_foreign_keys(d, &path).unwrap();
    println!("{kind} {path:?}: {} claves en una consulta ({one_ms} ms); tabla a tabla, {} ms", one.len(), t1.elapsed().as_millis());
    assert_eq!(fk_tuples(&one), fk_tuples(&each), "{kind} {path:?}: una consulta frente a tabla a tabla");
    // The joins the diagram's edges stand for, as the dialect writes them.
    let shape: Vec<serde_json::Value> = one
        .iter()
        .map(|k| {
            let (columns, target_columns): (Vec<String>, Vec<String>) = (k.columns.iter().map(|c| d.quote_ident(c)).collect(), k.target_columns.iter().map(|c| d.quote_ident(c)).collect());
            let (qualified, target) = (d.qualified_name(&k.table), d.qualified_name(&k.target));
            let set = columns.iter().map(|c| format!("{c} IS NOT NULL")).collect::<Vec<_>>().join(" AND ");
            let rows: usize = scalar(d, &format!("SELECT COUNT(*) FROM {qualified} WHERE {set}")).trim().parse().unwrap();
            json!({ "name": k.name, "qualified": qualified, "columns": columns, "targetQualified": target, "targetColumns": target_columns, "rows": rows })
        })
        .collect();
    run_generated(d, &generated(json!({ "kind": kind, "fks": shape })));
    one
}

/// The keys of the fixture every engine gets: a composite key whose order is not the table's column order, a key to
/// the table itself and one to a table of another schema (or database).
fn assert_fixture_keys(keys: &[SchemaForeignKey], hijo: &str, other: &str) {
    let find = |table: &str, cols: &[&str]| keys.iter().find(|k| k.table.name.eq_ignore_ascii_case(table) && k.columns.iter().map(|c| c.to_lowercase()).eq(cols.iter().map(|c| c.to_string())));
    let composite = find(hijo, &["x", "y"]).unwrap_or_else(|| panic!("clave compuesta de {hijo}: {keys:#?}"));
    assert_eq!(composite.target_columns.iter().map(|c| c.to_lowercase()).collect::<Vec<_>>(), ["b", "a"], "en el orden de la clave");
    assert!(composite.target.name.to_lowercase().ends_with("padre"));
    let own = find(hijo, &["jefe"]).expect("clave a la propia tabla");
    assert_eq!(own.target.name, own.table.name);
    let outside = keys.iter().find(|k| k.target.name.eq_ignore_ascii_case(other)).unwrap_or_else(|| panic!("clave a {other}: {keys:#?}"));
    assert_ne!((&outside.target.database, &outside.target.schema), (&outside.table.database, &outside.table.schema), "{outside:?}");
}

fn pg_cfg() -> Option<ConnConfig> {
    let s = spec("CELER_PG_TEST")?;
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Postgres;
    cfg.encryption = "off".into();
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = get(&s, "dbname");
    Some(cfg)
}

fn mysql_cfg() -> Option<ConnConfig> {
    let url = std::env::var("CELER_MYSQL_TEST").ok()?;
    let rest = url.trim().strip_prefix("mysql://")?;
    let (auth, hostdb) = rest.rsplit_once('@')?;
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let (hostport, db) = hostdb.split_once('/').unwrap_or((hostdb, ""));
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "3306"));
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Mysql;
    cfg.host = host.into();
    cfg.port = port.parse().ok();
    cfg.user = user.into();
    cfg.password = Some(pass.into());
    cfg.database = db.into();
    cfg.encryption = "login".into();
    Some(cfg)
}

#[test]
fn pg_schema_foreign_keys() {
    let Some(cfg) = pg_cfg() else { return };
    let mut d = crate::postgres::PostgresDriver::connect(cfg).expect("conexión PostgreSQL");
    let d: &mut dyn Driver = &mut d;
    d.execute(
        "DROP SCHEMA IF EXISTS celer_fk CASCADE; CREATE SCHEMA celer_fk;
         CREATE TABLE celer_fk.padre (a int NOT NULL, b varchar(10) NOT NULL, nombre text, PRIMARY KEY (b, a));
         CREATE TABLE celer_fk.\"Hijo Raro\" (id int PRIMARY KEY, y int, x varchar(10), jefe int REFERENCES celer_fk.\"Hijo Raro\"(id),
           CONSTRAINT hijo_padre FOREIGN KEY (x, y) REFERENCES celer_fk.padre (b, a));
         CREATE TABLE celer_fk.nieto (id int PRIMARY KEY, hijo int REFERENCES celer_fk.\"Hijo Raro\"(id), cliente bigint REFERENCES public.customers(id));
         INSERT INTO celer_fk.padre VALUES (1, 'uno', 'P1'), (2, 'dos', 'P2');
         INSERT INTO celer_fk.\"Hijo Raro\" VALUES (1, 1, 'uno', NULL), (2, 2, 'dos', 1), (3, NULL, NULL, 1);
         INSERT INTO celer_fk.nieto VALUES (1, 1, (SELECT min(id) FROM public.customers)), (2, NULL, NULL);",
        10,
    )
    .unwrap();
    // A key to a partitioned table, from a plain table and from a partitioned one (#139): PostgreSQL keeps a copy of
    // it per partition of the referenced table, which is not a key of its own.
    d.execute(
        "CREATE TABLE celer_fk.part (id int, k int, PRIMARY KEY (id, k)) PARTITION BY RANGE (k);
         CREATE TABLE celer_fk.part1 PARTITION OF celer_fk.part FOR VALUES FROM (0) TO (10);
         CREATE TABLE celer_fk.part2 PARTITION OF celer_fk.part FOR VALUES FROM (10) TO (20);
         CREATE TABLE celer_fk.ref_part (id int PRIMARY KEY, pid int, pk int, FOREIGN KEY (pid, pk) REFERENCES celer_fk.part (id, k));
         CREATE TABLE celer_fk.ref_part_p (id int, pid int, pk int, FOREIGN KEY (pid, pk) REFERENCES celer_fk.part (id, k)) PARTITION BY RANGE (id);
         CREATE TABLE celer_fk.ref_part_p1 PARTITION OF celer_fk.ref_part_p FOR VALUES FROM (0) TO (10);
         INSERT INTO celer_fk.part VALUES (1, 1), (2, 12);
         INSERT INTO celer_fk.ref_part VALUES (1, 1, 1), (2, 2, 12);
         INSERT INTO celer_fk.ref_part_p VALUES (1, 2, 12);",
        10,
    )
    .unwrap();
    let keys = assert_schema_fks(d, "postgres", &["celer", "celer_fk"]);
    assert_fixture_keys(&keys, "Hijo Raro", "customers");
    for table in ["ref_part", "ref_part_p"] {
        let to_part: Vec<_> = keys.iter().filter(|k| k.table.name == table).collect();
        assert_eq!(to_part.len(), 1, "{table}: {to_part:#?}");
        assert_eq!(to_part[0].target.name, "part");
        let tables = |t: &str| vec!["celer".to_string(), "celer_fk".into(), "tables".into(), t.into(), "fks".into()];
        assert_eq!(d.children(&tables(table)).unwrap().len(), 1, "{table}: explorer");
    }
    // A partition keeps the key it inherits; its table DDL has it once.
    let part_fks = d.children(&["celer".to_string(), "celer_fk".into(), "tables".into(), "ref_part_p1".into(), "fks".into()]).unwrap();
    assert_eq!(part_fks.len(), 1, "{part_fks:#?}");
    let ddl = d.ddl(&ObjectRef::new("celer", "celer_fk", "ref_part", "table")).unwrap();
    assert_eq!(ddl.matches("FOREIGN KEY").count(), 1, "{ddl}");
    // The DDL runs: in a fresh schema, against a copy of the partitioned table.
    let fresh = ddl.replace("\"celer_fk\".", "\"celer_fk2\".").replace("celer_fk.", "celer_fk2.");
    d.execute(
        &format!(
            "DROP SCHEMA IF EXISTS celer_fk2 CASCADE; CREATE SCHEMA celer_fk2;
             CREATE TABLE celer_fk2.part (id int, k int, PRIMARY KEY (id, k)) PARTITION BY RANGE (k);
             CREATE TABLE celer_fk2.part1 PARTITION OF celer_fk2.part FOR VALUES FROM (0) TO (10);
             CREATE TABLE celer_fk2.part2 PARTITION OF celer_fk2.part FOR VALUES FROM (10) TO (20);
             {fresh}"
        ),
        10,
    )
    .unwrap_or_else(|e| panic!("{fresh}\n→ {e}"));
    d.execute("DROP SCHEMA celer_fk2 CASCADE", 10).unwrap();
    for schema in ["public", "sales"] {
        assert_schema_fks(d, "postgres", &["celer", schema]);
    }
}

#[test]
fn mysql_schema_foreign_keys() {
    let Some(cfg) = mysql_cfg() else { return };
    let db = cfg.database.clone();
    let mut d = crate::mysql::MysqlDriver::connect(cfg).expect("conexión MySQL/MariaDB");
    let d: &mut dyn Driver = &mut d;
    let info = d.server_info().unwrap();
    d.execute(
        "DROP TABLE IF EXISTS fk98_nieto; DROP TABLE IF EXISTS fk98_hijo; DROP TABLE IF EXISTS fk98_padre;
         CREATE TABLE fk98_padre (a INT NOT NULL, b VARCHAR(10) NOT NULL, nombre VARCHAR(20), PRIMARY KEY (b, a));
         CREATE TABLE fk98_hijo (id INT PRIMARY KEY, y INT, x VARCHAR(10), jefe INT,
           CONSTRAINT fk98_hijo_jefe FOREIGN KEY (jefe) REFERENCES fk98_hijo (id),
           CONSTRAINT fk98_hijo_padre FOREIGN KEY (x, y) REFERENCES fk98_padre (b, a));
         CREATE TABLE fk98_nieto (id INT PRIMARY KEY, hijo INT, CONSTRAINT fk98_nieto_hijo FOREIGN KEY (hijo) REFERENCES fk98_hijo (id));
         INSERT INTO fk98_padre VALUES (1, 'uno', 'P1'), (2, 'dos', 'P2');
         INSERT INTO fk98_hijo VALUES (1, 1, 'uno', NULL), (2, 2, 'dos', 1), (3, NULL, NULL, 1);
         INSERT INTO fk98_nieto VALUES (1, 1), (2, NULL);",
        10,
    )
    .unwrap();
    let keys = assert_schema_fks(d, "mysql", &[&db, &db]);
    println!("{info}");
    // The seed's second database ("shop") has keys of its own; a key to another database is drawn to it.
    let composite = keys.iter().find(|k| k.name == "fk98_hijo_padre").expect("clave compuesta");
    assert_eq!((composite.columns.join(","), composite.target_columns.join(",")), ("x,y".into(), "b,a".into()));
    assert!(keys.iter().any(|k| k.name == "fk98_hijo_jefe" && k.target.name == "fk98_hijo"));
    if d.databases().unwrap().iter().any(|n| n == "shop") {
        assert_schema_fks(d, "mysql", &["shop", "shop"]);
    }
    d.execute("DROP TABLE fk98_nieto; DROP TABLE fk98_hijo; DROP TABLE fk98_padre", 10).unwrap();
}

#[test]
fn mssql_schema_foreign_keys() {
    let Some(mut master) = mssql("master") else { return };
    master.execute("IF DB_ID('celer_test') IS NULL CREATE DATABASE celer_test", 10).unwrap();
    drop(master);
    let mut d = mssql("celer_test").unwrap();
    let d: &mut dyn Driver = &mut d;
    d.execute(
        "IF SCHEMA_ID('fk98') IS NULL EXEC('CREATE SCHEMA fk98');
         IF OBJECT_ID('fk98.nieto') IS NOT NULL DROP TABLE fk98.nieto;
         IF OBJECT_ID('fk98.[Hijo Raro]') IS NOT NULL DROP TABLE fk98.[Hijo Raro];
         IF OBJECT_ID('fk98.padre') IS NOT NULL DROP TABLE fk98.padre;
         IF OBJECT_ID('dbo.fk98_otro') IS NOT NULL DROP TABLE dbo.fk98_otro;
         CREATE TABLE dbo.fk98_otro (id int PRIMARY KEY);
         CREATE TABLE fk98.padre (a int NOT NULL, b nvarchar(10) NOT NULL, nombre nvarchar(20), CONSTRAINT pk_fk98_padre PRIMARY KEY (b, a));
         CREATE TABLE fk98.[Hijo Raro] (id int PRIMARY KEY, y int, x nvarchar(10), jefe int CONSTRAINT hijo_jefe REFERENCES fk98.[Hijo Raro](id),
           CONSTRAINT hijo_padre FOREIGN KEY (x, y) REFERENCES fk98.padre (b, a));
         CREATE TABLE fk98.nieto (id int PRIMARY KEY, hijo int CONSTRAINT nieto_hijo REFERENCES fk98.[Hijo Raro](id), otro int CONSTRAINT nieto_otro REFERENCES dbo.fk98_otro(id));
         INSERT INTO dbo.fk98_otro VALUES (7);
         INSERT INTO fk98.padre VALUES (1, N'uno', N'P1'), (2, N'dos', N'P2');
         INSERT INTO fk98.[Hijo Raro] VALUES (1, 1, N'uno', NULL), (2, 2, N'dos', 1), (3, NULL, NULL, 1);
         INSERT INTO fk98.nieto VALUES (1, 1, 7), (2, NULL, NULL);",
        10,
    )
    .unwrap();
    let keys = assert_schema_fks(d, "mssql", &["celer_test", "fk98"]);
    assert_fixture_keys(&keys, "Hijo Raro", "fk98_otro");
    assert_schema_fks(d, "mssql", &["celer_test", "dbo"]);
    // The seeded demo database, when it is there.
    if d.databases().unwrap().iter().any(|n| n == "celerdemo") {
        assert_schema_fks(d, "mssql", &["celerdemo", "dbo"]);
    }
}

#[test]
fn sqlite_schema_foreign_keys() {
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Sqlite;
    cfg.file_path = ":memory:".into();
    let mut d = crate::sqlite::SqliteDriver::connect(cfg).expect("SQLite en memoria");
    let d: &mut dyn Driver = &mut d;
    d.execute(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE padre (a INTEGER NOT NULL, b TEXT NOT NULL, nombre TEXT, PRIMARY KEY (b, a));
         CREATE TABLE \"Hijo Raro\" (id INTEGER PRIMARY KEY, y INTEGER, x TEXT, jefe INTEGER REFERENCES \"Hijo Raro\"(id),
           CONSTRAINT hijo_padre FOREIGN KEY (x, y) REFERENCES padre (b, a));
         CREATE TABLE nieto (id INTEGER PRIMARY KEY, hijo INTEGER REFERENCES \"Hijo Raro\", p_b TEXT, p_a INTEGER,
           FOREIGN KEY (p_b, p_a) REFERENCES padre);
         INSERT INTO padre VALUES (1, 'uno', 'P1'), (2, 'dos', 'P2');
         INSERT INTO \"Hijo Raro\" VALUES (1, 1, 'uno', NULL), (2, 2, 'dos', 1), (3, NULL, NULL, 1);
         INSERT INTO nieto VALUES (1, 1, 'dos', 2), (2, NULL, NULL, NULL);",
        10,
    )
    .unwrap();
    let keys = assert_schema_fks(d, "sqlite", &["main", "main"]);
    let composite = keys.iter().find(|k| k.table.name == "Hijo Raro" && k.columns.len() == 2).expect("clave compuesta");
    assert_eq!((composite.columns.clone(), composite.target_columns.clone()), (vec!["x".to_string(), "y".into()], vec!["b".to_string(), "a".into()]));
    // REFERENCES without columns: the referenced table's primary key, in its order.
    let implicit = keys.iter().find(|k| k.table.name == "nieto" && k.target.name == "padre").expect("clave sin columnas");
    assert_eq!(implicit.target_columns, ["b", "a"]);
    assert!(keys.iter().any(|k| k.table.name == "nieto" && k.target.name == "Hijo Raro" && k.target_columns == ["id"]));
}

/// Generic ODBC against PostgreSQL's ODBC driver (psqlODBC), when CELER_ODBC_TEST gives its connection string and
/// CELER_ODBC_LIB the driver manager (unixODBC's libodbc.so.2; odbc32.dll on Windows).
#[test]
fn odbc_schema_foreign_keys() {
    let (Ok(conn), Ok(lib)) = (std::env::var("CELER_ODBC_TEST"), std::env::var("CELER_ODBC_LIB")) else { return };
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Odbc;
    cfg.odbc_conn_str = conn;
    let mut d = crate::odbc_driver::OdbcDriver::connect(cfg, lib).expect("conexión ODBC");
    let d: &mut dyn Driver = &mut d;
    println!("ODBC: {}", d.server_info().unwrap());
    let keys = assert_schema_fks(d, "odbc", &[]);
    assert!(!keys.is_empty(), "las claves de la fuente");
}

/// Informix (DRDA and JDBC): the fixture's keys in database celer, compared with the per-table reading.
fn informix_schema_fks(via: &str, d: &mut dyn Driver) {
    d.execute(
        "DROP TABLE IF EXISTS fk98_nieto; DROP TABLE IF EXISTS fk98_hijo; DROP TABLE IF EXISTS fk98_padre; DROP TABLE IF EXISTS fk98_otro;
         CREATE TABLE fk98_padre (a INT NOT NULL, b VARCHAR(10) NOT NULL, nombre VARCHAR(20), PRIMARY KEY (b, a) CONSTRAINT fk98_padre_pk);
         CREATE TABLE fk98_hijo (id INT PRIMARY KEY, y INT, x VARCHAR(10), jefe INT,
           FOREIGN KEY (jefe) REFERENCES fk98_hijo (id) CONSTRAINT fk98_hijo_jefe,
           FOREIGN KEY (x, y) REFERENCES fk98_padre (b, a) CONSTRAINT fk98_hijo_padre);
         CREATE TABLE fk98_nieto (id INT PRIMARY KEY, hijo INT REFERENCES fk98_hijo (id) CONSTRAINT fk98_nieto_hijo);
         INSERT INTO fk98_padre VALUES (1, 'uno', 'P1');
         INSERT INTO fk98_padre VALUES (2, 'dos', 'P2');
         INSERT INTO fk98_hijo VALUES (1, 1, 'uno', NULL);
         INSERT INTO fk98_hijo VALUES (2, 2, 'dos', 1);
         INSERT INTO fk98_hijo VALUES (3, NULL, NULL, 1);
         INSERT INTO fk98_nieto VALUES (1, 1);
         INSERT INTO fk98_nieto VALUES (2, NULL)",
        10,
    )
    .unwrap_or_else(|e| panic!("{via}: {e}"));
    let keys = assert_schema_fks(d, "informix", &["celer"]);
    let composite = keys.iter().find(|k| k.name == "fk98_hijo_padre").unwrap_or_else(|| panic!("{via}: {keys:#?}"));
    assert_eq!((composite.columns.join(","), composite.target_columns.join(",")), ("x,y".into(), "b,a".into()), "{via}");
    assert!(keys.iter().any(|k| k.name == "fk98_hijo_jefe" && k.target.name == "fk98_hijo"), "{via}");
    assert!(keys.iter().any(|k| k.table.name == "celer_t" && k.target.name == "celer_p"), "{via}: la clave del seed");
    // The seeded demo database, when it is there.
    if d.databases().unwrap().iter().any(|n| n.trim() == "celerdemo") {
        assert_schema_fks(d, "informix", &["celerdemo"]);
    }
}

/// A synthetic schema like the one of #98 (about 1,500 tables, a key every few tables), in its own database: the
/// diagram of one table (big_0005, with a key to big_0004 and one to big_0000) reads every key of the schema in one
/// query, then the columns of the tables on show. Built
/// once (a few minutes); the timings of both protocols are printed and must stay near a second.
#[test]
fn informix_large_schema_fks() {
    const TABLES: usize = 1500;
    let Some((cfg, lib)) = informix_cfg() else { return };
    let drda = drda_connect(lib);
    let mut ifx_cfg = cfg.clone();
    ifx_cfg.database = "sysmaster".into();
    let mut admin = drda(ifx_cfg).expect("conexión a sysmaster");
    let exists = scalar(admin.as_mut(), "SELECT COUNT(*) FROM sysdatabases WHERE name = 'celer_big'").trim() == "1";
    drop(admin);
    let mut big = cfg.clone();
    big.database = "celer_big".into();
    if !exists || {
        let mut d = drda(big.clone()).unwrap();
        scalar(d.as_mut(), "SELECT COUNT(*) FROM systables WHERE tabid >= 100 AND tabname LIKE 'big_%'").trim() != TABLES.to_string()
    } {
        let mut d = drda(cfg.clone()).unwrap();
        let _ = d.execute("DROP DATABASE IF EXISTS celer_big", 10);
        d.execute("CREATE DATABASE celer_big WITH LOG", 10).unwrap();
        drop(d);
        let mut d = drda(big.clone()).unwrap();
        let t0 = Instant::now();
        for i in 0..TABLES {
            // Every fourth table points to the one before it, and every tenth to big_0000 (many keys to one table).
            let mut cols = format!("id INT PRIMARY KEY, nombre VARCHAR(40), alta DATE, importe DECIMAL(10,2)");
            if i % 4 == 1 {
                cols.push_str(&format!(", prev INT REFERENCES big_{:04}(id)", i - 1));
            }
            if i % 10 == 5 {
                cols.push_str(", raiz INT REFERENCES big_0000(id)");
            }
            d.execute(&format!("CREATE TABLE big_{i:04} ({cols})"), 10).unwrap();
        }
        println!("esquema sintético: {TABLES} tablas creadas en {:?}", t0.elapsed());
    }
    let jdbc = informix_jdbc_cfg().map(|(mut jcfg, rt)| {
        jcfg.database = "celer_big".into();
        (jcfg, jdbc_connect(rt))
    });
    let mut runs: Vec<(&str, ConnConfig, &Connect)> = vec![("DRDA", big.clone(), &drda)];
    if let Some((jcfg, connect)) = jdbc.as_ref() {
        runs.push(("JDBC", jcfg.clone(), connect));
    }
    for (via, cfg, connect) in runs {
        let mut d = connect(cfg).unwrap_or_else(|e| panic!("{via}: {e}"));
        let d = d.as_mut();
        let centre = ObjectRef { database: "celer_big".into(), schema: "informix".into(), name: "big_0005".into(), kind: "table".into() };
        // What openErDiagram does for one table: the folders, the tables, every key at once, then the columns of the
        // table and its neighbours.
        let t0 = Instant::now();
        let folders = d.children(&["celer_big".to_string()]).unwrap();
        let tables_path = folders.iter().find(|n| n.path.last().map(String::as_str) == Some("tables")).unwrap().path.clone();
        let tables = d.children(&tables_path).unwrap();
        let listed = t0.elapsed();
        let t1 = Instant::now();
        let keys = d.schema_foreign_keys(&["celer_big".to_string()]).unwrap();
        let read_keys = t1.elapsed();
        let around: Vec<ObjectRef> = keys
            .iter()
            .filter_map(|k| if k.table.name == centre.name { Some(k.target.clone()) } else if k.target.name == centre.name { Some(k.table.clone()) } else { None })
            .collect();
        let t2 = Instant::now();
        d.table_columns(&centre).unwrap();
        for obj in &around {
            d.table_columns(obj).unwrap();
        }
        let columns = t2.elapsed();
        let total = t0.elapsed();
        println!(
            "Informix por {via}, {} tablas: diagrama de big_0005 en {total:?} (lista de tablas {listed:?}; {} claves en una consulta {read_keys:?}; columnas de {} tablas {columns:?})",
            tables.len(),
            keys.len(),
            around.len() + 1
        );
        assert!(tables.len() >= TABLES, "{via}: {}", tables.len());
        assert_eq!(keys.len(), TABLES / 4 + TABLES / 10, "{via}");
        // What the diagram did before: the keys of each table in turn (one explorer call per table).
        let t3 = Instant::now();
        let each = crate::session::per_table_foreign_keys(d, &["celer_big".to_string()]).unwrap();
        println!("Informix por {via}: antes, tabla a tabla, {} claves en {:?}", each.len(), t3.elapsed());
        assert_eq!(fk_tuples(&keys), fk_tuples(&each), "{via}");
        assert!(read_keys < Duration::from_secs(5), "{via}: leer las claves tardó {read_keys:?}");
    }
}

/// #97, measured: where the time goes when Informix ends an idle session (onmode -z, as a server's idle timeout
/// does): noticing the dead connection, opening another and the guard's replay, and the whole next query.
fn informix_recovery_breakdown(via: &str, connect: &Connector, admin: &mut dyn Driver) {
    const SID: &str = "SELECT DBINFO('sessionid') FROM systables WHERE tabid = 1";
    // Raw driver: how long a ping on the dead connection takes to fail.
    let mut raw = connect().unwrap();
    let sid = scalar(raw.as_mut(), SID);
    if !informix_kill(admin, &sid) {
        return;
    }
    let t = Instant::now();
    let ping = raw.ping();
    let detect = t.elapsed();
    let t = Instant::now();
    let q = raw.execute(SID, 10).map(|_| ());
    let query_fail = t.elapsed();
    drop(raw);
    let t = Instant::now();
    let fresh = connect().unwrap();
    let reconnect = t.elapsed();
    drop(fresh);
    // Through the guard, as the app: idle for 5 minutes (checked before use), and in use (the query finds it).
    let mut g = guarded(DbKind::Informix, connect, "", "celer");
    let sid = scalar(&mut g, SID);
    informix_kill(admin, &sid);
    g.pretend_idle(Duration::from_secs(300));
    let t = Instant::now();
    let out = g.execute(SID, 10).unwrap();
    let idle_total = t.elapsed();
    let sid = scalar(&mut g, SID);
    informix_kill(admin, &sid);
    let t = Instant::now();
    let out2 = g.execute(SID, 10).unwrap();
    let busy_total = t.elapsed();
    eprintln!(
        "{via} #97: ping en la conexión muerta {detect:?} ({}); consulta en ella {query_fail:?} ({}); conexión nueva {reconnect:?}; \
         con la sesión parada 5 min, la consulta siguiente {idle_total:?} {:?}; sin pausa {busy_total:?} {:?}",
        ping.err().map(|e| e.to_string()).unwrap_or("¡respondió!".into()).replace('\n', " · "),
        q.err().map(|e| e.to_string()).unwrap_or("¡respondió!".into()).replace('\n', " · "),
        out.messages,
        out2.messages
    );
}

#[test]
fn informix_recovery_measured() {
    if let Some((cfg, lib)) = informix_cfg() {
        let mut admin_cfg = cfg.clone();
        admin_cfg.database = "sysadmin".into();
        let mut admin = crate::odbc_driver::OdbcDriver::connect(admin_cfg, lib.clone()).expect("sysadmin");
        let connect: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone())?) as Box<dyn Driver>) });
        informix_recovery_breakdown("DRDA", &connect, &mut admin);
    }
    if let Some((cfg, rt)) = informix_jdbc_cfg() {
        let mut admin_cfg = cfg.clone();
        admin_cfg.database = "sysadmin".into();
        let mut admin = crate::jdbc::connect(admin_cfg, rt.clone()).expect("sysadmin por JDBC");
        let connect: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::jdbc::connect(cfg.clone(), rt.clone())?) as Box<dyn Driver>) });
        informix_recovery_breakdown("JDBC", &connect, &mut admin);
    }
}

// ───────────────────────────────────────────────────────────────── a connection cut without a word (#97)

/// A TCP proxy for the tests, in front of a real server: `silence` makes every connection it carries so far go quiet
/// (what arrives is swallowed both ways, the sockets stay open), as a firewall, a NAT or a server's idle timeout whose
/// close never reaches the client. New connections go through as usual.
struct Blackhole {
    port: u16,
    next: Arc<AtomicUsize>,
    quiet_below: Arc<AtomicUsize>,
    /// Both ends of every connection, closed when the proxy goes: a driver still waiting on a silenced one (the
    /// guard left it on its own thread) then gets its error and ends, instead of keeping the process from exiting.
    sockets: Arc<parking_lot::Mutex<Vec<std::net::TcpStream>>>,
}

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

impl Blackhole {
    fn to(target: String) -> Blackhole {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let next = Arc::new(AtomicUsize::new(0));
        let quiet_below = Arc::new(AtomicUsize::new(0));
        let sockets: Arc<parking_lot::Mutex<Vec<std::net::TcpStream>>> = Arc::default();
        let (n, q, all) = (next.clone(), quiet_below.clone(), sockets.clone());
        std::thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let seq = n.fetch_add(1, Ordering::SeqCst);
                let Ok(server) = std::net::TcpStream::connect(&target) else { continue };
                all.lock().extend([client.try_clone().unwrap(), server.try_clone().unwrap()]);
                for (mut from, mut to) in [(client.try_clone().unwrap(), server.try_clone().unwrap()), (server, client)] {
                    let q = q.clone();
                    std::thread::spawn(move || {
                        use std::io::Read;
                        let mut buf = [0u8; 16384];
                        while let Ok(n) = from.read(&mut buf) {
                            if n == 0 {
                                let _ = to.shutdown(std::net::Shutdown::Write);
                                break;
                            }
                            if seq < q.load(Ordering::SeqCst) {
                                continue; // gone quiet: nothing passes, nothing is closed
                            }
                            if to.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                    });
                }
            }
        });
        Blackhole { port, next, quiet_below, sockets }
    }

    /// Every connection open now stops answering.
    fn silence(&self) {
        self.quiet_below.store(self.next.load(Ordering::SeqCst), Ordering::SeqCst);
    }
}

impl Drop for Blackhole {
    fn drop(&mut self) {
        for s in self.sockets.lock().drain(..) {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
}

/// What the silent-cut test needs of an engine: how to ask the session's database, and (optionally) a query that
/// tells manual mode, with its answer there.
struct SilentCase<'a> {
    engine: &'a str,
    kind: DbKind,
    database: &'a str,
    current_db: &'a str,
    manual: Option<(&'a str, &'a str)>,
}

/// #97 on a real engine: a watched session idle for a while whose connection went quiet answers the next query in
/// about PING_LIMIT plus a login (not after the system's TCP timeout), on a new connection in the same database and
/// the same transaction mode.
fn silent_cut_suite(case: SilentCase, connect: &Connector, proxy: &Blackhole) {
    let SilentCase { engine, kind, database, current_db, manual } = case;
    let mut g = guarded(kind, connect, "", database);
    assert_eq!(scalar(&mut g, current_db).trim(), database, "{engine}: la base pedida");
    proxy.silence();
    g.pretend_idle(Duration::from_secs(300));
    let t0 = Instant::now();
    let out = g.execute(current_db, 10).unwrap_or_else(|e| panic!("{engine}: tras el corte silencioso → {e}"));
    let took = t0.elapsed();
    eprintln!("{engine} #97: conexión muda tras 5 min parada → resultado en {took:?}; {:?}", out.messages);
    assert_eq!(txt(&out.results[0].rows[0][0]).trim(), database, "{engine}: en la misma base");
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{engine}: {:?}", out.messages);
    assert!(took < Duration::from_millis(2500), "{engine}: {took:?}");

    // Manual mode is kept on the new connection.
    g.set_autocommit(false).unwrap();
    proxy.silence();
    g.pretend_idle(Duration::from_secs(300));
    let t0 = Instant::now();
    let out = g.execute(current_db, 10).unwrap_or_else(|e| panic!("{engine}, modo manual: {e}"));
    eprintln!("{engine} #97, modo manual: {:?}; {:?}", t0.elapsed(), out.messages);
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{engine}: {:?}", out.messages);
    if let Some((sql, want)) = manual {
        assert_eq!(scalar(&mut g, sql).trim(), want, "{engine}: sigue en modo manual");
    }
    g.rollback().unwrap();
    g.set_autocommit(true).unwrap();
    // «Mantener viva»: the check of a session idle long enough, as connWatch.ts asks for it.
    g.pretend_idle(Duration::from_secs(250));
    let h = g.keep_alive(Duration::from_secs(240)).expect("comprobada");
    assert!(h.ok && !h.reconnected, "{engine}: {h:?}");
}

/// The same server reached through a Blackhole: `host`/`port` of the config point to the proxy.
fn through(cfg: &ConnConfig, default_port: u16) -> (ConnConfig, Blackhole) {
    let proxy = Blackhole::to(format!("{}:{}", if cfg.host == "localhost" { "127.0.0.1" } else { cfg.host.as_str() }, cfg.port.unwrap_or(default_port)));
    let mut via = cfg.clone();
    via.host = "127.0.0.1".into();
    via.port = Some(proxy.port);
    (via, proxy)
}

#[test]
fn pg_silent_cut() {
    let Some(cfg) = pg_cfg() else { return };
    let (cfg, proxy) = through(&cfg, 5432);
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::postgres::PostgresDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let case = SilentCase { engine: "PostgreSQL", kind: DbKind::Postgres, database: "celer", current_db: "SELECT current_database()", manual: Some(("SELECT (now() <> statement_timestamp())::text", "true")) };
    silent_cut_suite(case, &connect, &proxy);
}

#[test]
fn mysql_silent_cut() {
    let Some(cfg) = mysql_cfg() else { return };
    let (cfg, proxy) = through(&cfg, 3306);
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::mysql::MysqlDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let case = SilentCase { engine: "MySQL/MariaDB", kind: DbKind::Mysql, database: "shop", current_db: "SELECT DATABASE()", manual: Some(("SELECT @@autocommit", "0")) };
    silent_cut_suite(case, &connect, &proxy);
}

#[test]
fn mssql_silent_cut() {
    let Some(cfg) = mssql_cfg("master") else { return };
    let (cfg, proxy) = through(&cfg, 1433);
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::mssql::MssqlDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let case = SilentCase { engine: "SQL Server", kind: DbKind::Mssql, database: "celer_test", current_db: "SELECT DB_NAME()", manual: Some(("SELECT @@OPTIONS & 2", "2")) };
    silent_cut_suite(case, &connect, &proxy);
}

#[test]
fn informix_silent_cut() {
    const DB: &str = "SELECT TRIM(DBINFO('dbname')) FROM systables WHERE tabid = 1";
    if let Some((cfg, lib)) = informix_cfg() {
        let (mut cfg, proxy) = through(&cfg, 9089);
        cfg.database = "celerdemo".into();
        let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone())?) as Box<dyn Driver>) });
        silent_cut_suite(SilentCase { engine: "Informix DRDA", kind: DbKind::Informix, database: "celer", current_db: DB, manual: None }, &connect, &proxy);
    }
    if let Some((cfg, rt)) = informix_jdbc_cfg() {
        let (mut cfg, proxy) = through(&cfg, 9088);
        cfg.database = "celerdemo".into();
        let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::jdbc::connect(cfg.clone(), rt.clone())?) as Box<dyn Driver>) });
        silent_cut_suite(SilentCase { engine: "Informix JDBC", kind: DbKind::Informix, database: "celer", current_db: DB, manual: None }, &connect, &proxy);
    }
}

/// Generic ODBC (psqlODBC, CELER_ODBC_TEST with Server= and Port=): its check is a catalog call.
#[test]
fn odbc_silent_cut() {
    let (Ok(conn), Ok(lib)) = (std::env::var("CELER_ODBC_TEST"), std::env::var("CELER_ODBC_LIB")) else { return };
    let value = |key: &str| conn.split(';').find_map(|p| p.split_once('=').filter(|(k, _)| k.trim().eq_ignore_ascii_case(key)).map(|(_, v)| v.trim().to_string()));
    let (Some(server), Some(port)) = (value("Server"), value("Port")) else { return };
    let proxy = Blackhole::to(format!("{}:{port}", if server == "localhost" { "127.0.0.1" } else { server.as_str() }));
    let via: String = conn.split(';').filter(|p| !p.trim().is_empty()).map(|p| match p.split_once('=') {
        Some((k, _)) if k.trim().eq_ignore_ascii_case("Server") => "Server=127.0.0.1".to_string(),
        Some((k, _)) if k.trim().eq_ignore_ascii_case("Port") => format!("Port={}", proxy.port),
        _ => p.to_string(),
    }).collect::<Vec<_>>().join(";");
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Odbc;
    cfg.odbc_conn_str = via;
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone())?) as Box<dyn Driver>) });
    let mut g = guarded(DbKind::Odbc, &connect, "", "");
    assert_eq!(scalar(&mut g, "SELECT 1").trim(), "1");
    proxy.silence();
    g.pretend_idle(Duration::from_secs(300));
    let t0 = Instant::now();
    let out = g.execute("SELECT 1", 10).unwrap_or_else(|e| panic!("ODBC: {e}"));
    eprintln!("ODBC #97: conexión muda → resultado en {:?}; {:?}", t0.elapsed(), out.messages);
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{:?}", out.messages);
    assert!(t0.elapsed() < Duration::from_millis(2500));
}

/// Kill and requery on PostgreSQL and MySQL/MariaDB (SQL Server and Informix: mssql_reconnects,
/// informix_reconnects): a session the server ended while idle answers its next query on a new connection, in the
/// same database; ended mid-use (no check before), the read is not repeated (an administrator stopped it on purpose)
/// and the one after works.
fn kill_and_requery(engine: &str, kind: DbKind, connect: &Connector, database: &str, id_sql: &str, current_db: &str, kill: &mut dyn FnMut(&str)) {
    let mut g = guarded(kind, connect, "", database);
    let id = scalar(&mut g, id_sql);
    kill(&id);
    g.pretend_idle(Duration::from_secs(300));
    let t0 = Instant::now();
    let out = g.execute(id_sql, 10).unwrap_or_else(|e| panic!("{engine}: {e}"));
    eprintln!("{engine} #97: sesión terminada en el servidor y parada → {:?}; {:?}", t0.elapsed(), out.messages);
    assert_ne!(txt(&out.results[0].rows[0][0]), id, "{engine}: otra conexión");
    assert!(out.messages.iter().any(|m| m.starts_with(RECOVERED)), "{engine}: {:?}", out.messages);
    assert!(t0.elapsed() < Duration::from_secs(2), "{engine}");
    assert_eq!(scalar(&mut g, current_db).trim(), database, "{engine}: misma base");
    let id = scalar(&mut g, id_sql);
    kill(&id);
    let e = g.execute(id_sql, 10).unwrap_err().to_string();
    assert!(e.starts_with("CONN_RESET:"), "{engine}: {e}");
    assert_ne!(scalar(&mut g, id_sql), id, "{engine}: la siguiente, en otra conexión");
}

#[test]
fn pg_kill_and_requery() {
    let Some(cfg) = pg_cfg() else { return };
    let mut admin = crate::postgres::PostgresDriver::connect(cfg.clone()).unwrap();
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::postgres::PostgresDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let mut kill = |pid: &str| {
        admin.execute(&format!("SELECT pg_terminate_backend({pid})"), 10).unwrap();
        std::thread::sleep(Duration::from_millis(300));
    };
    kill_and_requery("PostgreSQL", DbKind::Postgres, &connect, "celer", "SELECT pg_backend_pid()::text", "SELECT current_database()", &mut kill);
}

#[test]
fn mysql_kill_and_requery() {
    let Some(cfg) = mysql_cfg() else { return };
    let mut admin = crate::mysql::MysqlDriver::connect(cfg.clone()).unwrap();
    let connect: Connector = Arc::new(move || -> anyhow::Result<Box<dyn Driver>> { Ok(Box::new(crate::mysql::MysqlDriver::connect(cfg.clone())?) as Box<dyn Driver>) });
    let mut kill = |id: &str| {
        admin.execute(&format!("KILL {id}"), 10).unwrap();
        std::thread::sleep(Duration::from_millis(300));
    };
    kill_and_requery("MySQL/MariaDB", DbKind::Mysql, &connect, "shop", "SELECT CONNECTION_ID()", "SELECT DATABASE()", &mut kill);
}

/// Closing a console with a result still open (a big SELECT read in part) drops its ODBC statement before the
/// connection it belongs to: the other way round freed a statement handle the driver had already released with the
/// connection (a crash on Windows when tabs were closed after a large query).
#[test]
fn odbc_open_result_is_freed_before_its_connection() {
    let mut cases: Vec<(&str, ConnConfig, String, &str)> = vec![];
    if let Some((cfg, lib)) = informix_cfg() {
        cases.push(("DRDA", cfg, lib, "SELECT a.tabname, b.tabname FROM systables a, systables b"));
    }
    if let Ok(s) = std::env::var("CELER_ODBC_TEST") {
        let cfg = ConnConfig { kind: DbKind::Odbc, odbc_conn_str: s, ..Default::default() };
        cases.push(("ODBC", cfg, crate::odbc::system_manager().into(), "SELECT g, md5(g::text) FROM generate_series(1, 200000) g"));
    }
    for (via, cfg, lib, sql) in cases {
        for i in 0..40 {
            let mut d = crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone()).unwrap_or_else(|e| panic!("{via}: {e}"));
            let out = d.execute(sql, 200).unwrap_or_else(|e| panic!("{via}: {e}"));
            assert!(out.results[0].has_more, "{via}: the result must still be open when the console closes");
            if i % 2 == 1 {
                d.fetch(500).unwrap();
            }
            drop(d);
        }
        eprintln!("{via}: 40 consoles closed with an open result");
    }
}
