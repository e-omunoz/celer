// Checks for src/dataCompareSql.ts: node --experimental-strip-types dev/datacompare-check.ts
import assert from "node:assert/strict";
import { compareResults } from "../src/compare.ts";
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
assert.match(ms, /SET IDENTITY_INSERT \[dbo\]\.\[people\] ON;\nINSERT INTO \[dbo\]\.\[people\] \(\[id\], \[name\], \[active\]\) VALUES \(4, 'O''Neil', NULL\);\nSET IDENTITY_INSERT \[dbo\]\.\[people\] OFF;/);
assert.match(ms, /SET \[name\] = 'Luis', \[active\] = 0 WHERE \[id\] = 2;/);
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
console.log("datacompare-check: all good");
