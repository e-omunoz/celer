// Checks for src/migrateParse.ts (DBeaver data-sources.json and DbVisualizer dbvis.xml through the full JDBC parser):
//   node --experimental-strip-types dev/migrate-check.ts
// The samples in dev/fixtures/migrate are the files the desktop app imports with CELER_MIGRATE_HOME (one connection
// per engine of dev/wsl/compose.yml); the edge cases below are written in the same formats.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDbeaverCredentials, decryptDbeaverCredentials, parseDbeaver, parseDbVisualizer, parseJdbcUrl, parseXml, type Candidate } from "../src/migrateParse.ts";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/migrate/${path}`, import.meta.url), "utf8");
const dbeaver = (connections: Record<string, unknown>, path = "data-sources.json") => parseDbeaver({ tool: "dbeaver", project: "General", path, text: JSON.stringify({ connections }) });
const dbvis = (xml: string) => parseDbVisualizer({ tool: "dbvisualizer", project: "config230", path: "dbvis.xml", text: xml });
const byName = (list: Candidate[], name: string) => {
  const found = list.find((c) => c.cfg.name === name);
  assert.ok(found, `no candidate «${name}» in ${list.map((c) => c.cfg.name).join(", ")}`);
  return found;
};
/** The fields that decide where a connection goes. */
const where = (c: Candidate) => {
  const { kind, host, port, database, instance, informixMode, encryption, trustCert, extra, filePath, odbcConnStr, user, integratedAuth } = c.cfg;
  return { kind, host, port, database, instance, informixMode, encryption, trustCert, extra, filePath, odbcConnStr, user, integratedAuth };
};

// ---------------------------------------------------------------- the old reader is a view of parseJdbc

assert.deepEqual(parseJdbcUrl("jdbc:informix-sqli://db.example.com:9088/ventas:informixserver=ol_ventas;DB_LOCALE=es_ES.819;IFX_LOCK_MODE_WAIT=10;password=x;user=y"), {
  host: "db.example.com",
  port: 9088,
  database: "ventas",
  instance: "ol_ventas",
  params: "DB_LOCALE=es_ES.819;IFX_LOCK_MODE_WAIT=10",
});
assert.deepEqual(parseJdbcUrl("jdbc:postgresql://pg:5432/app"), { host: "pg", port: 5432, database: "app" });
assert.equal(parseJdbcUrl("jdbc:sqlserver://sql\\SQLEXPRESS:1433;databaseName=crm").instance, "SQLEXPRESS");
assert.deepEqual(parseJdbcUrl("jdbc:informix-sqli://ifx/stores:INFORMIXSERVER=ol"), { host: "ifx", database: "stores", instance: "ol" }, "Informix without port");
assert.deepEqual(parseJdbcUrl("jdbc:nonsense://x"), {});

// ---------------------------------------------------------------- the DBeaver sample: one connection per engine

const sample = parseDbeaver({ tool: "dbeaver", project: "General", path: "/ws/General/.dbeaver/data-sources.json", text: fixture("DBeaverData/workspace6/General/.dbeaver/data-sources.json") });
assert.equal(sample.length, 8);
assert.ok(sample.every((c) => c.status === "new"), sample.filter((c) => c.status !== "new").map((c) => `${c.cfg.name}: ${c.reason}`).join("; "));
assert.ok(sample.every((c) => c.cfg.folder === "DBeaver · Celer"));
// MANUAL: the fields (they match the URL here).
assert.deepEqual(where(byName(sample, "PG manual")), { kind: "postgres", host: "localhost", port: 15432, database: "celer", instance: "", informixMode: "auto", encryption: "login", trustCert: true, extra: "", filePath: "", odbcConnStr: "", user: "postgres", integratedAuth: false });
// URL only (configurationType URL, no fields): everything from the URL, its SSL and timeout properties included.
const mysqlUrl = byName(sample, "MySQL solo URL");
assert.deepEqual(where(mysqlUrl), { kind: "mysql", host: "localhost", port: 33306, database: "celer", instance: "", informixMode: "auto", encryption: "off", trustCert: true, extra: "connect_timeout=10", filePath: "", odbcConnStr: "", user: "root", integratedAuth: false });
assert.deepEqual(mysqlUrl.notes, ["Propiedades que Celer no usa: allowPublicKeyRetrieval."]);
// Empty-string host, port and database in a MANUAL configuration: the URL wins.
assert.deepEqual(where(byName(sample, "MariaDB campos vacíos")), { kind: "mysql", host: "localhost", port: 33307, database: "celer", instance: "", informixMode: "auto", encryption: "login", trustCert: true, extra: "", filePath: "", odbcConnStr: "", user: "root", integratedAuth: false });
// SQL Server with nothing after "//": serverName, portNumber, databaseName; encrypt and trustServerCertificate from the
// driver properties; "prod" marks it as production.
const mssql = byName(sample, "SQL Server sin host en la URL");
assert.deepEqual(where(mssql), { kind: "mssql", host: "localhost", port: 1433, database: "celerdemo", instance: "", informixMode: "auto", encryption: "required", trustCert: true, extra: "", filePath: "", odbcConnStr: "", user: "sa", integratedAuth: false });
assert.equal(mssql.cfg.production, true);
// Informix over SQLI: INFORMIXSERVER from the URL, driver properties as extra parameters, «Automático».
assert.deepEqual(where(byName(sample, "Informix JDBC")), { kind: "informix", host: "localhost", port: 9088, database: "celerdemo", instance: "informix", informixMode: "auto", encryption: "login", trustCert: true, extra: "IFX_LOCK_MODE_WAIT=10", filePath: "", odbcConnStr: "", user: "informix", integratedAuth: false });
// jdbc:ids: DRDA.
assert.deepEqual(where(byName(sample, "Informix DRDA")), { kind: "informix", host: "localhost", port: 9089, database: "celerdemo", instance: "", informixMode: "drda", encryption: "login", trustCert: true, extra: "", filePath: "", odbcConnStr: "", user: "informix", integratedAuth: false });
assert.equal(byName(sample, "SQLite en memoria").cfg.filePath, ":memory:");
assert.equal(byName(sample, "SQLite en memoria").cfg.kind, "sqlite");
assert.deepEqual([byName(sample, "ODBC CelerPG").cfg.kind, byName(sample, "ODBC CelerPG").cfg.odbcConnStr], ["odbc", "DSN=CelerPG"]);
// Its credentials-config.json (DBeaver's format) gives every user and password, only on request.
const credsHex = readFileSync(new URL("./fixtures/migrate/DBeaverData/workspace6/General/.dbeaver/credentials-config.json", import.meta.url)).toString("hex");
const withCreds = await applyDbeaverCredentials(sample, "/ws/General/.dbeaver/data-sources.json", credsHex);
assert.deepEqual(
  withCreds.filter((c) => c.cfg.kind !== "sqlite").map((c) => [c.cfg.name, c.cfg.user, Boolean(c.cfg.password)]),
  [
    ["PG manual", "celer", true],
    ["MySQL solo URL", "celer", true],
    ["MariaDB campos vacíos", "celer", true],
    ["SQL Server sin host en la URL", "sa", true],
    ["Informix JDBC", "informix", true],
    ["Informix DRDA", "informix", true],
    ["ODBC CelerPG", "celer", true],
  ],
);
assert.equal(byName(withCreds, "SQL Server sin host en la URL").cfg.password, "Celer_Test_2026!");
assert.ok(sample.every((c) => !c.cfg.password), "listing never carries passwords");

// ---------------------------------------------------------------- DBeaver edge cases

const edge = dbeaver({
  // SQL Server named instance in properties, with its port.
  "mssql-named": { provider: "sqlserver", driver: "microsoft", name: "Instancia", configuration: { url: "jdbc:sqlserver://;serverName=sql01;instanceName=PROD;portNumber=1500;databaseName=crm;integratedSecurity=true", configurationType: "URL" } },
  // ... and without port: SQL Server Browser gives it (no 1433 left behind).
  "mssql-browser": { provider: "sqlserver", driver: "microsoft", name: "Instancia sin puerto", configuration: { host: "sql02\\SQLEXPRESS", port: "", database: "dw", url: "jdbc:sqlserver://sql02\\SQLEXPRESS;databaseName=dw", configurationType: "MANUAL" } },
  // Informix without port in the URL.
  "ifx-noport": { provider: "generic", driver: "informix", name: "Informix sin puerto", configuration: { url: "jdbc:informix-sqli://ifx.example.com/stores:INFORMIXSERVER=ol_demo;DB_LOCALE=en_US.819", configurationType: "URL" } },
  // Informix made of fields only (no URL), with the server field and driver properties.
  "ifx-fields": { provider: "generic", driver: "informix", name: "Informix campos", configuration: { host: "ifx2", port: "1526", database: "ventas", server: "ol_ventas", properties: { CLIENT_LOCALE: "es_ES.819", password: "no" } } },
  // Multi-host PostgreSQL with SSL and the schema; DBeaver properties merged too.
  "pg-multi": { provider: "postgresql", driver: "postgres-jdbc", name: "PG varios", configuration: { url: "jdbc:postgresql://pg1:5433,pg2:5434/app?sslmode=verify-full&currentSchema=ventas", configurationType: "URL", properties: { ApplicationName: "informes", sslmode: "disable", tcpKeepAlive: "true" } } },
  // Multi-host MySQL with an SSL property in DBeaver's properties (not in the URL).
  "my-multi": { provider: "mysql", driver: "mysql8", name: "MySQL varios", configuration: { host: "", database: "", url: "jdbc:mysql://my1:3306,my2:3307/web", configurationType: "MANUAL", properties: { sslMode: "REQUIRED", connectTimeout: "5000" } } },
  // PostgreSQL with DBeaver's SSL handler on.
  "pg-ssl": { provider: "postgresql", driver: "postgres-jdbc", name: "PG SSL", configuration: { host: "pgs", port: "5432", database: "x", url: "jdbc:postgresql://pgs:5432/x", handlers: { postgre_ssl: { type: "CONFIG", enabled: true, properties: { sslMode: "verify-ca" } } } } },
  // SQL Server encryption off in the properties.
  "mssql-plain": { provider: "sqlserver", driver: "microsoft", name: "Sin cifrado", configuration: { host: "s", port: "1433", url: "jdbc:sqlserver://s:1433", properties: { encrypt: "false", trustServerCertificate: "false" } } },
  // A driver Celer does not connect to.
  "oracle-1": { provider: "oracle", driver: "oracle_thin", name: "Oracle", configuration: { url: "jdbc:oracle:thin:@ora:1521/XE" } },
});
const instance = byName(edge, "Instancia");
assert.deepEqual([instance.cfg.host, instance.cfg.instance, instance.cfg.port, instance.cfg.database, instance.cfg.integratedAuth], ["sql01", "PROD", 1500, "crm", true]);
const browser = byName(edge, "Instancia sin puerto");
assert.deepEqual([browser.cfg.host, browser.cfg.instance, browser.cfg.port, browser.cfg.database], ["sql02", "SQLEXPRESS", null, "dw"]);
assert.deepEqual(where(byName(edge, "Informix sin puerto")), { kind: "informix", host: "ifx.example.com", port: 9088, database: "stores", instance: "ol_demo", informixMode: "auto", encryption: "login", trustCert: true, extra: "DB_LOCALE=en_US.819", filePath: "", odbcConnStr: "", user: "informix", integratedAuth: false });
const fields = byName(edge, "Informix campos");
assert.deepEqual([fields.cfg.host, fields.cfg.port, fields.cfg.database, fields.cfg.instance, fields.cfg.extra], ["ifx2", 1526, "ventas", "ol_ventas", "CLIENT_LOCALE=es_ES.819"], "fields only, no password from the properties");
const pgMulti = byName(edge, "PG varios");
assert.deepEqual([pgMulti.cfg.host, pgMulti.cfg.port, pgMulti.cfg.database, pgMulti.cfg.encryption, pgMulti.cfg.trustCert], ["pg1", 5433, "app", "required", false], "the URL's sslmode wins over the property");
assert.equal(pgMulti.cfg.extra, "options=-c search_path=ventas;application_name=informes");
assert.deepEqual(pgMulti.notes, ["Celer conecta al primer servidor; no se usan: pg2:5434.", "Propiedades que Celer no usa: tcpKeepAlive."]);
const myMulti = byName(edge, "MySQL varios");
assert.deepEqual([myMulti.cfg.host, myMulti.cfg.port, myMulti.cfg.database, myMulti.cfg.encryption, myMulti.cfg.trustCert, myMulti.cfg.extra], ["my1", 3306, "web", "required", true, "connect_timeout=5"]);
assert.ok(myMulti.notes[0].includes("my2:3307"));
const pgSsl = byName(edge, "PG SSL");
assert.deepEqual([pgSsl.cfg.encryption, pgSsl.cfg.trustCert], ["required", false]);
const plain = byName(edge, "Sin cifrado");
assert.deepEqual([plain.cfg.encryption, plain.cfg.trustCert], ["login", false]);
assert.equal(byName(edge, "Oracle").status, "unsupported");

// The original Informix case: SQLI, «Automático»; DBeaver's properties join the URL's (the URL's value wins).
const [informix] = dbeaver({
  "informix-1": {
    provider: "generic",
    driver: "informix",
    name: "Almacén",
    configuration: {
      host: "db.example.com",
      port: "9088",
      database: "stores",
      url: "jdbc:informix-sqli://db.example.com:9088/stores:informixserver=ol_demo;DB_LOCALE=en_US.819",
      user: "informix",
      properties: { CLIENT_LOCALE: "en_US.819", DB_LOCALE: "otro", password: "no" },
    },
  },
});
assert.deepEqual([informix.cfg.kind, informix.cfg.informixMode, informix.cfg.instance, informix.cfg.database, informix.cfg.port], ["informix", "auto", "ol_demo", "stores", 9088]);
assert.equal(informix.cfg.extra, "DB_LOCALE=en_US.819;CLIENT_LOCALE=en_US.819", "the URL's value wins, no password");

// ---------------------------------------------------------------- passwords only on request

const listed = dbeaver(
  {
    "postgres-jdbc-1": { provider: "postgresql", driver: "postgres-jdbc", name: "Ventas", "save-password": true, configuration: { host: "pg", port: "5432", database: "ventas" } },
    "mysql-2": { provider: "mysql", driver: "mysql8", name: "Web", configuration: { host: "my", port: "3306", database: "web", user: "lector" } },
  },
  "/ws/General/.dbeaver/data-sources.json",
);
assert.equal(listed.length, 2);
assert.ok(listed.every((c) => c.cfg.password === ""), "no password without the option");
assert.equal(listed[0].savedPassword, true);
assert.equal(listed[0].sourceId, "postgres-jdbc-1");
assert.equal(listed[1].cfg.user, "lector", "the plain user is kept");
assert.equal(listed[1].savedPassword, false);
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const key = await crypto.subtle.importKey("raw", fromHex("babb4a9f774ab853c96c2d653dfe544a"), { name: "AES-CBC" }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(16));
const plainCreds = new TextEncoder().encode(JSON.stringify({ "postgres-jdbc-1": { "#connection": { user: "ventas_app", password: "s3cret" } } }));
const credentialsHex = toHex(iv) + toHex(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plainCreds)));
assert.deepEqual(await decryptDbeaverCredentials(credentialsHex), { "postgres-jdbc-1": { "#connection": { user: "ventas_app", password: "s3cret" } } });
const imported = await applyDbeaverCredentials(listed, "/ws/General/.dbeaver/data-sources.json", credentialsHex);
assert.equal(imported[0].cfg.user, "ventas_app");
assert.equal(imported[0].cfg.password, "s3cret");
assert.equal(imported[1].cfg.user, "lector", "connections without credentials keep their user");
assert.equal(imported[1].cfg.password, "");
assert.equal(listed[0].cfg.password, "", "the listed candidates are not changed");
assert.equal((await applyDbeaverCredentials(listed, "/ws/Otro/.dbeaver/data-sources.json", credentialsHex))[0].cfg.password, "");
assert.equal((await applyDbeaverCredentials(listed, "/ws/General/.dbeaver/data-sources.json", "00ff"))[0].cfg.password, "");

// ---------------------------------------------------------------- DbVisualizer

const vis = dbvis(fixture(".dbvis/config230/dbvis.xml"));
assert.equal(vis.length, 8);
assert.ok(vis.every((c) => c.status === "new"), vis.filter((c) => c.status !== "new").map((c) => c.cfg.name).join(", "));
// Variables only (empty URL).
assert.deepEqual(where(byName(vis, "PG variables")), { kind: "postgres", host: "localhost", port: 15432, database: "celer", instance: "", informixMode: "auto", encryption: "login", trustCert: true, extra: "application_name=Celer desde DbVisualizer", filePath: "", odbcConnStr: "", user: "celer", integratedAuth: false });
// Empty variables: the URL wins.
assert.deepEqual([byName(vis, "MySQL URL").cfg.host, byName(vis, "MySQL URL").cfg.port, byName(vis, "MySQL URL").cfg.database, byName(vis, "MySQL URL").cfg.encryption], ["localhost", 33306, "celer", "off"]);
assert.deepEqual([byName(vis, "MariaDB").cfg.port, byName(vis, "MariaDB").cfg.database], [33307, "celer"]);
const visMssql = byName(vis, "SQL Server propiedades");
assert.deepEqual([visMssql.cfg.host, visMssql.cfg.port, visMssql.cfg.database, visMssql.cfg.encryption, visMssql.cfg.trustCert, visMssql.cfg.folder], ["localhost", 1433, "celerdemo", "required", true, "DbVisualizer · Celer · SQL Server"]);
assert.deepEqual([byName(vis, "Informix SQLI").cfg.instance, byName(vis, "Informix SQLI").cfg.port, byName(vis, "Informix SQLI").cfg.informixMode], ["informix", 9088, "auto"]);
assert.deepEqual([byName(vis, "Informix DRDA").cfg.informixMode, byName(vis, "Informix DRDA").cfg.port, byName(vis, "Informix DRDA").cfg.database], ["drda", 9089, "celerdemo"]);
assert.equal(byName(vis, "SQLite memoria").cfg.filePath, ":memory:");
assert.equal(byName(vis, "ODBC CelerPG").cfg.odbcConnStr, "DSN=CelerPG");
assert.ok(vis.every((c) => !c.cfg.password), "DbVisualizer passwords are never imported");
// Informix without port, SQL Server named instance through variables.
const visEdge = dbvis(`<DbVisualizer><Databases>
  <Database id="a"><Alias>Ifx</Alias><Url>jdbc:informix-sqli://ifx/stores:INFORMIXSERVER=ol</Url><Driver>Informix</Driver></Database>
  <Database id="b"><Alias>Inst</Alias><Url>jdbc:sqlserver://x</Url><Driver>SQL Server</Driver>
    <UrlVariables><UrlVariable UrlVariableName="Server">sql03</UrlVariable><UrlVariable UrlVariableName="Instance">TEST</UrlVariable><UrlVariable UrlVariableName="Database">crm</UrlVariable></UrlVariables></Database>
  <Database id="c"><Alias>Entidades &amp; CDATA</Alias><Url><![CDATA[jdbc:postgresql://h/db?sslmode=require]]></Url><Driver>PostgreSQL</Driver></Database>
</Databases></DbVisualizer>`);
assert.deepEqual([visEdge[0].cfg.host, visEdge[0].cfg.port, visEdge[0].cfg.instance], ["ifx", 9088, "ol"]);
assert.deepEqual([visEdge[1].cfg.host, visEdge[1].cfg.instance, visEdge[1].cfg.port, visEdge[1].cfg.database], ["sql03", "TEST", null, "crm"]);
assert.deepEqual([visEdge[2].cfg.name, visEdge[2].cfg.encryption, visEdge[2].cfg.host], ["Entidades & CDATA", "required", "h"]);
// The XML reader refuses what is not XML.
assert.throws(() => parseXml("<a><b></a>"), /no es un XML válido/);
assert.throws(() => parseXml("texto"), /no es un XML válido/);
assert.equal(parseXml(`<a x='1' y="&lt;2&gt;"><!-- c --><b/>t&#233;</a>`).children[0].attrs.y, "<2>");

console.log("migrate parse: ok");
