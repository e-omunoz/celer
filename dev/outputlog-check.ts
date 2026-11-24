// Quick checks for src/outputLog.ts (the «Salida» log, newest first): node --experimental-strip-types dev/outputlog-check.ts
import assert from "node:assert/strict";
import { appendOutput, OUTPUT_CAP, outputRows, outputText, type OutputEntry } from "../src/outputLog.ts";

const entry = (n: number, ok = true): OutputEntry => ({ at: n * 1000, sql: `SELECT ${n}`, ok, text: ok ? `${n} filas` : `error ${n}`, elapsedMs: ok ? n : null });

// Three runs: the top line is the last one run, marked as the latest; the log itself stays oldest first.
let log: OutputEntry[] = [];
for (const n of [1, 2, 3]) log = appendOutput(log, entry(n));
assert.deepEqual(log.map((e) => e.sql), ["SELECT 1", "SELECT 2", "SELECT 3"]);
const rows = outputRows(log);
assert.deepEqual(rows.map((r) => r.entry.sql), ["SELECT 3", "SELECT 2", "SELECT 1"]);
assert.deepEqual(rows.map((r) => r.latest), [true, false, false]);
assert.equal(outputRows([]).length, 0);

// «✦ Corregir con IA» follows the latest entry: on it when it is an error, not on an older error after a success.
log = appendOutput(log, entry(4, false));
assert.deepEqual(outputRows(log).map((r) => r.fixable), [true, false, false, false]);
log = appendOutput(log, entry(5));
assert.deepEqual(outputRows(log).map((r) => r.fixable), [false, false, false, false, false]);
assert.equal(outputRows(log)[1].entry.ok, false);

// The cap drops the oldest.
let big: OutputEntry[] = [];
for (let n = 1; n <= OUTPUT_CAP + 5; n++) big = appendOutput(big, entry(n));
assert.equal(big.length, OUTPUT_CAP);
assert.equal(big[0].sql, "SELECT 6");
assert.equal(outputRows(big)[0].entry.sql, `SELECT ${OUTPUT_CAP + 5}`);

// Restored entries (a saved session) keep their order: same array in, same newest-first view out.
const restored = JSON.parse(JSON.stringify(log)) as OutputEntry[];
assert.deepEqual(outputRows(restored).map((r) => r.entry.sql), outputRows(log).map((r) => r.entry.sql));

// «Copiar todo» copies in the order shown, newest first, errors marked.
const text = outputText(log.slice(-2), (at) => `t${at / 1000}`);
assert.equal(text, "[t5] SELECT 5\n5 filas\n\n[t4] ERROR SELECT 4\nerror 4");
console.log("outputLog: all checks passed");
