//! Integration tests against real SQL Server and Informix servers (run in CI by .github/workflows/engines.yml).
//!   CELER_MSSQL_TEST="host=localhost port=1433 user=sa password=…"
//!   CELER_INFORMIX_TEST="host=localhost port=9089 user=informix password=in4mix database=celer" + CELER_IBM_LIB
//! Besides the driver itself (paging, types, transactions, cancel, metadata, startup script, plans), they run the
//! exact SQL the interface writes for each engine, produced by dev/engine-sql.ts from the tables as the driver
//! sees them: table filters, saved edits, generated scripts, UPSERT/MERGE, the FK lookup, the activity monitor
//! and the schema and data synchronization scripts.

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

fn assert_cancel(d: &mut dyn Driver, slow_sql: &str) {
    let cancel = d.canceller();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        cancel();
    });
    let t0 = Instant::now();
    let r = d.execute(slow_sql, 10);
    t.join().unwrap();
    assert!(r.is_err(), "la consulta lenta debía cancelarse");
    assert!(t0.elapsed() < Duration::from_secs(15), "cancelar tardó {:?}", t0.elapsed());
    // The session is usable again.
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

    // Errors with SQL Server's own message.
    let err = d.execute("SELECT nope FROM dbo.celer_t", 10).unwrap_err().to_string();
    assert!(err.contains("Msg 207"), "{err}");

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

    // Cancel a running statement.
    assert_cancel(d, "WAITFOR DELAY '00:00:30'");

    // The SQL the interface writes, run for real.
    let dt_obj = ObjectRef { database: "celer_test".into(), schema: "dbo".into(), name: "dt".into(), kind: "table".into() };
    let mut shape = json!({ "kind": "mssql", "t": table_shape(d, &obj), "dt": table_shape(d, &dt_obj) });
    // Schema comparison: two schemas with known differences.
    d.execute("IF SCHEMA_ID('sc_a') IS NULL EXEC('CREATE SCHEMA sc_a'); IF SCHEMA_ID('sc_b') IS NULL EXEC('CREATE SCHEMA sc_b');
               IF OBJECT_ID('sc_a.cli') IS NOT NULL DROP TABLE sc_a.cli; IF OBJECT_ID('sc_b.cli') IS NOT NULL DROP TABLE sc_b.cli;
               IF OBJECT_ID('sc_a.fac') IS NOT NULL DROP TABLE sc_a.fac; IF OBJECT_ID('sc_b.fac') IS NOT NULL DROP TABLE sc_b.fac;
               IF OBJECT_ID('sc_b.old') IS NOT NULL DROP TABLE sc_b.old;
               CREATE TABLE sc_a.cli (id int NOT NULL PRIMARY KEY, nombre nvarchar(120) NOT NULL, email nvarchar(200) NULL, vip bit NULL);
               CREATE TABLE sc_a.fac (id int NOT NULL PRIMARY KEY, importe decimal(12,2) NOT NULL);
               CREATE TABLE sc_b.cli (id int NOT NULL PRIMARY KEY, nombre nvarchar(100) NOT NULL, email nvarchar(200) NOT NULL, legacy nvarchar(10) NULL);
               CREATE TABLE sc_b.old (id bigint NOT NULL PRIMARY KEY);
               INSERT INTO sc_b.cli VALUES (1, N'Ana', N'ana@x.es', N'L1');", 10).unwrap();
    shape["schemas"] = schema_shape(d, "celer_test", "sc_a", "sc_b");
    // Data comparison: same structure, different rows; the target has an identity key.
    d.execute("IF OBJECT_ID('dbo.dc_a') IS NOT NULL DROP TABLE dbo.dc_a; IF OBJECT_ID('dbo.dc_b') IS NOT NULL DROP TABLE dbo.dc_b;
               CREATE TABLE dbo.dc_a (id int NOT NULL PRIMARY KEY, nombre nvarchar(50), activo bit, alta datetime2(3), importe decimal(10,2));
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

/// A big result left half read (a page of 500, as the interface asks for): the next statement must not wait for the
/// rest of it, nor for a new connection. The session survives: same SPID, #temp tables, open transaction.
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
    let spid = scalar(d, "SELECT @@SPID");
    for round in 1..=3 {
        let first = page(d);
        let t0 = Instant::now();
        let out = d.execute("SELECT @@SPID", 10).unwrap();
        let next = t0.elapsed().as_millis();
        let now = txt(&out.results[0].rows[0][0]);
        eprintln!("cursor abandonado, ronda {round}: primera página {first} ms, siguiente consulta {next} ms, SPID {spid} → {now}; {:?}", out.messages);
        assert_eq!(now, spid, "el cursor se cortó con ATTENTION en la misma conexión");
        assert!(next < 1500, "la consulta tras el cursor abandonado tardó {next} ms");
        assert!(out.messages.iter().any(|m| m.contains("ATTENTION")), "{:?}", out.messages);
    }
    // "Pedir más" still works after a cut: a new cursor pages on.
    page(d);
    assert_eq!(d.fetch(500).unwrap().rows.len(), 500);

    // A #temp table and an open transaction (autocommit mode, BEGIN TRAN) across an abandoned cursor.
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

    // Manual mode keeps its transaction across a cut too.
    d.set_autocommit(false).unwrap();
    d.execute("INSERT INTO #celer_tmp VALUES (3)", 10).unwrap();
    page(d);
    assert_eq!(scalar(d, "SELECT COUNT(*) FROM #celer_tmp"), "2");
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

// ───────────────────────────────────────────────────────────────── Informix (DRDA, IBM CLI driver)

fn informix_cfg() -> Option<(ConnConfig, String)> {
    let s = spec("CELER_INFORMIX_TEST")?;
    let lib = std::env::var("CELER_IBM_LIB").ok()?;
    let mut cfg = ConnConfig::default();
    cfg.kind = DbKind::Informix;
    cfg.host = get(&s, "host");
    cfg.port = get(&s, "port").parse().ok();
    cfg.user = get(&s, "user");
    cfg.password = Some(get(&s, "password"));
    cfg.database = get(&s, "database");
    Some((cfg, lib))
}

fn informix() -> Option<crate::odbc_driver::OdbcDriver> {
    let (cfg, lib) = informix_cfg()?;
    Some(crate::odbc_driver::OdbcDriver::connect(cfg, lib).expect("conexión Informix"))
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
    let Some(mut d) = informix() else { return };
    let d: &mut dyn Driver = &mut d;
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
    assert_cancel(d, "SELECT COUNT(*) FROM systables a, systables b, systables c, systables d, systables e");

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
    let (mut cfg, lib) = informix_cfg().unwrap();
    cfg.startup_sql = "SET LOCK MODE TO WAIT 5".into();
    let mut s = crate::odbc_driver::OdbcDriver::connect(cfg.clone(), lib.clone()).unwrap();
    assert_eq!(scalar(&mut s, "SELECT COUNT(*) FROM celer_t"), "5", "4 seeded, one deleted, one inserted, one upserted");
    cfg.startup_sql = "SELEC 1".into();
    let err = crate::odbc_driver::OdbcDriver::connect(cfg, lib).err().expect("script erróneo").to_string();
    assert!(err.contains("script de inicio"), "{err}");
}
