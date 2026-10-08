// Checks for src/migrateParse.ts (JDBC URLs and DBeaver connections): node --experimental-strip-types dev/migrate-check.ts
import assert from "node:assert/strict";
import { applyDbeaverCredentials, decryptDbeaverCredentials, parseDbeaver, parseJdbcUrl } from "../src/migrateParse.ts";

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

// Passwords: listing never brings them (the credentials file is not even read); they are applied only on request.
const withSaved = JSON.stringify({
  connections: {
    "postgres-jdbc-1": { provider: "postgresql", driver: "postgres-jdbc", name: "Ventas", "save-password": true, configuration: { host: "pg", port: "5432", database: "ventas" } },
    "mysql-2": { provider: "mysql", driver: "mysql8", name: "Web", configuration: { host: "my", port: "3306", database: "web", user: "lector" } },
  },
});
const source = { tool: "dbeaver" as const, project: "General", path: "/ws/General/.dbeaver/data-sources.json", text: withSaved };
const listed = parseDbeaver(source);
assert.equal(listed.length, 2);
assert.ok(listed.every((c) => c.cfg.password === ""), "no password without the option");
assert.equal(listed[0].savedPassword, true);
assert.equal(listed[0].sourceId, "postgres-jdbc-1");
assert.equal(listed[0].sourcePath, source.path);
assert.equal(listed[1].cfg.user, "lector", "the plain user is kept");
assert.equal(listed[1].savedPassword, false);

// credentials-config.json as DBeaver writes it: AES-128-CBC with its default key, the IV in the first 16 bytes.
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const key = await crypto.subtle.importKey("raw", fromHex("babb4a9f774ab853c96c2d653dfe544a"), { name: "AES-CBC" }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(16));
const plain = new TextEncoder().encode(JSON.stringify({ "postgres-jdbc-1": { "#connection": { user: "ventas_app", password: "s3cret" } } }));
const credentialsHex = toHex(iv) + toHex(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plain)));
assert.deepEqual(await decryptDbeaverCredentials(credentialsHex), { "postgres-jdbc-1": { "#connection": { user: "ventas_app", password: "s3cret" } } });

const imported = await applyDbeaverCredentials(listed, source.path, credentialsHex);
assert.equal(imported[0].cfg.user, "ventas_app");
assert.equal(imported[0].cfg.password, "s3cret");
assert.equal(imported[1].cfg.user, "lector", "connections without credentials keep their user");
assert.equal(imported[1].cfg.password, "");
assert.equal(listed[0].cfg.password, "", "the listed candidates are not changed");
// Credentials of another DBeaver project never apply; a damaged file applies nothing.
assert.equal((await applyDbeaverCredentials(listed, "/ws/Otro/.dbeaver/data-sources.json", credentialsHex))[0].cfg.password, "");
assert.equal((await applyDbeaverCredentials(listed, source.path, "00ff"))[0].cfg.password, "");

console.log("migrate parse: ok");
