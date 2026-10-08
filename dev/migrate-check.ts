// Checks for src/migrateParse.ts (JDBC URLs and DBeaver connections): node --experimental-strip-types dev/migrate-check.ts
import assert from "node:assert/strict";
import { parseDbeaver, parseJdbcUrl } from "../src/migrateParse.ts";

// Informix: the server name goes to INFORMIXSERVER, the other properties to "Parámetros extra"; never the password.
assert.deepEqual(parseJdbcUrl("jdbc:informix-sqli://db.example.com:9088/ventas:informixserver=ol_ventas;DB_LOCALE=es_ES.819;IFX_LOCK_MODE_WAIT=10;password=x;user=y"), {
  host: "db.example.com",
  port: 9088,
  database: "ventas",
  instance: "ol_ventas",
  params: "DB_LOCALE=es_ES.819;IFX_LOCK_MODE_WAIT=10",
});
assert.deepEqual(parseJdbcUrl("jdbc:informix-sqli://10.0.0.5:9088/stores:INFORMIXSERVER=demo_on"), { host: "10.0.0.5", port: 9088, database: "stores", instance: "demo_on", params: undefined });
// No database, and a value with "=".
assert.deepEqual(parseJdbcUrl("jdbc:informix-sqli://h:1526:INFORMIXSERVER=s;OPT=a=b"), { host: "h", port: 1526, database: undefined, instance: "s", params: "OPT=a=b" });
// The other engines are unchanged.
assert.deepEqual(parseJdbcUrl("jdbc:postgresql://pg:5432/app"), { host: "pg", port: 5432, database: "app" });
assert.equal(parseJdbcUrl("jdbc:sqlserver://sql\\SQLEXPRESS:1433;databaseName=crm").instance, "SQLEXPRESS");

// A DBeaver Informix connection: SQLI, so "Automático"; DBeaver's driver properties join the URL's.
const dbeaver = JSON.stringify({
  connections: {
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
  },
});
const [informix] = await parseDbeaver({ tool: "dbeaver", project: "General", path: "data-sources.json", text: dbeaver });
assert.equal(informix.status, "new");
assert.equal(informix.cfg.kind, "informix");
assert.equal(informix.cfg.informixMode, "auto");
assert.equal(informix.cfg.instance, "ol_demo");
assert.equal(informix.cfg.database, "stores");
assert.equal(informix.cfg.port, 9088);
assert.equal(informix.cfg.extra, "DB_LOCALE=en_US.819;CLIENT_LOCALE=en_US.819", "the URL's value wins, no password");

console.log("migrate parse: ok");
