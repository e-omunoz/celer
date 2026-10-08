// Checks for src/plan.ts on real plans (dev/fixtures/plans, captured from the test databases):
//   node --experimental-strip-types dev/plan-check.ts
// SQL Server's parser needs a DOMParser; it is checked in the browser by dev/plan-mssql-check.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flatten, parseMysqlPlan, parsePostgresPlan, parseSqlitePlan, planText } from "../src/plan.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/plans/${name}.json`, import.meta.url), "utf8"))[0].results[0].rows;

// PostgreSQL, estimated.
const pg = parsePostgresPlan(fixture("pg-join")[0][0]);
assert.equal(pg.engine, "PostgreSQL");
assert.equal(pg.analyzed, false);
assert.equal(pg.root.op, "Sort");
const pgNodes = flatten(pg.root);
assert.ok(pgNodes.some((n) => /Join/.test(n.op)), "a join node");
assert.ok(pgNodes.some((n) => n.target.includes("events")), "events is read");
assert.ok(pgNodes.every((n) => n.cost !== null && n.rows !== null), "costs and rows everywhere");
assert.ok(pg.root.details.some(([k]) => k === "Sort Key"));

// PostgreSQL, analyzed: actual rows, times, totals.
const pga = parsePostgresPlan(fixture("pg-analyze")[0][0]);
assert.equal(pga.analyzed, true);
assert.ok((pga.executionMs ?? 0) > 0 && pga.planningMs !== null);
assert.ok(flatten(pga.root).every((n) => n.timeMs !== null && n.actualRows !== null));
const seq = flatten(pga.root).find((n) => /Seq Scan/.test(n.op));
assert.ok(seq?.warnings.some((w) => /Lee las 200\.000 filas/.test(w)), "a big filtered seq scan is flagged with the real figures");
assert.ok(!flatten(pga.root).some((n) => n.warnings.some((w) => /esperaba/.test(w))), "fewer rows than estimated under a LIMIT is not a warning");

// MariaDB.
const my = parseMysqlPlan(fixture("mysql-join")[0][0]);
assert.equal(my.root.op, "Consulta");
const myNodes = flatten(my.root);
const tables = myNodes.filter((n) => n.target && /índice/.test(n.target));
assert.equal(tables.length, 2, JSON.stringify(myNodes.map((n) => n.op)));
assert.ok(myNodes.some((n) => n.op === "Ordenación"));
assert.ok(myNodes.some((n) => n.op === "Bucle anidado"));
assert.ok(myNodes.some((n) => n.op === "Búsqueda única por índice" && n.target.startsWith("c")));
const mya = parseMysqlPlan(fixture("mysql-analyze")[0][0]);
assert.equal(mya.analyzed, true);
assert.ok(flatten(mya.root).some((n) => n.actualRows !== null && n.timeMs !== null));

// SQLite.
const sq = parseSqlitePlan(fixture("sqlite-join"));
const sqNodes = flatten(sq.root);
assert.equal(sq.root.children.length, 4);
assert.ok(sqNodes.some((n) => n.op === "Búsqueda por índice" && n.target.includes("idx_pedidos_estado")));
assert.ok(sqNodes.some((n) => n.op === "Búsqueda por clave primaria"));
assert.ok(sqNodes.some((n) => n.op === "Ordenación temporal" && n.warnings.length));
assert.deepEqual(parseSqlitePlan([[2, 0, 0, "SCAN t"]]).root.children[0].warnings.length, 1, "a full scan is flagged");

const rightPart = parseSqlitePlan([[3, 0, 0, "USE TEMP B-TREE FOR RIGHT PART OF ORDER BY"]]).root.children[0];
assert.equal(rightPart.op, "Ordenación temporal", "RIGHT PART OF ORDER BY is a temporary sort too");
assert.equal(parseSqlitePlan([[3, 0, 0, "USE TEMP B-TREE FOR LAST TERM OF ORDER BY"]]).root.children[0].op, "Ordenación temporal");

// No plan: an error, not an empty tree.
assert.throws(() => parseMysqlPlan("{}"), /no devolvió un plan/);

// MySQL: subqueries attached to a table hang from it.
const attached = parseMysqlPlan(JSON.stringify({ query_block: { select_id: 1, table: { table_name: "a", access_type: "ALL", rows: 5, attached_subqueries: [{ query_block: { select_id: 2, table: { table_name: "b", access_type: "ref", key: "ix", rows: 1 } } }] } } }));
const tableA = flatten(attached.root).find((n) => n.target === "a")!;
assert.ok(flatten(tableA).some((n) => n.target.startsWith("b")), "attached subquery under its table");

// PostgreSQL parallel: the workers' loops overlap, the wall time is not per-loop × loops.
const parallel = parsePostgresPlan(JSON.stringify([{ Plan: { "Node Type": "Gather", "Workers Launched": 2, "Actual Total Time": 100, "Actual Loops": 1, "Actual Rows": 30, "Plan Rows": 30, Plans: [{ "Node Type": "Seq Scan", "Parallel Aware": true, "Relation Name": "t", "Actual Total Time": 90, "Actual Loops": 3, "Actual Rows": 10, "Plan Rows": 10 }] } }]));
assert.equal(parallel.root.children[0].timeMs, 90, "3 loops in 3 processes take one loop's time");
assert.equal(parallel.root.children[0].actualRows, 30);

// Text form.
const asText = planText(pga);
assert.ok(asText.startsWith(pga.root.op) && asText.includes("Ejecución:"));

console.log("plan-check: all good");
