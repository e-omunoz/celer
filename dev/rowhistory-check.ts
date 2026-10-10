// Checks for src/rowHistoryView.ts («Historial de la fila»): node --experimental-strip-types dev/rowhistory-check.ts
import assert from "node:assert/strict";
import { columnChanges, keyText, newestFirst, rangeText, rowHistoryBlocked, unavailableText, userText, valueText } from "../src/rowHistoryView.ts";
import type { RowHistoryEvent } from "../src/types.ts";

// Only Informix over JDBC (or "auto", which the core resolves) reads the logs; every other engine says which it is.
assert.equal(rowHistoryBlocked("informix", "jdbc"), null);
assert.equal(rowHistoryBlocked("informix", "auto"), null);
assert.equal(rowHistoryBlocked("informix", "drda"), "No disponible por DRDA: solo por JDBC");
assert.equal(rowHistoryBlocked("informix", ""), "No disponible por DRDA: solo por JDBC", "connections from before the protocol choice are DRDA");
assert.match(rowHistoryBlocked("informix", "sqli") ?? "", /Client SDK/);
assert.equal(rowHistoryBlocked("postgres", ""), "No disponible en PostgreSQL");
assert.equal(rowHistoryBlocked("mysql", ""), "No disponible en MySQL / MariaDB");
assert.equal(rowHistoryBlocked("mssql", ""), "No disponible en SQL Server");
assert.equal(rowHistoryBlocked("sqlite", ""), "No disponible en SQLite");
assert.equal(rowHistoryBlocked("odbc", ""), "No disponible en ODBC");

const columns = ["id", "qty", "precio", "nombre"];
const event = (op: RowHistoryEvent["op"], before: (string | null)[] | null, after: (string | null)[] | null): RowHistoryEvent => ({
  lsn: "72:0xc3811c",
  time: 1791564033,
  tx: 30,
  uid: 200,
  user: "informix",
  op,
  before,
  after,
});

// An update shows what changed, or every column; NULL is a change like any other.
const update = event("update", ["1", "10", "1.50", "alfa"], ["1", "11", "1.50", null]);
assert.deepEqual(columnChanges(columns, update, false), [
  { column: "qty", before: "10", after: "11", changed: true },
  { column: "nombre", before: "alfa", after: null, changed: true },
]);
assert.equal(columnChanges(columns, update, true).length, 4);
assert.deepEqual(columnChanges(columns, update, true)[0], { column: "id", before: "1", after: "1", changed: false });
// An insert or a delete: every value is new or gone.
assert.deepEqual(columnChanges(columns, event("insert", null, ["1", "10", "1.50", "alfa"]), false).map((c) => [c.column, c.before, c.after]), [
  ["id", null, "1"],
  ["qty", null, "10"],
  ["precio", null, "1.50"],
  ["nombre", null, "alfa"],
]);
assert.equal(columnChanges(columns, event("delete", ["2", "20", "2.50", "beta"], null), false).every((c) => c.after === null && c.changed), true);
// An update whose before image did not come: never compared against a guess, every column counts as changed.
assert.equal(columnChanges(columns, event("update", null, ["1", "11", "1.50", "alfa"]), false).length, 4);
assert.deepEqual(columnChanges(columns, event("truncate", null, null), false), []);

assert.equal(valueText(null), "NULL");
assert.equal(valueText(""), "''");
assert.equal(valueText("0"), "0");
assert.equal(userText(update), "informix (uid 200)");
assert.equal(userText({ ...update, user: null }), "uid 200");
assert.equal(userText({ ...update, uid: null, user: null }), "usuario desconocido");
assert.equal(keyText([{ column: "id", value: "7" }, { column: "linea", value: "2" }]), "id = 7, linea = 2");
assert.deepEqual(newestFirst([update, event("insert", null, [])]).map((e) => e.op), ["insert", "update"]);

// The range says which logs and from where; what is older is gone.
const range = rangeText({ firstLog: 64, firstLogFilled: null, currentLog: 73, fromLsn: "64:0x0", readUntil: "73:0x1a20c8", readAt: 0 });
assert.match(range, /logs 64 a 73 que quedan en disco \(posición 64:0x0 a 73:0x1a20c8\)\. Lo anterior ya no está en los logs\./);
assert.match(rangeText({ firstLog: 9, firstLogFilled: 1791561745, currentLog: 9, fromLsn: "9:0x0", readUntil: "9:0x10", readAt: 0 }), /log 9 .*el 9, el más antiguo, se llenó el /);

assert.match(rangeText({ firstLog: 88, firstLogFilled: null, currentLog: 88, fromLsn: "88:0x0", readUntil: "88:0x10", readAt: 0 }), /^Leído del log 88 \(posición/);
assert.match(range, /^Leído de los logs 64 a 73 /);

// «No se puede reconstruir: …» unless the reason already says it is not available.
assert.equal(unavailableText("la base de datos «x» no tiene log."), "No se puede reconstruir: la base de datos «x» no tiene log.");
assert.equal(unavailableText("No disponible en PostgreSQL: …"), "No disponible en PostgreSQL: …");

console.log("rowhistory-check: all good");
