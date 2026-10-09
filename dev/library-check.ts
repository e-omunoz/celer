// Quick checks for src/libraryModel.ts: node --experimental-strip-types dev/library-check.ts
import assert from "node:assert/strict";
import {
  allTags,
  buildTree,
  copyName,
  engineLabel,
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
  normalizeParams,
  normalizeTags,
  normalizeTargets,
  paramRows,
  paramsToKeep,
  parseQuery,
  parseSqlFile,
  removeFolder,
  renameFolder,
  schemaSetupSql,
  scriptIdOf,
  serializeLibrary,
  sortScripts,
  statementCount,
  targetHasDatabase,
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

// Version 3: description, engine, params, favourite and targets; invalid values dropped, absent ones stay absent.
const v3 = migrateLibrary({
  version: 3,
  scripts: [
    {
      id: "p",
      name: "Pedidos",
      sql: "SELECT * FROM orders WHERE created >= :desde AND total > ${minimo}",
      description: "  Pedidos desde una fecha  ",
      engine: "postgres",
      favorite: true,
      params: [{ name: ":desde", default: "2026-01-01", description: "Fecha" }, { name: "${minimo}", default: 10 }, { name: "mal nombre" }, { name: "desde", default: "x" }],
      targets: [{ connId: "c1", database: "ventas", schema: " public " }, { connId: "c1", database: "VENTAS", schema: "PUBLIC" }, { connId: "" }, { connId: "c2" }],
    },
    { id: "q", name: "Raro", sql: "x", engine: "oracle", favorite: "yes", params: "a", targets: {}, description: 7 },
  ],
});
assert.deepEqual(v3.scripts[0].params, [{ name: "desde", default: "2026-01-01", description: "Fecha" }, { name: "minimo", default: "10", description: "" }], "names without :, ${} and repeats");
assert.equal(v3.scripts[0].description, "Pedidos desde una fecha");
assert.equal(v3.scripts[0].engine, "postgres");
assert.equal(v3.scripts[0].favorite, true);
assert.deepEqual(v3.scripts[0].targets, [{ connId: "c1", database: "ventas", schema: "public" }, { connId: "c2", database: "" }], "the same target once, in any case");
for (const key of ["description", "engine", "params", "favorite", "targets"]) assert.ok(!(key in v3.scripts[1]), `an invalid ${key} is dropped`);
assert.ok(!("description" in migrated.scripts[0]) && !("params" in migrated.scripts[0]), "a version 1 script gets no empty new fields");
assert.deepEqual(migrateLibrary(JSON.parse(JSON.stringify(serializeLibrary(v3)))).scripts, v3.scripts, "version 3 reads back the same");
assert.equal(LIBRARY_VERSION, 3);

// Bundles carry what describes a script (not favourites or targets, which are this machine's own).
const described = script("Pedidos", { sql: "SELECT :desde", description: "Desde una fecha", engine: "generic", params: [{ name: "desde", default: "2026-01-01", description: "Fecha" }], favorite: true, targets: [{ connId: "c1", database: "" }] });
const describedBundle = exportBundle([described]);
assert.match(describedBundle, /"description":"Desde una fecha"/);
assert.doesNotMatch(describedBundle, /favorite|targets/);
assert.deepEqual(parseSqlFile("b.sql", describedBundle), [
  { name: "Pedidos", sql: "SELECT :desde", folder: "", tags: [], description: "Desde una fecha", engine: "generic", params: [{ name: "desde", default: "2026-01-01", description: "Fecha" }] },
]);
assert.deepEqual(parseSqlFile("b.sql", '-- @celer-script {"name":"X","engine":"db2","params":3}\nSELECT 1'), [{ name: "X", sql: "SELECT 1", folder: "", tags: [], }], "unknown engines and bad params are left out");
assert.ok(matchesQuery(described, parseQuery("fecha")), "the description is searched");

// Favourites and recent on top (and still in their folders); not while searching.
const pinnedData: LibraryData = {
  scripts: [
    script("a", { folder: "F", favorite: true }),
    script("b", { usedAt: 50 }),
    script("c", { usedAt: 90, favorite: true }),
    script("d", { usedAt: 70 }),
    ...Array.from({ length: 6 }, (_, i) => script(`r${i}`, { usedAt: 10 + i })),
  ],
  folders: ["F"],
};
const pinnedRows = buildTree(pinnedData, { pinned: true });
assert.deepEqual(
  pinnedRows.slice(0, 11).map((row) => row.key),
  ["x:fav", "fav:a", "fav:c", "x:recent", "rec:d", "rec:b", "rec:r5", "rec:r4", "rec:r3", "x:all", "f:F"],
  "favourites by name, then the 5 most recently used that are not favourites",
);
assert.equal(pinnedRows.filter((row) => row.kind === "script" && !row.section).length, pinnedData.scripts.length, "every script is still in the tree");
assert.ok(!buildTree(pinnedData, { pinned: true, query: "a" }).some((row) => row.kind === "section"), "no sections while searching");
assert.ok(!buildTree({ scripts: [script("x")], folders: [] }, { pinned: true }).some((row) => row.kind === "section"), "no sections when nothing is pinned or used");
assert.deepEqual(keys(pinnedData, { include: (s: LibraryScript) => s.name.startsWith("r") }).length, 6, "any other filter");
assert.equal(scriptIdOf("fav:abc"), "abc");
assert.equal(scriptIdOf("rec:a:b"), "a:b");
assert.equal(scriptIdOf("s:x"), "x");
assert.equal(scriptIdOf("f:x"), "");

// Running: statements, parameters, targets.
assert.equal(statementCount("SELECT 1; -- fin\nSELECT 2;\n-- nada"), 2);
assert.equal(statementCount("SELECT ';'"), 1, "a ; in a string does not split");
assert.deepEqual(paramRows("SELECT :a, :b, ?", [{ name: "b", default: "2", description: "Be" }, { name: "old", default: "x", description: "" }], "mysql"), [
  { name: "a", default: "", description: "", used: true },
  { name: "b", default: "2", description: "Be", used: true },
  { name: "?1", default: "", description: "", used: true },
  { name: "old", default: "x", description: "", used: false },
]);
assert.deepEqual(paramsToKeep([{ name: "a", default: "", description: " " }, { name: "b", default: "0", description: "" }, { name: "c", default: "", description: "Ce" }]), [
  { name: "b", default: "0", description: "" },
  { name: "c", default: "", description: "Ce" },
], "empty ones are not kept");
assert.equal(schemaSetupSql("postgres", "ventas"), 'SET search_path TO "ventas", public');
assert.equal(schemaSetupSql("postgres", "Raro\"x"), 'SET search_path TO "Raro""x", public');
assert.equal(schemaSetupSql("postgres", "public"), 'SET search_path TO "public"');
assert.equal(schemaSetupSql("postgres", " "), null);
for (const kind of ["mysql", "mssql", "sqlite", "informix", "odbc"] as const) assert.equal(schemaSetupSql(kind, "x"), null, kind);
assert.ok(targetHasDatabase("postgres") && targetHasDatabase("mssql") && !targetHasDatabase("sqlite") && !targetHasDatabase("odbc"));
assert.deepEqual(normalizeTargets([{ connId: "a", database: " db " }, { connId: "a", database: "DB" }]), [{ connId: "a", database: "db" }]);
assert.deepEqual(normalizeParams([{ name: "?2", default: "1" }]), [{ name: "?2", default: "1", description: "" }]);
assert.equal(engineLabel("generic"), "Genérico / SQL estándar");

console.log("library-check: all good");
