// Checks for src/sqlgen.ts and the Informix DATETIME fitting in src/sql.ts:
//   node --experimental-strip-types dev/sqlgen-check.ts
import assert from "node:assert/strict";
import { fitInformixDatetime, quoteIdentFor, sqlLiteral } from "../src/sql.ts";
import { binaryKeysWritable, binaryLiteral, changesSql, filterSql, fitValue } from "../src/sqlgen.ts";
import type { TableColumn } from "../src/types.ts";

// Informix DATETIME takes exactly its qualifier's fields.
assert.equal(fitInformixDatetime("2024-03-15 10:20:00", "datetime year to minute"), "2024-03-15 10:20");
assert.equal(fitInformixDatetime("2024-03-15 10:20:30.123450", "datetime year to fraction(5)"), "2024-03-15 10:20:30.12345");
assert.equal(fitInformixDatetime("2024-03-15 10:20:30", "datetime year to fraction(3)"), "2024-03-15 10:20:30.000");
assert.equal(fitInformixDatetime("2024-03-15 10:20:30.5", "DATETIME YEAR TO FRACTION"), "2024-03-15 10:20:30.500", "FRACTION alone is FRACTION(3)");
assert.equal(fitInformixDatetime("2024-03-15 10:20:30.000000", "datetime year to second"), "2024-03-15 10:20:30");
assert.equal(fitInformixDatetime("2024-03-15", "datetime year to day"), "2024-03-15");
assert.equal(fitInformixDatetime("2024-03-15 10:20:30", "datetime year to day"), "2024-03-15");
assert.equal(fitInformixDatetime("08:30:00", "datetime hour to minute"), "08:30");
assert.equal(fitInformixDatetime("2024-03-15 08:30:00", "datetime hour to second"), "08:30:00");
assert.equal(fitInformixDatetime("2024-03-15 08:30", "datetime month to minute"), "03-15 08:30");
assert.equal(fitInformixDatetime("2024-3-5 8:05", "datetime year to minute"), "2024-03-05 08:05");
// Missing fields or other text: left alone (Informix will say what is wrong).
assert.equal(fitInformixDatetime("2024-03-15", "datetime year to minute"), "2024-03-15");
assert.equal(fitInformixDatetime("ayer", "datetime year to minute"), "ayer");
assert.equal(fitInformixDatetime("CURRENT", "datetime year to second"), "CURRENT");
assert.equal(fitInformixDatetime("2024-03-15 10:20:00", "date"), "2024-03-15 10:20:00");

// Only Informix DATETIME columns are fitted.
const col = (name: string, typeName: string, kind: TableColumn["kind"], primaryKey = false): TableColumn => ({ name, typeName, kind, primaryKey, nullable: !primaryKey, identity: false, default: null });
const momento = col("momento", "datetime year to minute", "date");
assert.equal(fitValue("2024-03-15 10:20:00", momento, "informix"), "2024-03-15 10:20");
assert.equal(fitValue("2024-03-15 10:20:00", momento, "postgres"), "2024-03-15 10:20:00");

// Filters and table changes write fitted literals (the grid shows "…10:20:00" over DRDA).
const tab = { columnsMeta: [col("id", "integer", "number", true), momento], quoted: ["id", "momento"], qualified: "t" };
assert.equal(filterSql(tab, { id: "f", col: "momento", op: "eq", value: "2024-03-15 10:20:00", value2: "", values: [], enabled: true }, "informix"), "momento = '2024-03-15 10:20'");
const sql = changesSql({ ...tab, rows: [[1, "2024-01-01 00:00:00"]], edits: { "0:1": "2024-03-15 10:20:00" }, deleted: [], inserts: [["2", "2025-01-01 08:00:00"]] }, "informix");
assert.match(sql, /UPDATE t SET momento = '2024-03-15 10:20' WHERE id = 1;/);
assert.match(sql, /INSERT INTO t \(id, momento\) VALUES \(2, '2025-01-01 08:00'\);/);
// A DATETIME key is fitted in the WHERE of the edited row too.
const keyed = { columnsMeta: [col("momento", "datetime year to minute", "date", true), col("n", "integer", "number")], quoted: ["momento", "n"], qualified: "t" };
assert.match(changesSql({ ...keyed, rows: [["2024-03-15 10:20:00", 1]], edits: { "0:1": "2" }, deleted: [], inserts: [] }, "informix"), /WHERE momento = '2024-03-15 10:20';/);

// A binary key compares as bytes, in each engine's literal (as text "0x…" it matched no row).
const uuidKeyed = { columnsMeta: [col("id", "binary(16)", "binary", true), col("n", "integer", "number")], quoted: ["id", "n"], qualified: "t" };
const binEdit = (engine: "mysql" | "sqlite" | "postgres" | "mssql") =>
  changesSql({ ...uuidKeyed, rows: [["0x00ff10ab", 1], ["0x01", 2]], edits: { "0:1": "5" }, deleted: [1], inserts: [] }, engine);
assert.equal(binEdit("mysql"), "DELETE FROM t WHERE id = X'01';\nUPDATE t SET n = 5 WHERE id = X'00FF10AB';");
assert.match(binEdit("sqlite"), /WHERE id = X'00FF10AB';/);
assert.match(binEdit("postgres"), /WHERE id = decode\('00FF10AB', 'hex'\);/);
assert.match(binEdit("mssql"), /WHERE id = 0x00FF10AB;/);
assert.equal(binaryLiteral("0x0102…", "mysql"), null, "a cut preview is not the value");
assert.equal(binaryKeysWritable("informix"), false);
assert.equal(binaryKeysWritable("postgres"), true);

// Informix BOOLEAN takes 't' / 'f' (not 1 / 0); SQL Server bit takes 1 / 0.
assert.equal(sqlLiteral("true", "bool", "informix"), "'t'");
assert.equal(sqlLiteral("0", "bool", "informix"), "'f'");
assert.equal(sqlLiteral("true", "bool", "mssql"), "1");

// Informix names go unquoted (without DELIMIDENT "x" is a string).
assert.equal(quoteIdentFor("nombre", "informix"), "nombre");
assert.equal(quoteIdentFor("nombre", "mssql"), "[nombre]");

console.log("sqlgen-check: all good");
