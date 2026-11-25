// Checks for src/rowHistoryView.ts («Historial de la fila»): node --experimental-strip-types dev/rowhistory-check.ts
import assert from "node:assert/strict";
import { columnChanges, keyText, newestFirst, noEventsText, rangeText, rowHistoryBlocked, txText, unavailableText, userText, valueText } from "../src/rowHistoryView.ts";
import type { RowHistoryEvent } from "../src/types.ts";

// Only Informix reads the logs (its protocol, DRDA or Client SDK, is a precondition the core states in the dialog);
// every other engine disables the entry and says which it is.
assert.equal(rowHistoryBlocked("informix"), null);
assert.equal(rowHistoryBlocked("postgres"), "No disponible en PostgreSQL");
assert.equal(rowHistoryBlocked("mysql"), "No disponible en MySQL / MariaDB");
assert.equal(rowHistoryBlocked("mssql"), "No disponible en SQL Server");
assert.equal(rowHistoryBlocked("sqlite"), "No disponible en SQLite");
assert.equal(rowHistoryBlocked("odbc"), "No disponible en ODBC");

const columns = ["id", "qty", "precio", "nombre"];
const event = (op: RowHistoryEvent["op"], before: (string | null)[] | null, after: (string | null)[] | null): RowHistoryEvent => ({
  lsn: "72:0xc3811c",
  time: 1791564033,
  tx: "72:0xc38200",
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
// A transaction is named by its commit's position, never by the records' reused slot number.
assert.equal(txText(update), "transacción del commit 72:0xc38200");
assert.equal(userText({ ...update, user: null }), "uid 200");
assert.equal(userText({ ...update, uid: null, user: null }), "usuario desconocido");
assert.equal(keyText([{ column: "id", value: "7" }, { column: "linea", value: "2" }]), "id = 7, linea = 2");
assert.deepEqual(newestFirst([update, event("insert", null, [])]).map((e) => e.op), ["insert", "update"]);

// The range says which logs and from where, and why the read starts there (the core's startReason, #217).
const oldest = { startReason: "oldestOnDisk", oldestLog: 64, createdAfterLog: null } as const;
// Case 3, the table is older than the oldest log on disk: only then is what came before gone.
const range = rangeText({ firstLog: 64, firstLogFilled: null, currentLog: 73, fromLsn: "64:0x0", readUntil: "73:0x1a20c8", readAt: 0, ...oldest });
assert.match(range, /logs 64 a 73 que quedan en disco \(posición 64:0x0 a 73:0x1a20c8\)\. Lo anterior ya no está en los logs\./);
assert.match(rangeText({ firstLog: 9, firstLogFilled: 1791561745, currentLog: 9, fromLsn: "9:0x0", readUntil: "9:0x10", readAt: 0, ...oldest, oldestLog: 9 }), /log 9 .*el 9, el más antiguo, se llenó el /);

assert.match(rangeText({ firstLog: 88, firstLogFilled: null, currentLog: 88, fromLsn: "88:0x0", readUntil: "88:0x10", readAt: 0, ...oldest, oldestLog: 88 }), /^Leído del log 88 \(posición/);
assert.match(range, /^Leído de los logs 64 a 73 /);
// Case 1, a table created after log 69 filled: the read starts at 70, and 64..69 are still on disk, never «gone».
const created = rangeText({ firstLog: 70, firstLogFilled: null, currentLog: 73, fromLsn: "70:0x0", readUntil: "73:0x1a20c8", readAt: 0, startReason: "createdAfter", oldestLog: 64, createdAfterLog: 69 });
assert.equal(created, "Leído de los logs 70 a 73 (posición 70:0x0 a 73:0x1a20c8). Empieza en el log 70 porque la tabla se creó después de llenarse el log 69: los logs 64 a 69 siguen en disco, sin cambios suyos.");
assert.doesNotMatch(created, /ya no está|el más antiguo|que quedan en disco/);
const createdOne = rangeText({ firstLog: 9, firstLogFilled: 1791561745, currentLog: 9, fromLsn: "9:0x0", readUntil: "9:0x10", readAt: 0, startReason: "createdAfter", oldestLog: 8, createdAfterLog: 8 });
assert.match(createdOne, /^Leído del log 9 \(posición 9:0x0 a 9:0x10\); el 9 se llenó el .+\. Empieza en el log 9 porque la tabla se creó después de llenarse el log 8: el log 8 sigue en disco, sin cambios suyos\.$/);
// Case 2, the creation time rewritten by Informix's fast recovery: said so, and the older logs are still not «gone».
const replayed = rangeText({ firstLog: 70, firstLogFilled: null, currentLog: 73, fromLsn: "70:0x0", readUntil: "73:0x10", readAt: 0, startReason: "creationReplayed", oldestLog: 64, createdAfterLog: null });
assert.match(replayed, /Empieza en el log 70 porque la recuperación rápida de Informix reescribió la hora de creación de la tabla: los logs 64 a 69 siguen en disco, pero se llenaron antes de esa hora\.$/);
assert.doesNotMatch(replayed, /ya no está/);
assert.match(rangeText({ firstLog: 70, firstLogFilled: null, currentLog: 70, fromLsn: "70:0x0", readUntil: "70:0x10", readAt: 0, startReason: "creationReplayed", oldestLog: 69, createdAfterLog: null }), /el log 69 sigue en disco, pero se llenó antes de esa hora\.$/);

// A read cut short says how far it got, or that it read nothing; it never claims the logs on disk were covered, and
// no change read is not «sin cambios». Its texts do not depend on why the read started there.
const cut = { firstLog: 209, firstLogFilled: null, currentLog: 218, fromLsn: "209:0x0", readUntil: "209:0x0", readAt: 0, ...oldest, oldestLog: 209 };
for (const startReason of ["createdAfter", "creationReplayed"] as const) {
  assert.equal(rangeText({ ...cut, startReason, oldestLog: 200, createdAfterLog: 208 }, true), rangeText(cut, true));
  assert.equal(rangeText({ ...cut, readUntil: "211:0x4000", startReason, oldestLog: 200 }, true), rangeText({ ...cut, readUntil: "211:0x4000" }, true));
}
assert.match(rangeText(cut, true), /^La lectura se detuvo antes de leer ningún registro \(desde la posición 209:0x0\)\. En disco quedan los logs 209 a 218\.$/);
assert.doesNotMatch(rangeText(cut, true), /Leído/);
assert.match(rangeText({ ...cut, readUntil: "211:0x4000" }, true), /^La lectura se detuvo: se leyó de la posición 209:0x0 a la 211:0x4000\./);
assert.match(noEventsText({ cutShort: true, shownFrom: null }), /no dice que no los tenga/);
assert.doesNotMatch(noEventsText({ cutShort: true, shownFrom: null }), /Sin cambios/);
assert.equal(noEventsText({ cutShort: false, shownFrom: null }), "Sin cambios de esta fila en los logs leídos.");
// After Informix's fast recovery rewrote the creation time (#123): what came before is not shown, so no change read
// since then is never «sin cambios».
const recovered = noEventsText({ cutShort: false, shownFrom: 1791928706 });
assert.match(recovered, /^No se leyó ningún cambio de esta fila posterior al .+; los anteriores no se muestran/);
assert.doesNotMatch(recovered, /Sin cambios|Ningún cambio/);

// «No se puede reconstruir: …» unless the reason already says it is not available.
assert.equal(unavailableText("la base de datos «x» no tiene log."), "No se puede reconstruir: la base de datos «x» no tiene log.");
assert.match(unavailableText("la conexión usa DRDA, y la API CDC …"), /^No se puede reconstruir: la conexión usa DRDA/);
assert.equal(unavailableText("No disponible en PostgreSQL: …"), "No disponible en PostgreSQL: …");

console.log("rowhistory-check: all good");
