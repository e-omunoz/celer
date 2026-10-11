// Checks for src/compare.ts: node --experimental-strip-types dev/compare-check.ts
import assert from "node:assert/strict";
import { canonicalBool, canonicalDate, canonicalNumber, compareResults, comparisonTable, guessKey, onlyDifferences, singleTableOf } from "../src/compare.ts";

const cols = (...names: string[]) => names.map((name) => ({ name, typeName: "", kind: "text" as const }));
const rs = (columns: string[], rows: unknown[][]) => ({ columns: cols(...columns), rows: rows as never, hasMore: false, rowsAffected: null });

const before = rs(["id", "name", "total"], [[1, "Ana", 10], [2, "Luis", 20], [3, "Mia", 30], [4, "Hugo", null]]);
const after = rs(["id", "name", "total"], [[1, "Ana", 10], [2, "Luis", 25], [4, "Hugo", 5], [5, "Nora", 50]]);
assert.deepEqual(guessKey(before, after), ["id"]);
const c = compareResults(before, after);
assert.deepEqual(c.counts, { equal: 1, changed: 2, gone: 1, added: 1 });
assert.deepEqual(c.key, ["id"]);
// Changed cells point at the new value's position and keep the old value.
const luis = c.rows.findIndex((r) => r[0] === 2);
assert.equal(c.changed[`${luis}:2`], "20");
const hugo = c.rows.findIndex((r) => r[0] === 4);
assert.equal(c.changed[`${hugo}:2`], null, "NULL → 5 is a change from NULL");
// Order: matched rows, then gone, then new.
assert.equal(c.rows[c.gone[0]][0], 3);
assert.equal(c.newFrom, 4);
assert.equal(c.rows[c.newFrom][0], 5);

// No unique column: whole rows are compared (a change shows as gone + new); duplicates match one to one.
const dupA = rs(["kind"], [["a"], ["a"], ["b"]]);
const dupB = rs(["kind"], [["a"], ["b"], ["b"]]);
assert.deepEqual(guessKey(dupA, dupB), []);
assert.deepEqual(compareResults(dupA, dupB).counts, { equal: 2, changed: 0, gone: 1, added: 1 });

// Different columns: only the shared ones are compared, the rest are listed.
const wideA = rs(["id", "x", "old"], [[1, "a", "z"]]);
const wideB = rs(["id", "x", "new"], [[1, "a", "q"]]);
const w = compareResults(wideA, wideB);
assert.deepEqual(w.counts, { equal: 1, changed: 0, gone: 0, added: 0 });
assert.deepEqual(w.onlyOld, ["old"]);
assert.deepEqual(w.onlyNew, ["new"]);
// Numbers and their text form are the same value (pages arrive as numbers or strings depending on the driver).
assert.deepEqual(compareResults(rs(["id", "v"], [[1, 2]]), rs(["id", "v"], [[1, "2"]])).counts.equal, 1);

// ---- the same data read from two engines (PostgreSQL vs SQL Server, MySQL vs SQLite…)
assert.equal(canonicalNumber("12.50"), "12.5");
assert.equal(canonicalNumber(12.5), "12.5");
assert.equal(canonicalNumber("+007"), "7");
assert.equal(canonicalNumber("12,50"), "12.5");
assert.equal(canonicalNumber("0,00"), "0");
assert.equal(canonicalNumber("-0.000"), "0");
assert.equal(canonicalNumber(".5"), "0.5");
assert.equal(canonicalNumber("1.5E3"), "1500");
assert.equal(canonicalNumber("12345678901234567890.10"), "12345678901234567890.1", "big decimals stay exact (no float)");
assert.equal(canonicalNumber("abc"), null);
assert.equal(canonicalNumber(""), null);
assert.equal(canonicalBool("t"), "true");
assert.equal(canonicalBool(1 as never), "true");
assert.equal(canonicalBool("0"), "false");
assert.equal(canonicalBool("maybe"), null);
assert.equal(canonicalDate("2024-03-15T00:00:00"), "2024-03-15");
assert.equal(canonicalDate("2024-03-15 00:00:00.000"), "2024-03-15");
assert.equal(canonicalDate("2024-03-15T10:20:30.1200000"), "2024-03-15 10:20:30.12");
assert.equal(canonicalDate("2024-03-15 10:20:30+02"), "2024-03-15 10:20:30+02", "a time zone is kept");
const typed = (columns: [string, string][], rows: unknown[][]) => ({ columns: columns.map(([name, kind]) => ({ name, typeName: "", kind: kind as never })), rows: rows as never, hasMore: false, rowsAffected: null });
const pgSide = typed([["id", "number"], ["saldo", "number"], ["activo", "bool"], ["alta", "date"], ["nombre", "text"]], [
  ["1", "12.50", true, "2024-03-15", "Ana"],
  ["2", "0.00", false, "2023-01-02", "Luis"],
  ["3", null, null, null, "Mia"],
]);
const mssqlSide = typed([["ID", "number"], ["saldo", "number"], ["activo", "bool"], ["alta", "date"], ["nombre", "text"]], [
  [1, 12.5, 1, "2024-03-15T00:00:00", "Ana"],
  [2, 0, 0, "2023-01-02 00:00:00.000", "Luis "],
  [3, null, null, null, "Mia"],
]);
const cross = compareResults(pgSide, mssqlSide);
assert.deepEqual(cross.key, ["ID"], "the key matches id / ID");
assert.deepEqual(cross.counts, { equal: 2, changed: 1, gone: 0, added: 0 }, "only the trailing space is a change");
assert.equal(cross.changed["1:4"], "Luis");

// ---- only the differences, and the table that is exported
const diff = onlyDifferences(c);
assert.equal(diff.rows.length, 4, "the equal row goes");
assert.deepEqual(diff.counts, c.counts, "counts stay those of the whole comparison");
assert.deepEqual(diff.rows.map((r) => r[0]), [2, 4, 3, 5]);
assert.equal(diff.changed["0:2"], "20", "changed cells follow their rows");
assert.equal(diff.changed["1:2"], null);
assert.deepEqual(diff.gone, [2]);
assert.equal(diff.newFrom, 3);
const none = onlyDifferences(compareResults(before, before));
assert.equal(none.rows.length, 0);
assert.equal(none.newFrom, 0);
const table = comparisonTable(c, { before: "A", after: "B" });
assert.deepEqual(table.columns.map((col) => col.name), ["estado", "id", "name", "total", "total (antes)"]);
assert.deepEqual(table.rows[0], ["igual", 1, "Ana", 10, null]);
assert.deepEqual(table.rows[luis], ["cambiada", 2, "Luis", 25, "20"]);
assert.deepEqual(table.rows[c.gone[0]], ["solo en A", 3, "Mia", 30, null]);
assert.deepEqual(table.rows[c.newFrom], ["solo en B", 5, "Nora", 50, null]);
assert.equal(comparisonTable(diff, { before: "A", after: "B" }).rows.length, 4, "the filtered view exports as shown");

// ---- primary key of a plain single-table SELECT
assert.deepEqual(singleTableOf("SELECT * FROM clientes"), { schema: "", name: "clientes" });
assert.deepEqual(singleTableOf("select id, nombre from public.clientes c where id > 3 order by id;"), { schema: "public", name: "clientes" });
assert.deepEqual(singleTableOf('SELECT * FROM "Ventas"."Pedidos" AS p LIMIT 10'), { schema: "Ventas", name: "Pedidos" });
assert.deepEqual(singleTableOf("SELECT TOP 100 * FROM [dbo].[Order Details]"), { schema: "dbo", name: "Order Details" });
assert.deepEqual(singleTableOf("SELECT * FROM celerdemo.dbo.clientes"), { schema: "dbo", name: "clientes" });
assert.deepEqual(singleTableOf("-- lista\nSELECT * FROM `tienda`.`clientes` WHERE activo = 1"), { schema: "tienda", name: "clientes" });
assert.equal(singleTableOf("SELECT * FROM a JOIN b ON a.id = b.a_id"), null);
assert.equal(singleTableOf("SELECT * FROM a, b"), null);
assert.equal(singleTableOf("SELECT kind, count(*) FROM a GROUP BY kind"), null);
assert.equal(singleTableOf("SELECT * FROM a UNION SELECT * FROM b"), null);
assert.equal(singleTableOf("SELECT (SELECT max(x) FROM b) FROM a"), null);
assert.equal(singleTableOf("SELECT * FROM a WHERE id IN (SELECT a_id FROM b)"), null);
assert.equal(singleTableOf("UPDATE a SET x = 1"), null);
console.log("compare-check: all good");
