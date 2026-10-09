// Checks for the connection form (src/connForm.ts, parseJdbc in src/migrateParse.ts): JDBC URLs of every engine,
// field validation and the fields shown. node --experimental-strip-types dev/connform-check.ts
import assert from "node:assert/strict";
import { applyJdbcUrl, defaultPort, hasErrors, validateConn, visibleFields, withInstanceName } from "../src/connForm.ts";
import { parseJdbc, parseJdbcUrl } from "../src/migrateParse.ts";
import { emptyConn, type ConnConfig } from "../src/types.ts";

const conn = (patch: Partial<ConnConfig>): ConnConfig => ({ ...emptyConn(patch.kind ?? "postgres"), ...patch });
const fieldsWith = (cfg: ConnConfig, level?: "error" | "warning") =>
  validateConn(cfg)
    .filter((issue) => !level || issue.level === level)
    .map((issue) => issue.field);

// ---------------------------------------------------------------- JDBC URLs, engine by engine

// SQL Server: server\instance:port, properties for the rest; the password is never taken.
let info = parseJdbc("jdbc:sqlserver://sql01\\SQLEXPRESS:1433;databaseName=crm;encrypt=true;trustServerCertificate=true;user=app;password=secreto;loginTimeout=30");
assert.ok(info);
assert.equal(info.kind, "mssql");
assert.equal(info.host, "sql01");
assert.equal(info.instance, "SQLEXPRESS");
assert.equal(info.port, 1433);
assert.equal(info.database, "crm");
assert.equal(info.user, "app");
assert.equal(info.password, true);
assert.equal(info.encryption, "required");
assert.equal(info.trustCert, true);
assert.deepEqual(info.ignored, ["loginTimeout"]);
assert.ok(!JSON.stringify(info).includes("secreto"), "the password never travels");
// Everything in properties, database=, Windows authentication, encrypt=false (TLS only for the login).
info = parseJdbc("jdbc:sqlserver://;serverName=db.example.com;portNumber=1500;instanceName=PROD;database=ventas;integratedSecurity=true;encrypt=false");
assert.equal(info?.host, "db.example.com");
assert.equal(info?.port, 1500);
assert.equal(info?.instance, "PROD");
assert.equal(info?.database, "ventas");
assert.equal(info?.integratedAuth, true);
assert.equal(info?.encryption, "login");
// IPv6: bracketed in the URL (with or without port), bare in serverName; a server part that cannot be read is not
// taken for localhost.
info = parseJdbc("jdbc:sqlserver://[2001:db8::5]:1500;databaseName=dw");
assert.equal(info?.host, "2001:db8::5");
assert.equal(info?.port, 1500);
assert.equal(info?.database, "dw");
assert.equal(parseJdbc("jdbc:sqlserver://[fe80::1]\\SQLEXPRESS;databaseName=dw")?.instance, "SQLEXPRESS");
assert.equal(parseJdbc("jdbc:sqlserver://;serverName=2001:db8::7;databaseName=dw")?.host, "2001:db8::7");
assert.equal(parseJdbc("jdbc:sqlserver://srv:12:34;databaseName=dw"), null);
// jTDS.
info = parseJdbc("jdbc:jtds:sqlserver://legacy:1433/stock;instance=SQL2008;ssl=require;user=sa");
assert.equal(info?.kind, "mssql");
assert.equal(info?.host, "legacy");
assert.equal(info?.database, "stock");
assert.equal(info?.instance, "SQL2008");
assert.equal(info?.encryption, "required");
// The old reader (DBeaver import) also takes database=.
assert.equal(parseJdbcUrl("jdbc:sqlserver://h:1433;database=crm").database, "crm");

// Informix over SQLI: INFORMIXSERVER and the other properties as extra parameters; DRDA through jdbc:ids.
info = parseJdbc("jdbc:informix-sqli://ifx.example.com:9088/stores:INFORMIXSERVER=ol_demo;DB_LOCALE=es_ES.819;user=informix;password=x");
assert.equal(info?.kind, "informix");
assert.equal(info?.informixMode, "auto");
assert.equal(info?.instance, "ol_demo");
assert.equal(info?.database, "stores");
assert.equal(info?.user, "informix");
assert.equal(info?.params, "DB_LOCALE=es_ES.819");
assert.equal(info?.password, true);
info = parseJdbc("jdbc:ids://ifx:9089/stores:user=informix;retrieveMessagesFromServerOnGetMessage=true;");
assert.equal(info?.informixMode, "drda");
assert.equal(info?.port, 9089);
assert.equal(info?.params, undefined, "JDBC properties are not IBM CLI keywords");
assert.deepEqual(info?.ignored, ["retrieveMessagesFromServerOnGetMessage"]);

// PostgreSQL: several hosts (the first one), sslmode, currentSchema through search_path, credentials in the authority.
info = parseJdbc("jdbc:postgresql://pg1:5433,pg2:5434/app?sslmode=verify-full&currentSchema=ventas&ApplicationName=informes&user=lector&password=x&tcpKeepAlive=true");
assert.equal(info?.kind, "postgres");
assert.equal(info?.host, "pg1");
assert.equal(info?.port, 5433);
assert.deepEqual(info?.otherHosts, ["pg2:5434"]);
assert.equal(info?.database, "app");
assert.equal(info?.user, "lector");
assert.equal(info?.encryption, "required");
assert.equal(info?.trustCert, false);
assert.equal(info?.params, "options=-c search_path=ventas;application_name=informes");
assert.deepEqual(info?.ignored, ["tcpKeepAlive"]);
info = parseJdbc("jdbc:postgresql://user%40corp:pw@[::1]/db%20x?sslmode=disable");
assert.equal(info?.host, "::1");
assert.equal(info?.port, undefined);
assert.equal(info?.user, "user@corp");
assert.equal(info?.password, true);
assert.equal(info?.database, "db x");
assert.equal(info?.encryption, "off");
assert.equal(parseJdbc("jdbc:postgresql:local")?.database, "local");

// MySQL and MariaDB: SSL modes, timeouts in seconds, session variables; anything else is listed as unused.
info = parseJdbc("jdbc:mysql://my:3307/shop?useSSL=true&verifyServerCertificate=false&connectTimeout=5000&serverTimezone=UTC&sessionVariables=sql_mode='ANSI_QUOTES'");
assert.equal(info?.kind, "mysql");
assert.equal(info?.port, 3307);
assert.equal(info?.database, "shop");
assert.equal(info?.encryption, "required");
assert.equal(info?.trustCert, true);
assert.equal(info?.params, "connect_timeout=5;sql_mode='ANSI_QUOTES'");
assert.deepEqual(info?.ignored, ["serverTimezone"]);
info = parseJdbc("jdbc:mariadb://maria/erp?sslMode=verify-full");
assert.equal(info?.kind, "mysql");
assert.equal(info?.host, "maria");
assert.equal(info?.encryption, "required");
assert.equal(info?.trustCert, false);
assert.equal(parseJdbc("jdbc:mysql:loadbalance://a:3306,b:3306/db")?.otherHosts.join(), "b:3306");
assert.equal(parseJdbc("jdbc:mysql://h/db?sslMode=DISABLED")?.encryption, "off");

// SQLite: a file (Windows paths too) or memory.
assert.equal(parseJdbc("jdbc:sqlite:C:\\datos\\app.db")?.file, "C:\\datos\\app.db");
assert.equal(parseJdbc("jdbc:sqlite::memory:")?.file, ":memory:");
assert.equal(parseJdbc("jdbc:sqlite:")?.file, ":memory:");

// Not a JDBC URL of an engine Celer connects to.
assert.equal(parseJdbc("jdbc:oracle:thin:@db:1521:XE"), null);
assert.equal(parseJdbc("postgresql://h/db"), null);

// ---------------------------------------------------------------- filling the form

// Another engine: its defaults, but the name, folder, colour and flags stay; never the password.
const named = conn({ kind: "postgres", name: "CRM", folder: "Clientes", color: "#E5534B", production: true, password: "" });
let applied = applyJdbcUrl(named, "jdbc:sqlserver://sql01\\SQLEXPRESS;databaseName=crm;user=app;password=x;trustServerCertificate=false");
assert.ok(applied);
assert.equal(applied.cfg.kind, "mssql");
assert.equal(applied.cfg.name, "CRM");
assert.equal(applied.cfg.folder, "Clientes");
assert.equal(applied.cfg.production, true);
// The environment goes with the connection, not with the engine.
const staged = applyJdbcUrl(conn({ kind: "postgres", environment: "custom", envLabel: "QA", envColor: "#2BA3A3" }), "jdbc:mysql://my/web");
assert.deepEqual([staged?.cfg.environment, staged?.cfg.envLabel, staged?.cfg.envColor], ["custom", "QA", "#2BA3A3"]);
assert.equal(applied.cfg.port, null, "a named instance without a port: SQL Server Browser gives it");
assert.equal(applied.cfg.instance, "SQLEXPRESS");
assert.equal(applied.cfg.user, "app");
assert.equal(applied.cfg.password, "");
assert.equal(applied.cfg.trustCert, false);
assert.equal(applied.cfg.encryption, "required", "SQL Server's default (mssql-jdbc encrypts by default too)");
assert.ok(applied.notes[0].startsWith("SQL Server: servidor sql01, instancia SQLEXPRESS"), applied.notes[0]);
assert.ok(applied.notes.some((note) => note.includes("contraseña")));

// Informix: the URL's SQLI keeps the protocol the connection had; DRDA brings its port.
applied = applyJdbcUrl(conn({ kind: "informix", informixMode: "jdbc", user: "yo" }), "jdbc:informix-sqli://ifx:9088/stores:informixserver=ol_x");
assert.equal(applied?.cfg.informixMode, "jdbc");
assert.equal(applied?.cfg.instance, "ol_x");
assert.equal(applied?.cfg.user, "yo", "the user stays when the URL has none");
applied = applyJdbcUrl(conn({ kind: "informix", informixMode: "auto" }), "jdbc:ids://ifx/stores");
assert.equal(applied?.cfg.informixMode, "drda");
assert.equal(applied?.cfg.port, 9089);
// The URL describes the whole connection: what it does not say is cleared.
applied = applyJdbcUrl(conn({ kind: "postgres", database: "old", extra: "connect_timeout=3" }), "jdbc:postgresql://pg/");
assert.equal(applied?.cfg.database, "");
assert.equal(applied?.cfg.extra, "");
assert.equal(applied?.cfg.port, 5432);
applied = applyJdbcUrl(conn({ kind: "postgres", host: "x" }), "jdbc:sqlite:/tmp/a.db");
assert.equal(applied?.cfg.kind, "sqlite");
assert.equal(applied?.cfg.filePath, "/tmp/a.db");
assert.equal(applied?.cfg.host, "");
assert.equal(applyJdbcUrl(named, "jdbc:oracle:thin:@db:1521:XE"), null);

// ---------------------------------------------------------------- validation

assert.deepEqual(validateConn(conn({ kind: "postgres", host: "pg", user: "u" })), [], "a good connection has nothing to say");
assert.deepEqual(fieldsWith(conn({ kind: "postgres", host: "" }), "error"), ["host"]);
assert.deepEqual(fieldsWith(conn({ kind: "postgres", host: "mi servidor" }), "error"), ["host"]);
assert.deepEqual(fieldsWith(conn({ kind: "postgres", host: "jdbc:postgresql://h/db" }), "error"), ["host"]);
// A port in the server is a warning with a fix.
let issue = validateConn(conn({ kind: "mysql", host: "db:3307" }))[0];
assert.equal(issue.level, "warning");
assert.deepEqual(issue.fix, { host: "db", port: 3307 });
// server\instance: fine to split on SQL Server, an error elsewhere.
issue = validateConn(conn({ kind: "mssql", host: "sql\\EXPRESS" }))[0];
assert.equal(issue.level, "warning");
assert.deepEqual(issue.fix, { host: "sql", instance: "EXPRESS", port: null }, "the default port is left out for the instance's own");
assert.deepEqual(validateConn(conn({ kind: "mssql", host: "sql\\EXPRESS", port: 1500 }))[0].fix, { host: "sql", instance: "EXPRESS" }, "a typed port stays");
// Typing an instance leaves the default port empty; a typed one stays; Informix's INFORMIXSERVER does not touch it.
assert.deepEqual(withInstanceName(conn({ kind: "mssql" }), "SQLEXPRESS"), { instance: "SQLEXPRESS", port: null });
assert.deepEqual(withInstanceName(conn({ kind: "mssql", port: 1500 }), "SQLEXPRESS"), { instance: "SQLEXPRESS" });
assert.deepEqual(withInstanceName(conn({ kind: "informix", port: 9088 }), "ol_x"), { instance: "ol_x" });
assert.equal(defaultPort(conn({ kind: "mssql", instance: "SQLEXPRESS" })), null);
assert.equal(defaultPort(conn({ kind: "mssql" })), 1433);
// An instance with 1433 typed back in: a warning offering to empty the port; another port is the user's choice.
issue = validateConn(conn({ kind: "mssql", instance: "SQLEXPRESS", port: 1433 })).find((i) => i.field === "port")!;
assert.equal(issue.level, "warning");
assert.deepEqual(issue.fix, { port: null });
assert.deepEqual(validateConn(conn({ kind: "mssql", instance: "SQLEXPRESS", port: 1500 })), []);
assert.deepEqual(validateConn(conn({ kind: "mssql", instance: "SQLEXPRESS", port: null })), []);
assert.equal(applyJdbcUrl(conn({ kind: "mssql" }), "jdbc:sqlserver://srv\\SQLEXPRESS:1500;databaseName=x")?.cfg.port, 1500);
assert.equal(applyJdbcUrl(conn({ kind: "mssql" }), "jdbc:sqlserver://srv;databaseName=x")?.cfg.port, 1433);
assert.deepEqual(fieldsWith(conn({ kind: "postgres", host: "sql\\EXPRESS" }), "error"), ["host"]);
// IPv6 addresses are not a host with a port.
assert.deepEqual(validateConn(conn({ kind: "postgres", host: "fe80::1" })), []);
for (const port of [0, 65536, 1.5, Number.NaN]) assert.deepEqual(fieldsWith(conn({ kind: "postgres", port }), "error"), ["port"], String(port));
assert.deepEqual(fieldsWith(conn({ kind: "postgres", port: null })), [], "no port: the usual one");
assert.deepEqual(fieldsWith(conn({ kind: "mysql", user: " " }), "error"), ["user"]);
assert.deepEqual(validateConn(conn({ kind: "mssql", user: "", integratedAuth: true })), [], "Windows authentication needs no user");
// Informix: DRDA needs the database; the Client SDK needs INFORMIXSERVER; Automático only warns.
assert.deepEqual(fieldsWith(conn({ kind: "informix", informixMode: "drda", database: "" }), "error"), ["database"]);
assert.deepEqual(fieldsWith(conn({ kind: "informix", informixMode: "sqli", instance: "" }), "error"), ["instance"]);
assert.deepEqual(fieldsWith(conn({ kind: "informix", informixMode: "auto", instance: "" }), "warning"), ["instance"]);
assert.deepEqual(validateConn(conn({ kind: "informix", informixMode: "jdbc", instance: "" })), []);
// SQLite, ODBC.
assert.deepEqual(fieldsWith(conn({ kind: "sqlite", filePath: "" }), "error"), ["filePath"]);
assert.deepEqual(validateConn(conn({ kind: "sqlite", filePath: ":memory:" })), []);
assert.deepEqual(fieldsWith(conn({ kind: "odbc", odbcConnStr: "" }), "error"), ["odbcConnStr"]);
assert.deepEqual(fieldsWith(conn({ kind: "odbc", odbcConnStr: "SERVER=x;UID=y" }), "error"), ["odbcConnStr"]);
assert.deepEqual(validateConn(conn({ kind: "odbc", odbcConnStr: "DRIVER={SQL Server};SERVER=x" })), []);
assert.deepEqual(validateConn(conn({ kind: "odbc", odbcConnStr: "dsn=ventas" })), []);
// Extra parameters: key=value pairs.
assert.deepEqual(validateConn(conn({ kind: "postgres", extra: "connect_timeout=5; application_name=x;" })), []);
assert.deepEqual(fieldsWith(conn({ kind: "postgres", extra: "connect_timeout=5;compress" }), "error"), ["extra"]);
assert.deepEqual(fieldsWith(conn({ kind: "mysql", extra: "=5" }), "error"), ["extra"]);
assert.deepEqual(validateConn(conn({ kind: "mssql", extra: "basura" })), [], "SQL Server does not read them: hidden, not checked");
// A repeated name is a warning, not an error (and the connection itself does not count).
const saved = [{ id: "a", name: "CRM" }];
issue = validateConn(conn({ id: "b", name: " crm " }), saved)[0];
assert.equal(issue.field, "name");
assert.equal(issue.level, "warning");
assert.equal(hasErrors(validateConn(conn({ id: "b", name: "CRM" }), saved)), false);
assert.deepEqual(validateConn(conn({ id: "a", name: "CRM" }), saved), []);

// ---------------------------------------------------------------- fields shown

let shown = visibleFields(conn({ kind: "mssql" }));
assert.ok(shown.host && shown.instance && shown.user && shown.integratedAuth && shown.encryption && shown.trustCert);
assert.equal(shown.instanceLabel, "Instancia");
assert.ok(!shown.extra && !shown.informixMode && !shown.file && !shown.odbc);
shown = visibleFields(conn({ kind: "mssql", integratedAuth: true, encryption: "off" }));
assert.ok(!shown.user && !shown.password && !shown.savePassword && !shown.trustCert);
shown = visibleFields(conn({ kind: "informix", informixMode: "jdbc" }));
assert.ok(shown.instance && shown.informixMode && shown.extra && !shown.encryption && !shown.integratedAuth);
assert.equal(shown.instanceLabel, "INFORMIXSERVER");
assert.equal(visibleFields(conn({ kind: "informix", informixMode: "drda" })).instance, false);
shown = visibleFields(conn({ kind: "postgres" }));
assert.ok(!shown.instance && shown.extra && shown.encryption);
shown = visibleFields(conn({ kind: "sqlite" }));
assert.deepEqual(
  Object.entries(shown).filter(([key, value]) => value === true && key !== "instanceLabel").map(([key]) => key),
  ["file"],
);
shown = visibleFields(conn({ kind: "odbc", odbcConnStr: "DSN=x;UID=y" }));
assert.ok(shown.odbc && !shown.user && shown.password && !shown.host);
// A PWD= in the string: the password field stays, and a warning offers to move it there.
shown = visibleFields(conn({ kind: "odbc", odbcConnStr: "DSN=x;UID=y;PWD=s" }));
assert.ok(shown.password && shown.savePassword);
issue = validateConn(conn({ kind: "odbc", odbcConnStr: "DSN=x;UID=y;PWD=s" }))[0];
assert.equal(issue.field, "odbcConnStr");
assert.equal(issue.level, "warning");
assert.deepEqual(issue.fix, { odbcConnStr: "DSN=x;UID=y;", password: "s" });
assert.deepEqual(fieldsWith(conn({ kind: "postgres", extra: "password=p;connect_timeout=5" }), "warning"), ["extra"]);
assert.equal(defaultPort(conn({ kind: "informix", informixMode: "drda" })), 9089);
assert.equal(defaultPort(conn({ kind: "sqlite" })), null);

console.log("connection form: ok");
