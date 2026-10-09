// Checks for src/txWatch.ts (open manual transactions): node --experimental-strip-types dev/txwatch-check.ts
import assert from "node:assert/strict";
import { countStatements, NO_TX, reminderDue, txAfterRun, txDuration, txLabel, txLevel, txThresholds, worstLevel } from "../src/txWatch.ts";
import { defaultSettings } from "../src/types.ts";

// Defaults: 1 min / 5 min, stricter on production.
const normal = txThresholds(defaultSettings, false);
const prod = txThresholds(defaultSettings, true);
assert.deepEqual(normal, { warnSecs: 60, alertSecs: 300 });
assert.ok(prod.warnSecs < normal.warnSecs && prod.alertSecs < normal.alertSecs, JSON.stringify(prod));
// Production is never laxer than the general thresholds, and red never comes before amber.
assert.deepEqual(txThresholds({ txWarnSecs: 20, txAlertSecs: 40, txProdWarnSecs: 600, txProdAlertSecs: 900 }, true), { warnSecs: 20, alertSecs: 40 });
assert.deepEqual(txThresholds({ txWarnSecs: 120, txAlertSecs: 60, txProdWarnSecs: 30, txProdAlertSecs: 120 }, false), { warnSecs: 120, alertSecs: 120 });
assert.deepEqual(txThresholds({ txWarnSecs: 0, txAlertSecs: Number.NaN, txProdWarnSecs: -1, txProdAlertSecs: 0 }, false), { warnSecs: 60, alertSecs: 300 }, "nonsense falls back to the defaults");

assert.equal(txLevel(59_000, normal), "ok");
assert.equal(txLevel(60_000, normal), "warn");
assert.equal(txLevel(299_999, normal), "warn");
assert.equal(txLevel(300_000, normal), "alert");
assert.equal(txLevel(60_000, prod), "warn");
assert.equal(worstLevel(["ok", "warn"]), "warn");
assert.equal(worstLevel(["warn", "alert", "ok"]), "alert");
assert.equal(worstLevel([]), "ok");

assert.equal(txDuration(30_000), "<1 min");
assert.equal(txDuration(3 * 60_000 + 59_000), "3 min");
assert.equal(txDuration(65 * 60_000), "1 h 05 min");
assert.equal(txLabel(2 * 60_000, 1), "Transacción abierta · 2 min · 1 sentencia");
assert.equal(txLabel(0, 3), "Transacción abierta · <1 min · 3 sentencias");

// Statements: comments alone do not count; a run counts at least one.
assert.equal(countStatements("UPDATE t SET a = 1; DELETE FROM u WHERE id = 2; -- fin", "postgres"), 2);
assert.equal(countStatements("INSERT INTO t VALUES (';')", "mysql"), 1);
assert.equal(countStatements("", "sqlite"), 1);

// The clock starts with the run that opens it, statements add up, commit/rollback forgets it.
let tx = txAfterRun({ inTransaction: false, ...NO_TX }, false, 1, 1000);
assert.deepEqual(tx, { inTransaction: false, ...NO_TX });
tx = txAfterRun(tx, true, 2, 5000);
assert.deepEqual(tx, { inTransaction: true, txStartedAt: 5000, txStatements: 2, txReminders: 0 });
tx = txAfterRun({ ...tx, txReminders: 1 }, true, 1, 9000);
assert.deepEqual(tx, { inTransaction: true, txStartedAt: 5000, txStatements: 3, txReminders: 1 });
tx = txAfterRun(tx, false, 1, 12000);
assert.equal(tx.txStartedAt, null);
// A transaction known open without a start (a console moved from an older window): it starts now.
assert.equal(txAfterRun({ inTransaction: true, ...NO_TX }, true, 1, 7).txStartedAt, 7);

// Reminders: at the red threshold, then each time as much again.
assert.equal(reminderDue(299_000, normal, 0), false);
assert.equal(reminderDue(300_000, normal, 0), true);
assert.equal(reminderDue(400_000, normal, 1), false);
assert.equal(reminderDue(600_000, normal, 1), true);

console.log("txwatch-check: ok");
