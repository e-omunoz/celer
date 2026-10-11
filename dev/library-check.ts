// Quick checks for src/libraryModel.ts: node --experimental-strip-types dev/library-check.ts
import assert from "node:assert/strict";
import {
  allTags,
  buildTree,
  copyName,
  exportBundle,
  exportScript,
  fileNameFor,
  folderChain,
  freeName,
  inFolder,
  LIBRARY_VERSION,
  matchesQuery,
  migrateLibrary,
  moveFolder,
  normalizeFolder,
  normalizeTags,
  parseQuery,
  parseSqlFile,
  removeFolder,
  renameFolder,
  serializeLibrary,
  sortScripts,
  toggleTagInQuery,
  withParents,
  type LibraryData,
  type LibraryScript,
} from "../src/libraryModel.ts";

const script = (id: string, extra: Partial<LibraryScript> = {}): LibraryScript => ({ id, name: id, sql: `SELECT '${id}'`, connId: null, folder: "", tags: [], createdAt: 1, updatedAt: 1, ...extra });
const keys = (data: LibraryData, options = {}) => buildTree(data, options).map((row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/ (${row.count})` : row.script.name}`);

// Folders and tags.
assert.equal(normalizeFolder("  Informes / /Mensuales\\ "), "Informes/Mensuales");
assert.equal(normalizeFolder("a/../b/./c"), "a/b/c", "no dot parts");
assert.equal(normalizeFolder(undefined), "");
assert.equal(normalizeFolder(42), "");
assert.deepEqual(folderChain("A/B/C"), ["A", "A/B", "A/B/C"]);
assert.deepEqual(folderChain(""), []);
assert.ok(inFolder("A/B", "A") && inFolder("A", "A") && inFolder("X", ""));
assert.ok(!inFolder("AB", "A"), "a prefix of the name is not a parent");
assert.deepEqual(normalizeTags("ventas, #Mensual  ventas"), ["ventas", "Mensual"]);
assert.deepEqual(normalizeTags(["a", "A", 3, "b c"]), ["a", "b", "c"]);
assert.deepEqual(normalizeTags(null), []);
assert.deepEqual(withParents(["B/C"], [script("x", { folder: "A/D" })]), ["A", "A/D", "B", "B/C"]);
assert.deepEqual(withParents(["A B", "A/B", "A"], []), ["A", "A/B", "A B"], "subfolders right under their parent");
assert.deepEqual(allTags([script("a", { tags: ["x", "y"] }), script("b", { tags: ["X"] })]), [{ tag: "x", count: 2 }, { tag: "y", count: 1 }]);

// Migration from version 1: nothing is lost.
const v1 = {
  version: 1,
  scripts: [
    { id: "1", name: "Ventas", sql: "SELECT 1", connId: "c1", createdAt: 10, updatedAt: 20, color: "red" },
    { id: "2", name: "Sin fechas", sql: "SELECT 2" },
    { id: "1", name: "Id repetido", sql: "SELECT 3", connId: null, createdAt: 5, updatedAt: 6 },
    { id: "bad", name: 3, sql: "x" },
    null,
  ],
  owner: "keep me",
};
const migrated = migrateLibrary(v1);
assert.equal(migrated.scripts.length, 3, "the invalid ones are left out");
assert.deepEqual(migrated.scripts[0], { id: "1", name: "Ventas", sql: "SELECT 1", connId: "c1", folder: "", tags: [], createdAt: 10, updatedAt: 20, color: "red" });
assert.equal(migrated.scripts[1].connId, null);
assert.equal(migrated.scripts[1].createdAt, 0);
assert.equal(migrated.scripts[2].id, "1-2", "a repeated id gets a new one");
assert.equal(migrated.scripts[2].name, "Id repetido");
assert.deepEqual(migrated.folders, []);
assert.deepEqual(migrated.extra, { owner: "keep me" });
const saved = serializeLibrary(migrated, migrated.extra);
assert.equal(saved.version, LIBRARY_VERSION);
assert.equal(saved.owner, "keep me");
assert.deepEqual(migrateLibrary(JSON.parse(JSON.stringify(saved))).scripts, migrated.scripts, "a saved file reads back the same");
assert.deepEqual(migrateLibrary(null), { scripts: [], folders: [], extra: {} });
assert.deepEqual(migrateLibrary([1, 2]).scripts, []);
const v2 = migrateLibrary({ version: 2, scripts: [{ id: "a", name: "A", sql: "x", folder: "Informes//Mes", tags: "uno,dos", usedAt: 7 }], folders: ["Vacía", "", 4] });
assert.equal(v2.scripts[0].folder, "Informes/Mes");
assert.deepEqual(v2.scripts[0].tags, ["uno", "dos"]);
assert.equal(v2.scripts[0].usedAt, 7);
assert.deepEqual(v2.folders, ["Informes", "Informes/Mes", "Vacía"]);

// Names.
assert.equal(copyName("Ventas", ["Ventas"]), "Ventas (copia)");
assert.equal(copyName("Ventas", ["Ventas", "ventas (copia)"]), "Ventas (copia 2)");
assert.equal(copyName("Ventas (copia)", ["Ventas", "Ventas (copia)"]), "Ventas (copia 2)", "a copy of a copy");
assert.equal(freeName("Nueva carpeta", []), "Nueva carpeta");
assert.equal(freeName("Nueva carpeta", ["nueva carpeta", "Nueva carpeta 2"]), "Nueva carpeta 3");
assert.equal(fileNameFor('Ventas: "mes"/año?'), "Ventas_ _mes__año_.sql");
assert.equal(fileNameFor("  ...  "), "script.sql");
assert.equal(fileNameFor("informe."), "informe.sql");

// Search.
assert.deepEqual(parseQuery("Ventas #Mensual  2024 #"), { words: ["ventas", "2024"], tags: ["mensual"] });
const tagged = script("Ventas por mes", { sql: "SELECT * FROM orders", folder: "Informes", tags: ["Mensual"] });
assert.ok(matchesQuery(tagged, parseQuery("ventas")));
assert.ok(matchesQuery(tagged, parseQuery("orders informes")), "the SQL and the folder count");
assert.ok(matchesQuery(tagged, parseQuery("#mensual")));
assert.ok(matchesQuery(tagged, parseQuery("mensual")), "a tag is also a word");
assert.ok(!matchesQuery(tagged, parseQuery("#ventas")), "#tag only looks at tags");
assert.ok(!matchesQuery(tagged, parseQuery("ventas clientes")), "every word must appear");
assert.equal(toggleTagInQuery("ventas", "Mensual"), "ventas #Mensual");
assert.equal(toggleTagInQuery("ventas #mensual", "Mensual"), "ventas");
const a = script("b", { updatedAt: 5 });
const b = script("A", { updatedAt: 1, usedAt: 9 });
const c = script("c", { updatedAt: 7 });
assert.deepEqual(sortScripts([a, b, c], "name").map((s) => s.name), ["A", "b", "c"]);
assert.deepEqual(sortScripts([a, b, c], "recent").map((s) => s.name), ["A", "c", "b"], "used counts as recent");

// The tree.
const data: LibraryData = {
  scripts: [
    script("raíz"),
    script("mensual", { folder: "Informes/Mensuales", tags: ["mes"] }),
    script("anual", { folder: "Informes", connId: "c2" }),
    script("limpieza", { folder: "Mantenimiento", connId: "c1" }),
  ],
  folders: ["Informes", "Informes/Mensuales", "Mantenimiento", "Vacía"],
};
assert.deepEqual(keys(data), ["Informes/ (2)", "  Mensuales/ (1)", "    mensual", "  anual", "Mantenimiento/ (1)", "  limpieza", "Vacía/ (0)", "raíz"]);
assert.deepEqual(keys(data, { collapsed: new Set(["Informes"]) }), ["Informes/ (2)", "Mantenimiento/ (1)", "  limpieza", "Vacía/ (0)", "raíz"]);
assert.deepEqual(keys(data, { query: "#mes", collapsed: new Set(["Informes"]) }), ["Informes/ (1)", "  Mensuales/ (1)", "    mensual"], "a search opens the folders it needs and hides the rest");
assert.deepEqual(keys(data, { connId: "c1" }), ["Informes/ (1)", "  Mensuales/ (1)", "    mensual", "Mantenimiento/ (1)", "  limpieza", "raíz"], "this connection's and those of none");
assert.deepEqual(keys(data, { query: "nada" }), []);
const rows = buildTree(data);
assert.equal(rows[0].kind === "folder" && rows[0].key, "f:Informes");
assert.equal(rows[2].kind === "script" && rows[2].key, "s:mensual");

// Folder operations.
const renamed = renameFolder(data, "Informes", "Reports")!;
assert.deepEqual(renamed.scripts.map((s) => s.folder), ["", "Reports/Mensuales", "Reports", "Mantenimiento"]);
assert.deepEqual(renamed.folders, ["Mantenimiento", "Reports", "Reports/Mensuales", "Vacía"]);
assert.equal(renameFolder(data, "Informes", "Informes/Dentro"), null, "not into itself");
assert.equal(renameFolder(data, "Informes", "  "), null, "not to an empty name");
assert.equal(renameFolder(data, "Informes", "Informes"), data, "same name: nothing to do");
assert.equal(renameFolder(data, "Info", "X")!.scripts[2].folder, "Informes", "a name that only starts the same is another folder");
const moved = moveFolder(data, "Informes/Mensuales", "Mantenimiento")!;
assert.equal(moved.scripts[1].folder, "Mantenimiento/Mensuales");
assert.deepEqual(moved.folders, ["Informes", "Mantenimiento", "Mantenimiento/Mensuales", "Vacía"]);
assert.equal(moveFolder(data, "Informes/Mensuales", "")!.scripts[1].folder, "Mensuales", "to the top level");
assert.equal(moveFolder(data, "Informes", "Informes/Mensuales"), null);
const merged = renameFolder(data, "Mantenimiento", "Informes")!;
assert.deepEqual(merged.scripts.map((s) => s.folder), ["", "Informes/Mensuales", "Informes", "Informes"], "onto an existing folder: they merge");
const { data: pruned, removed } = removeFolder(data, "Informes");
assert.deepEqual(removed.map((s) => s.name), ["mensual", "anual"]);
assert.deepEqual(pruned.scripts.map((s) => s.name), ["raíz", "limpieza"]);
assert.deepEqual(pruned.folders, ["Mantenimiento", "Vacía"]);

// .sql files.
assert.equal(exportScript(script("x", { sql: "SELECT 1" })), "SELECT 1\n");
assert.equal(exportScript(script("x", { sql: "SELECT 1\n" })), "SELECT 1\n");
const bundle = exportBundle([script("Uno", { sql: "SELECT 1;\n\n", folder: "A/B", tags: ["t"] }), script("Dos", { sql: "-- nota\nSELECT 2" })]);
assert.match(bundle, /^-- Celer: 2 scripts/);
assert.deepEqual(parseSqlFile("biblioteca.sql", bundle), [
  { name: "Uno", sql: "SELECT 1;", folder: "A/B", tags: ["t"] },
  { name: "Dos", sql: "-- nota\nSELECT 2", folder: "", tags: [] },
]);
assert.deepEqual(parseSqlFile("biblioteca.sql", bundle.replace(/\n/g, "\r\n")).map((s) => s.sql), ["SELECT 1;", "-- nota\nSELECT 2"], "CRLF files too");
assert.deepEqual(parseSqlFile("C:\\scripts\\Ventas mes.SQL", "\uFEFFSELECT 1\r\nFROM t\r\n"), [{ name: "Ventas mes", sql: "SELECT 1\nFROM t", folder: "", tags: [] }]);
assert.deepEqual(parseSqlFile("vacío.sql", "  \n"), []);
const odd = parseSqlFile("x.sql", 'SELECT 0;\n-- @celer-script {roto\nSELECT 1\n-- @celer-script {"name":"  "}\nSELECT 2');
assert.deepEqual(odd.map((s) => [s.name, s.sql]), [["x", "SELECT 0;"], ["x 1", "SELECT 1"], ["x 2", "SELECT 2"]], "text before the first mark, damaged marks and empty names");

// A script an assistant added (MCP, #100) keeps its notes and who added it through a save and a read.
const byAi = migrateLibrary({ version: 2, scripts: [{ id: "a", name: "IA", sql: "SELECT 1", folder: "IA", tags: ["ia"], notes: "Ventas por mes", addedBy: "claude-code · WSL (Ubuntu)", createdAt: 1, updatedAt: 1 }] });
const reread = migrateLibrary(JSON.parse(JSON.stringify(serializeLibrary(byAi))));
assert.equal(reread.scripts[0].notes, "Ventas por mes");
assert.equal(reread.scripts[0].addedBy, "claude-code · WSL (Ubuntu)");

console.log("library-check: all good");
