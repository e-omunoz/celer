// The SQL Celer's interface writes for an engine, for the Rust integration tests against real servers
// (src-tauri/src/engine_tests.rs). The test describes its tables as the driver reports them (stdin, JSON) and
// gets back the statements to run, each with what it must return.
//   node --experimental-strip-types dev/engine-sql.ts < shape.json > statements.json
import { readFileSync } from "node:fs";
import { activitySpec } from "../src/activity.ts";
import { compareResults } from "../src/compare.ts";
import { dataSyncScript } from "../src/dataCompareSql.ts";
import { lookupSql } from "../src/fkLookupSql.ts";
import { compareSchemas, syncScript, type SchemaTable } from "../src/schemaCompare.ts";
import { changesSql, filterSql, limitClause, upsertSql } from "../src/sqlgen.ts";
import type { Cell, DbKind, ResultSet, TableColumn } from "../src/types.ts";

interface Table {
  qualified: string;
  columns: TableColumn[];
  quoted: string[];
  rows: Cell[][];
}

interface Shape {
  kind: DbKind;
  /** Seed table (see engine_tests.rs): id, nombre, activo, alta, importe, notas, parent_id. */
  t: Table;
  /** Schema comparison: source tables, target tables, the source's DDL, the target schema. */
  schemas?: { source: SchemaTable[]; target: SchemaTable[]; sourceDdl: Record<string, string>; schema: string; sourceSchema: string };
  /** Data comparison: the source's rows, the target's rows and the target table. */
  data?: { source: ResultSet; target: ResultSet; key: string[]; table: string; targetColumns: TableColumn[] };
}

interface Statement {
  name: string;
  sql: string;
  /** Rows the statement must return (a SELECT), or rows it must affect; absent: it must just succeed. */
  rows?: number;
}

const shape = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "")) as Shape;
const { kind, t } = shape;
const out: Statement[] = [];
// The table as the builders take it (a table tab's fields).
const tab = { columnsMeta: t.columns, quoted: t.quoted, qualified: t.qualified };
const col = (name: string) => t.columns.findIndex((c) => c.name.toLowerCase() === name);
const q = (name: string) => t.quoted[col(name)];
const select = (where: string) => `SELECT * FROM ${t.qualified} WHERE ${where}`;
const filter = (name: string, op: string, value = "", value2 = "", values: string[] = []) => {
  const sql = filterSql(tab, { id: "f", col: t.columns[col(name)].name, op: op as never, value, value2, values, enabled: true }, kind);
  if (!sql) throw new Error(`no filter for ${name} ${op}`);
  return select(sql);
};

// ---------------------------------------------------------------- table filters (the seed: 4 rows)
out.push({ name: "filter eq number", sql: filter("id", "eq", "2"), rows: 1 });
out.push({ name: "filter ne", sql: filter("id", "ne", "2"), rows: 3 });
out.push({ name: "filter gt date", sql: filter("alta", "gt", "2024-01-01"), rows: 2 });
out.push({ name: "filter lte date", sql: filter("alta", "lte", "2023-12-31"), rows: 1 });
out.push({ name: "filter contains", sql: filter("nombre", "contains", "ui"), rows: 2 });
out.push({ name: "filter not contains", sql: filter("nombre", "not-contains", "ui"), rows: 2 });
out.push({ name: "filter starts", sql: filter("nombre", "starts", "Ana"), rows: 1 });
out.push({ name: "filter ends (accent)", sql: filter("nombre", "ends", "Peña"), rows: 1 });
out.push({ name: "filter contains % literally", sql: filter("notas", "contains", "50%"), rows: 1 });
out.push({ name: "filter contains [ literally", sql: filter("notas", "contains", "[corch"), rows: 1 });
out.push({ name: "filter contains _ literally", sql: filter("notas", "contains", "a_b"), rows: 0 });
out.push({ name: "filter quote in value", sql: filter("nombre", "eq", "O'Neil"), rows: 1 });
out.push({ name: "filter null", sql: filter("parent_id", "null"), rows: 1 });
out.push({ name: "filter not null", sql: filter("parent_id", "not-null"), rows: 3 });
out.push({ name: "filter empty text", sql: filter("notas", "empty"), rows: 2 });
out.push({ name: "filter between decimal", sql: filter("importe", "between", "0", "200"), rows: 2 });
out.push({ name: "filter bool true", sql: filter("activo", "eq", "true"), rows: 2 });
out.push({ name: "filter bool false", sql: filter("activo", "eq", "false"), rows: 1 });
out.push({ name: "filter in", sql: filter("id", "in", "", "", ["1", "3"]), rows: 2 });
out.push({ name: "filter in with NULL", sql: filter("parent_id", "in", "", "", ["1", "\u0000NULL"]), rows: 3 });
out.push({ name: "filter not in with NULL", sql: filter("parent_id", "not-in", "", "", ["1", "\u0000NULL"]), rows: 1 });
out.push({ name: "filter negative decimal", sql: filter("importe", "lt", "-1.5"), rows: 1 });

// ---------------------------------------------------------------- generated scripts
const limit = limitClause(kind, 100);
out.push({ name: "generated select", sql: `SELECT ${t.quoted.join(", ")}\nFROM ${t.qualified}\n${limit}`, rows: 4 });
out.push({ name: "generated count", sql: `SELECT COUNT(*) FROM ${t.qualified}`, rows: 1 });

// ---------------------------------------------------------------- table viewer changes (one transaction in the app)
const byId = (id: number) => t.rows.findIndex((r) => Number(r[col("id")]) === id);
const edits: Record<string, string | null> = {};
const row2 = byId(2);
edits[`${row2}:${col("nombre")}`] = "Luisa Peña";
edits[`${row2}:${col("importe")}`] = "10.10";
edits[`${row2}:${col("activo")}`] = "true";
edits[`${row2}:${col("alta")}`] = "2024-03-01";
edits[`${row2}:${col("notas")}`] = null;
const insert: (string | null)[] = t.columns.map(() => null);
insert[col("id")] = "5";
insert[col("nombre")] = "Nuevo «5»";
insert[col("activo")] = "false";
insert[col("alta")] = "2025-05-05";
insert[col("importe")] = "1234.56";
insert[col("notas")] = "con 'comillas'";
insert[col("parent_id")] = "2";
const changes = changesSql({ ...tab, rows: t.rows, edits, deleted: [byId(4)], inserts: [insert] }, kind);
out.push({ name: "table changes", sql: changes });
out.push({ name: "changes applied: edited row", sql: select(`${q("id")} = 2 AND ${q("nombre")} = ${kind === "mssql" ? "N" : ""}'Luisa Peña' AND ${q("notas")} IS NULL`), rows: 1 });
out.push({ name: "changes applied: deleted row", sql: select(`${q("id")} = 4`), rows: 0 });
out.push({ name: "changes applied: inserted row", sql: select(`${q("id")} = 5 AND ${q("notas")} = 'con ''comillas'''`), rows: 1 });

// ---------------------------------------------------------------- UPSERT / MERGE (literals in place of :params)
const lit = (v: string, name: string) => {
  const c = t.columns[col(name)];
  if (c.kind === "number") return v;
  if (c.kind === "bool") return kind === "mssql" || kind === "informix" ? (v === "true" ? "1" : "0") : v.toUpperCase();
  return `${kind === "mssql" ? "N" : ""}'${v.replace(/'/g, "''")}'`;
};
const upCols = ["id", "nombre", "importe"].map(col);
const params = t.columns.map((c) => (["id", "nombre", "importe"].includes(c.name.toLowerCase()) ? lit({ id: "6", nombre: "Upsert 6", importe: "6.60" }[c.name.toLowerCase()]!, c.name.toLowerCase()) : "NULL"));
out.push({ name: "upsert insert", sql: upsertSql(kind, t.qualified, t.quoted, params, upCols, [col("id")], false, upCols) });
const params2 = params.map((p, i) => (i === col("nombre") ? lit("Upsert 6 bis", "nombre") : p));
out.push({ name: "upsert update", sql: upsertSql(kind, t.qualified, t.quoted, params2, upCols, [col("id")], false, upCols) });
out.push({ name: "upsert result", sql: select(`${q("id")} = 6 AND ${q("nombre")} = ${lit("Upsert 6 bis", "nombre")}`), rows: 1 });

// ---------------------------------------------------------------- foreign-key lookup (on the seed's own key)
out.push({ name: "fk lookup first rows", sql: lookupSql(kind, t.qualified, q("id"), q("nombre"), ""), rows: 5 });
out.push({ name: "fk lookup search", sql: lookupSql(kind, t.qualified, q("id"), q("nombre"), "upsert"), rows: 1 });
out.push({ name: "fk lookup by key", sql: lookupSql(kind, t.qualified, q("id"), q("nombre"), "5"), rows: 1 });

// ---------------------------------------------------------------- server activity
const activity = activitySpec(kind);
if (activity) {
  out.push({ name: "activity list", sql: activity.list });
  out.push({ name: "activity self", sql: activity.self, rows: 1 });
}

// ---------------------------------------------------------------- schema comparison script
if (shape.schemas) {
  const s = shape.schemas;
  const script = syncScript(compareSchemas(s.source, s.target), { dialect: kind, schema: s.schema, sourceSchema: s.sourceSchema, sourceDialect: kind, sourceDdl: s.sourceDdl });
  out.push({ name: "schema sync script", sql: script });
}

// ---------------------------------------------------------------- data comparison script
if (shape.data) {
  const d = shape.data;
  const script = dataSyncScript(compareResults(d.target, d.source, d.key), { dialect: kind, table: d.table, targetColumns: d.targetColumns });
  out.push({ name: "data sync script", sql: script });
}

process.stdout.write(JSON.stringify(out, null, 1));
