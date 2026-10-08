// Checks for src/dataCompareSql.ts: node --experimental-strip-types dev/datacompare-check.ts
import assert from "node:assert/strict";
import { compareResults, keyIsUnique } from "../src/compare.ts";
import { dataSyncScript } from "../src/dataCompareSql.ts";
import type { ColumnInfo } from "../src/types.ts";

const cols: ColumnInfo[] = [
  { name: "id", typeName: "int", kind: "number" },
  { name: "name", typeName: "text", kind: "text" },
  { name: "active", typeName: "bool", kind: "bool" },
];
const source = { columns: cols, rows: [[1, "Ana", true], [2, "Luis", false], [4, "O'Neil", null]], hasMore: false, rowsAffected: null };
const target = { columns: cols, rows: [[1, "Ana", true], [2, "Luís", true], [3, "Old", true]], hasMore: false, rowsAffected: null };

// The comparison runs target → source: source values, target's old ones in `changed`.
const cmp = compareResults(target, source, ["id"]);
assert.deepEqual(cmp.counts, { equal: 1, changed: 1, gone: 1, added: 1 });

const pg = dataSyncScript(cmp, { dialect: "postgres", table: '"public"."people"', targetColumns: cols });
assert.match(pg, /^INSERT INTO "public"\."people" \("id", "name", "active"\) VALUES \(4, 'O''Neil', NULL\);$/m);
assert.match(pg, /^UPDATE "public"\."people" SET "name" = 'Luis', "active" = FALSE WHERE "id" = 2;$/m);
assert.match(pg, /^-- DELETE FROM "public"\."people" WHERE "id" = 3;$/m);
assert.ok(!/^DELETE/m.test(pg), "deletes stay commented");

// SQL Server: bit as 1/0, identity inserts allowed around the INSERTs.
const ms = dataSyncScript(cmp, { dialect: "mssql", table: "[dbo].[people]", targetColumns: [{ name: "id", identity: true }, { name: "name" }, { name: "active" }] });
assert.match(ms, /SET IDENTITY_INSERT \[dbo\]\.\[people\] ON;\nINSERT INTO \[dbo\]\.\[people\] \(\[id\], \[name\], \[active\]\) VALUES \(4, N'O''Neil', NULL\);\nSET IDENTITY_INSERT \[dbo\]\.\[people\] OFF;/);
assert.match(ms, /SET \[name\] = N'Luis', \[active\] = 0 WHERE \[id\] = 2;/);
// PostgreSQL identity columns: OVERRIDING SYSTEM VALUE.
assert.match(dataSyncScript(cmp, { dialect: "postgres", table: "t", targetColumns: [{ name: "id", identity: true }, { name: "name" }, { name: "active" }] }), /\) OVERRIDING SYSTEM VALUE VALUES \(4,/);

// A column the target lacks is not written; binary columns are left out with a note.
const wide: ColumnInfo[] = [...cols, { name: "photo", typeName: "bytea", kind: "binary" }, { name: "extra", typeName: "text", kind: "text" }];
const cmpWide = compareResults({ columns: wide, rows: [], hasMore: false, rowsAffected: null }, { columns: wide, rows: [[9, "Nuevo", true, "\\x00", "x"]], hasMore: false, rowsAffected: null }, ["id"]);
const partial = dataSyncScript(cmpWide, { dialect: "postgres", table: "t", targetColumns: [...cols, { name: "photo" }] });
assert.match(partial, /-- Columnas binarias no incluidas: photo\./);
assert.match(partial, /INSERT INTO t \("id", "name", "active"\) VALUES \(9, 'Nuevo', TRUE\);/);

// Without a key: no UPDATE, a note, and the DELETE condition uses every column.
const nokey = compareResults(target, source, []);
const plain = dataSyncScript(nokey, { dialect: "sqlite", table: '"people"', targetColumns: cols });
assert.match(plain, /^-- Sin clave para emparejar filas/);
assert.ok(!/UPDATE/.test(plain));
assert.match(plain, /-- DELETE FROM "people" WHERE "id" = 2 AND "name" = 'Luís' AND "active" = TRUE;/);

// Same data.
assert.match(dataSyncScript(compareResults(source, source, ["id"]), { dialect: "mysql", table: "`t`", targetColumns: cols }), /mismos datos/);
// Literals follow the target's column kinds (a source boolean going into an integer column).
const intTarget = dataSyncScript(cmp, { dialect: "postgres", table: "t", targetColumns: [{ name: "id", kind: "number" }, { name: "name", kind: "text" }, { name: "active", kind: "number" }] });
assert.match(intTarget, /SET "name" = 'Luis', "active" = 0 WHERE "id" = 2;/, intTarget);
// Identity columns are never in SET; PostgreSQL's sequence is moved after explicit identity values.
const surrogate: ColumnInfo[] = [{ name: "code", typeName: "text", kind: "text" }, { name: "id", typeName: "int", kind: "number" }];
const sur = compareResults({ columns: surrogate, rows: [["A", 10]], hasMore: false, rowsAffected: null }, { columns: surrogate, rows: [["A", 7], ["B", 8]], hasMore: false, rowsAffected: null }, ["code"]);
const surPg = dataSyncScript(sur, { dialect: "postgres", table: '"public"."t"', targetColumns: [{ name: "code" }, { name: "id", identity: true }] });
assert.ok(!/UPDATE/.test(surPg), surPg);
assert.match(surPg, /SELECT setval\(pg_get_serial_sequence\('"public"\."t"', 'id'\), \(SELECT max\("id"\) FROM "public"\."t"\)\);/);
// A binary key: no script that would silently match nothing.
const binKey: ColumnInfo[] = [{ name: "uuid", typeName: "binary(16)", kind: "binary" }, { name: "n", typeName: "text", kind: "text" }];
assert.match(dataSyncScript(compareResults({ columns: binKey, rows: [["0x01", "a"]], hasMore: false, rowsAffected: null }, { columns: binKey, rows: [["0x01", "b"]], hasMore: false, rowsAffected: null }, ["uuid"]), { dialect: "mysql", table: "t", targetColumns: binKey }), /clave de las filas es binaria/);
// Columns matched across case (PostgreSQL id vs SQL Server Id), written with the target's spelling.
const upper: ColumnInfo[] = [{ name: "Id", typeName: "int", kind: "number" }, { name: "Name", typeName: "nvarchar", kind: "text" }];
const mixed = compareResults({ columns: upper, rows: [[1, "Ana"]], hasMore: false, rowsAffected: null }, { columns: cols.slice(0, 2), rows: [[1, "Ana María"], [2, "Luis"]], hasMore: false, rowsAffected: null }, ["id"]);
assert.deepEqual(mixed.counts, { equal: 0, changed: 1, gone: 0, added: 1 });
const mixedSql = dataSyncScript(mixed, { dialect: "mssql", table: "[dbo].[t]", targetColumns: upper });
assert.match(mixedSql, /INSERT INTO \[dbo\]\.\[t\] \(\[Id\], \[Name\]\) VALUES \(2, N'Luis'\);/);
assert.match(mixedSql, /UPDATE \[dbo\]\.\[t\] SET \[Name\] = N'Ana María' WHERE \[Id\] = 1;/);
// Key uniqueness.
assert.equal(keyIsUnique(target, ["id"]), true);
assert.equal(keyIsUnique({ ...target, rows: [...target.rows, [1, "x", true]] }, ["id"]), false);
assert.equal(keyIsUnique(target, []), false);
console.log("datacompare-check: all good");
