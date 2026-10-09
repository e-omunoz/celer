// Checks for src/connTree.ts (explorer: nested folders, order, search and filters, export and import without
// passwords): node --experimental-strip-types dev/explorer-check.ts
import assert from "node:assert/strict";
import {
  allFolders,
  buildConnTree,
  connIdentity,
  connMatches,
  countConns,
  exportConnectionsJson,
  filterActive,
  folderName,
  inlinePassword,
  insertAt,
  isInside,
  joinFolder,
  NO_FILTER,
  normalizeFolder,
  parentFolder,
  parseConnectionsJson,
  passesFilter,
  planImport,
  pushRecent,
  renameFolderPath,
  sortConns,
  toggleIn,
  uniqueName,
  withoutInlinePassword,
} from "../src/connTree.ts";
import { emptyConn, type ConnConfig, type DbKind } from "../src/types.ts";

function conn(id: string, name: string, folder = "", kind: DbKind = "postgres", extra: Partial<ConnConfig> = {}): ConnConfig {
  return { ...emptyConn(kind), id, name, folder, ...extra };
}

// ---------------------------------------------------------------- folders
assert.equal(normalizeFolder(" Clientes / Egarsat/ "), "Clientes/Egarsat");
assert.equal(joinFolder("Clientes", "Egarsat"), "Clientes/Egarsat");
assert.equal(joinFolder("", "A"), "A");
assert.equal(parentFolder("A/B/C"), "A/B");
assert.equal(parentFolder("A"), "");
assert.equal(folderName("A/B/C"), "C");
assert.ok(isInside("A/B", "A") && isInside("A", "A") && !isInside("AB", "A") && !isInside("A", "A/B"));
// Renaming or moving a folder carries its subfolders; others stay.
assert.equal(renameFolderPath("A/B/C", "A/B", "X"), "X/C");
assert.equal(renameFolderPath("A/B", "A/B", "A/Z"), "A/Z");
assert.equal(renameFolderPath("A/BC", "A/B", "X"), "A/BC");
// Deleting "A/B" moves its contents one level up (to its parent).
assert.equal(renameFolderPath("A/B/C", "A/B", parentFolder("A/B")), "A/C");
assert.equal(renameFolderPath("A/B", "A/B", parentFolder("A/B")), "A");
// Ancestors are listed even when only a nested folder is used; an old " · " name is a plain folder.
assert.deepEqual(allFolders(["Clientes/Egarsat", "DBeaver · Prod"], ["Vacía", "Clientes"]), ["Clientes", "Clientes/Egarsat", "DBeaver · Prod", "Vacía"]);
assert.equal(uniqueName("Nueva carpeta", ["nueva carpeta", "Nueva carpeta 2"]), "Nueva carpeta 3");
assert.equal(uniqueName("Otra", ["Nueva carpeta"]), "Otra");

// ---------------------------------------------------------------- order and tree
const list = [conn("1", "zeta"), conn("2", "Árbol", "Clientes/Egarsat"), conn("3", "beta 10", "Clientes"), conn("4", "beta 9", "Clientes"), conn("5", "alfa", "Dev")];
assert.deepEqual(sortConns(list, "manual").map((c) => c.id), ["1", "2", "3", "4", "5"]);
assert.deepEqual(sortConns(list, "alpha").map((c) => c.name), ["alfa", "Árbol", "beta 9", "beta 10", "zeta"]);
const manual = buildConnTree(list, ["Vacía"], "manual");
assert.deepEqual(manual.conns.map((c) => c.id), ["1"]);
assert.deepEqual(manual.folders.map((f) => f.path), ["Clientes", "Dev", "Vacía"]);
assert.deepEqual(manual.folders[0].folders.map((f) => f.path), ["Clientes/Egarsat"]);
assert.deepEqual(manual.folders[0].conns.map((c) => c.id), ["3", "4"]);
assert.equal(manual.folders[2].conns.length, 0, "an empty folder the user created");
assert.equal(countConns(manual.folders[0]), 3);
const alpha = buildConnTree(list, ["Aaa"], "alpha");
assert.deepEqual(alpha.folders.map((f) => f.name), ["Aaa", "Clientes", "Dev"]);
assert.deepEqual(alpha.folders[1].conns.map((c) => c.name), ["beta 9", "beta 10"]);

// ---------------------------------------------------------------- search and filters
const pg = conn("p", "Ventas", "Clientes/Egarsat", "postgres", { host: "db.example.com", database: "ventas", user: "lector" });
const ifx = conn("i", "Almacén", "", "informix", { host: "ifx01", database: "stores", instance: "ol_demo", production: true });
assert.ok(connMatches(pg, "") && connMatches(pg, "  "));
assert.ok(connMatches(pg, "pg") && connMatches(pg, "postgresql") && connMatches(pg, "example"));
assert.ok(connMatches(pg, "egarsat ventas"), "every word, in any field");
assert.ok(!connMatches(pg, "egarsat stores"));
assert.ok(connMatches(ifx, "ifx") && connMatches(ifx, "ol_demo") && connMatches(ifx, "9088"));
assert.ok(connMatches(conn("m", "x", "", "mssql"), "sqlserver"));
assert.ok(!filterActive(NO_FILTER) && filterActive({ ...NO_FILTER, kinds: ["mysql"] }));
const isConnected = (id: string) => id === "i";
assert.ok(passesFilter(pg, NO_FILTER, [], isConnected));
assert.ok(!passesFilter(pg, { ...NO_FILTER, favorites: true }, [], isConnected));
assert.ok(passesFilter(pg, { ...NO_FILTER, favorites: true }, ["p"], isConnected));
assert.ok(!passesFilter(pg, { ...NO_FILTER, connected: true }, [], isConnected));
assert.ok(passesFilter(ifx, { ...NO_FILTER, connected: true, production: true, kinds: ["informix", "mssql"] }, [], isConnected));
assert.ok(!passesFilter(pg, { ...NO_FILTER, kinds: ["informix"] }, [], isConnected));

// ---------------------------------------------------------------- favourites, recents, undo position
assert.deepEqual(toggleIn(["a"], "b"), ["a", "b"]);
assert.deepEqual(toggleIn(["a", "b"], "a"), ["b"]);
let recent = pushRecent([], "a", 1);
recent = pushRecent(recent, "b", 2);
recent = pushRecent(recent, "a", 3);
assert.deepEqual(recent, [{ id: "a", at: 3 }, { id: "b", at: 2 }]);
assert.equal(pushRecent(Array.from({ length: 20 }, (_, i) => ({ id: String(i), at: i })), "x", 99, 8).length, 8);
assert.deepEqual(insertAt(["a", "b", "c"], "x", 1), ["a", "x", "b", "c"]);
assert.deepEqual(insertAt(["a", "b"], "x", 9), ["a", "b", "x"]);
assert.deepEqual(insertAt(["a", "x", "b"], "x", 0), ["x", "a", "b"]);

// ---------------------------------------------------------------- export and import without passwords
const secret = conn("id-1", "Producción", "Clientes/Egarsat", "mssql", { host: "sql01", port: 1433, user: "sa", password: "S3creta", database: "crm", production: true, startupSql: "SET LOCK_TIMEOUT 5000;" });
const text = exportConnectionsJson([secret, ifx], ["Vacía"], new Date("2026-10-08T10:00:00Z"));
assert.ok(!text.includes("S3creta") && !text.includes("\"password\""), "never a password");
assert.ok(!text.includes("id-1") && !text.includes("\"id\""), "no ids: they are new on import");
// Nor one typed into an ODBC string or "Parámetros extra".
const inline = exportConnectionsJson([conn("id-2", "Odbc", "", "odbc", { odbcConnStr: "DSN=x;UID=u;PWD={a;b}}c};Trusted=no", extra: "password=p2\nssl=1" })], [], new Date());
assert.ok(!inline.includes("a;b") && !inline.includes("p2"), inline);
assert.equal(JSON.parse(inline).connections[0].odbcConnStr, "DSN=x;UID=u;Trusted=no");
assert.equal(JSON.parse(inline).connections[0].extra, "ssl=1");
assert.equal(inlinePassword("DSN=x;Pwd = {a;b}}c} ;UID=u"), "a;b}c");
assert.equal(inlinePassword("DSN=x;PasswordFile=y"), null);
assert.equal(withoutInlinePassword("PWD=s;DSN=x"), "DSN=x");
const doc = JSON.parse(text);
assert.equal(doc.format, "celer-connections");
assert.equal(doc.version, 1);
assert.deepEqual(doc.folders, ["Clientes", "Clientes/Egarsat", "Vacía"]);
const back = parseConnectionsJson(text);
assert.equal(back.connections.length, 2);
assert.equal(back.connections[0].id, "");
assert.equal(back.connections[0].password, "");
assert.equal(back.connections[0].host, "sql01");
assert.equal(back.connections[0].production, true);
assert.equal(back.connections[0].startupSql, "SET LOCK_TIMEOUT 5000;");
assert.equal(back.connections[1].instance, "ol_demo");
assert.deepEqual(back.folders, ["Clientes", "Clientes/Egarsat", "Vacía"]);
// A missing field takes the engine's default; a wrong type is ignored; an unknown engine or a foreign file fail.
const partial = parseConnectionsJson(JSON.stringify({ format: "celer-connections", version: 1, connections: [{ kind: "mysql", name: "", host: 7, port: 99999 }] }));
assert.equal(partial.connections[0].port, 3306);
assert.equal(partial.connections[0].host, "localhost");
assert.equal(partial.connections[0].name, "Conexión 1");
assert.throws(() => parseConnectionsJson("{"), /JSON válido/);
assert.throws(() => parseConnectionsJson(JSON.stringify({ connections: [] })), /exportación de conexiones de Celer/);
assert.throws(() => parseConnectionsJson(JSON.stringify({ format: "celer-connections", version: 1, connections: [{ kind: "oracle" }] })), /motor desconocido/);
assert.throws(() => parseConnectionsJson(JSON.stringify({ format: "celer-connections", version: 9, connections: [] })), /Versión/);
// Duplicates: the same server, database and user (case-insensitive) are not imported twice, not even within the file.
assert.equal(connIdentity({ ...secret, host: "SQL01" }), connIdentity(secret));
const plan = planImport([secret], [...back.connections, { ...back.connections[1] }]);
assert.deepEqual(plan.fresh.map((c) => c.name), ["Almacén"]);
assert.equal(plan.duplicates.length, 2);

console.log("explorer: ok");
