// The SQL Celer's interface writes for an engine, for the Rust integration tests against real servers
// (src-tauri/src/engine_tests.rs). The test describes its tables as the driver reports them (stdin, JSON) and
// gets back the statements to run, each with what it must return.
//   node --experimental-strip-types dev/engine-sql.ts < shape.json > statements.json
import { readFileSync, writeSync } from "node:fs";
import { activitySpec } from "../src/activity.ts";
import { compareResults } from "../src/compare.ts";
import { dataSyncScript } from "../src/dataCompareSql.ts";
import { lookupSql } from "../src/fkLookupSql.ts";
import { compareSchemas, syncScript, type SchemaTable } from "../src/schemaCompare.ts";
import { changesSql, filterSql, selectLimit, upsertSql } from "../src/sqlgen.ts";
import { importLiteral, importStatements, type SheetCell } from "../src/importFormats.ts";
import { blankSettings, buildModel, createGenerator, EXISTING_SAMPLE, existingToRead, inferSettings, insertStatements, statsColumns, type ParentKeys } from "../src/testData.ts";
import { catalogQueries, effectiveDialect, existingValuesSql, parentKeysSql, readCatalog, statsSql } from "../src/testDataSql.ts";
import type { Cell, DbKind, ObjectRef, ResultSet, TableColumn } from "../src/types.ts";

interface Table {
  qualified: string;
  columns: TableColumn[];
  quoted: string[];
  rows: Cell[][];
}

/** A foreign key as the driver's schema_foreign_keys reads it (#98), its names quoted for the dialect. */
interface ForeignKeyShape {
  name: string;
  qualified: string;
  columns: string[];
  targetQualified: string;
  targetColumns: string[];
  /** Rows of its table with every key column set: each must find its referenced row. */
  rows: number;
}

interface Shape {
  kind: DbKind;
  /** Seed table (see engine_tests.rs): id, nombre, activo, alta, importe, notas, parent_id. Absent: only `fks`. */
  t?: Table;
  /** The schema's foreign keys read in one catalog query: the E-R diagram draws one edge per key and column pair. */
  fks?: ForeignKeyShape[];
  /** A table of date and time columns (first row: the values to find and write back). */
  dt?: Table;
  /** Schema comparison: source tables, target tables, the source's DDL, the target schema. */
  schemas?: { source: SchemaTable[]; target: SchemaTable[]; sourceDdl: Record<string, string>; schema: string; sourceSchema: string };
  /** Data comparison: the source's rows, the target's rows and the target table. */
  data?: { source: ResultSet; target: ResultSet; key: string[]; table: string; targetColumns: TableColumn[] };
  /** Test data generator (#172): the catalog queries for a table, then (with their answers) its INSERTs and checks. */
  testData?: TestDataShape;
}

interface TestDataShape {
  stage: "catalog" | "existing" | "insert";
  serverInfo: string;
  table: { database: string; schema: string; name: string; qualified: string };
  columns: TableColumn[];
  quoted: string[];
  /** The table's foreign keys as the driver reads them, with the referenced table quoted for the dialect. */
  fks: { name: string; columns: string[]; target: ObjectRef; targetColumns: string[]; targetQualified: string; targetQuoted: string[] }[];
  /** Stage "insert": the answers to the catalog stage's statements, in order (null: the server refused it). */
  answers?: (Cell[][] | null)[];
  /** Stage "insert": the answers to the "existing" stage's statements. */
  existing?: Cell[][][];
  rows?: number;
  seed?: number;
  /** Every column left to the server (#194): the rows of defaults as the dialog writes them, and their count. */
  allSkip?: boolean;
}

interface Statement {
  name: string;
  sql: string;
  /** Rows the statement must return (a SELECT), or rows it must affect; absent: it must just succeed. */
  rows?: number;
}

/**
 * Writes the statements and ends the process. Written whole before exiting: process.exit right after an
 * asynchronous write to a pipe would cut a long answer (10,000 generated rows) at 64 KB.
 */
function finish(statements: Statement[]): never {
  const buf = Buffer.from(JSON.stringify(statements, null, 1));
  for (let off = 0; off < buf.length; ) {
    try {
      off += writeSync(1, buf, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
    }
  }
  process.exit(0);
}

const shape = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "")) as Shape;
const { kind } = shape;
const out: Statement[] = [];

// ---------------------------------------------------------------- the schema's foreign keys (E-R diagram, #98)
// Each key joins its table to the referenced one column pair by column pair, in the order the catalog query gave:
// a column out of order or of another table fails the join or finds fewer rows.
for (const fk of shape.fks ?? []) {
  if (!fk.columns.length || fk.columns.length !== fk.targetColumns.length) throw new Error(`foreign key ${fk.name}: ${JSON.stringify(fk)}`);
  const on = fk.columns.map((c, i) => `c.${c} = p.${fk.targetColumns[i]}`).join(" AND ");
  out.push({ name: `fk ${fk.name} joins its tables`, sql: `SELECT c.* FROM ${fk.qualified} c JOIN ${fk.targetQualified} p ON ${on}`, rows: fk.rows });
}
// ---------------------------------------------------------------- test data generator (#172)
// Stage "catalog": what the dialog reads (unique keys, CHECKs, enums, counts and maxima, parent keys). Stage "insert":
// the generator's rows for those answers as the import writes them, then checks that the table holds them all and that
// every value keeps the constraints (the server enforces them too: an INSERT that broke one would have failed).
if (shape.testData) {
  const td = shape.testData;
  const dialect = effectiveDialect(kind, td.serverInfo);
  const catalog = catalogQueries(dialect, td.table, td.serverInfo);
  const numeric = statsColumns(td.columns, dialect);
  const asked: Statement[] = [
    ...catalog.map((c) => ({ name: `catalog ${c.part}`, sql: c.sql })),
    { name: "stats", sql: statsSql(td.table.qualified, numeric.map((i) => td.quoted[i])) },
    ...td.fks.map((fk) => ({ name: `parent keys ${fk.name}`, sql: parentKeysSql(dialect, fk.targetQualified, fk.targetQuoted, 50_000) })),
  ];
  if (td.stage === "catalog") finish(asked);
  const answers = td.answers ?? [];
  const facts = readCatalog(catalog.map((c, i) => ({ part: c.part, rows: answers[i] ?? null })), dialect);
  const fks: ParentKeys[] = td.fks.map((fk, k) => ({ name: fk.name, columns: fk.columns, target: fk.target, targetColumns: fk.targetColumns, rows: answers[catalog.length + 1 + k] ?? [] }));
  const input = { dialect, qualified: td.table.qualified, table: td.table.name, columns: td.columns, quoted: td.quoted, catalog: facts, stats: answers[catalog.length]?.[0] ?? null, fks };
  // Stage "existing": the values already in unique columns (a small table), as the dialog reads them next.
  const toRead = existingToRead(buildModel(input));
  if (td.stage === "existing") finish(toRead.map((c) => ({ name: `existing ${c.name}`, sql: existingValuesSql(dialect, td.table.qualified, c.quoted, EXISTING_SAMPLE) })));
  const existing = td.existing ?? [];
  const model = buildModel({ ...input, existingValues: Object.fromEntries(toRead.map((c, i) => [c.name, (existing[i] ?? []).map((row) => row[0])])) });
  const settings = td.allSkip ? model.columns.map(() => blankSettings("skip")) : inferSettings(model, "es");
  const gen = createGenerator(model, settings, td.seed ?? 172, "es");
  const count = td.rows ?? 10_000;
  const rows = Array.from({ length: count }, () => gen.next());
  const plan = model.columns.map((c, i) => `${c.col.name}=${settings[i].kind}${c.unique ? " (única)" : ""}${c.values ? ` [${c.values.join("|")}]` : ""}${c.rule ? ` [${c.rule.min}..${c.rule.max}]` : ""}`);
  out.push({ name: `plan: ${plan.join(", ")}`, sql: "" });
  for (const sql of insertStatements(model, gen, rows)) out.push({ name: "testdata insert", sql });
  const byName = (name: string) => model.columns.find((c) => c.col.name.toLowerCase() === name);
  const quotedOf = (name: string) => model.columns.find((m) => m.col.name === name)!.quoted;
  const key = model.columns.find((c) => c.col.primaryKey) ?? model.columns[0];
  out.push({ name: "testdata: every row is there", sql: `SELECT ${key.quoted} FROM ${model.qualified}`, rows: model.existing + count });
  if (td.allSkip) finish(out);
  for (const fk of td.fks) {
    const on = fk.columns.map((c, i) => `p.${fk.targetQuoted[i]} = t.${quotedOf(c)}`).join(" AND ");
    const set = fk.columns.map((c) => `t.${quotedOf(c)} IS NOT NULL`).join(" AND ");
    out.push({ name: `testdata: ${fk.name} only takes existing keys`, sql: `SELECT t.${key.quoted} FROM ${model.qualified} t LEFT JOIN ${fk.targetQualified} p ON ${on} WHERE ${set} AND p.${fk.targetQuoted[0]} IS NULL`, rows: 0 });
  }
  for (const c of model.columns.filter((m) => m.unique)) {
    out.push({ name: `testdata: ${c.col.name} has no repeated value`, sql: `SELECT ${c.quoted} FROM ${model.qualified} WHERE ${c.quoted} IS NOT NULL GROUP BY ${c.quoted} HAVING COUNT(*) > 1`, rows: 0 });
  }
  for (const c of model.columns.filter((m) => m.values)) {
    out.push({ name: `testdata: ${c.col.name} within its values`, sql: `SELECT ${key.quoted} FROM ${model.qualified} WHERE ${c.quoted} NOT IN (${c.values!.map((v) => importLiteral(v, c.col, dialect, false)).join(", ")})`, rows: 0 });
  }
  for (const c of model.columns.filter((m) => m.rule)) {
    const r = c.rule!;
    const bounds = [r.min !== undefined ? `${c.quoted} ${r.minOpen ? "<=" : "<"} ${r.min}` : "", r.max !== undefined ? `${c.quoted} ${r.maxOpen ? ">=" : ">"} ${r.max}` : ""].filter(Boolean);
    out.push({ name: `testdata: ${c.col.name} within its range`, sql: `SELECT ${key.quoted} FROM ${model.qualified} WHERE ${bounds.join(" OR ")}`, rows: 0 });
  }
  // A generated row read back by its values: text, date, date-time, decimal, boolean and bytes arrive as generated.
  const at = (name: string) => model.columns.findIndex((c) => c.col.name.toLowerCase() === name);
  const sample = rows.find((r) => (at("foto") < 0 || r[at("foto")] !== null) && (at("momento") < 0 || r[at("momento")] !== null)) ?? rows[0];
  const conds = ["codigo", "alta", "importe", "activo", "foto", "momento"]
    .map(byName)
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && !c!.type.noLiteral && sample[model.columns.indexOf(c!)] !== null)
    .map((c) => `${c.quoted} = ${importLiteral(sample[model.columns.indexOf(c)], c.col, dialect, false)}`);
  out.push({ name: `testdata: a generated row reads back as generated (${conds.length} columns)`, sql: `SELECT ${key.quoted} FROM ${model.qualified} WHERE ${conds.join(" AND ")}`, rows: 1 });
  finish(out);
}

if (!shape.t) {
  process.stdout.write(JSON.stringify(out, null, 1));
  process.exit(0);
}
const t: Table = shape.t;
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

// DATETIME as the grid shows it (Informix over DRDA: "…10:30:00" for a YEAR TO MINUTE column).
const momento = col("momento");
const shownMomento = momento >= 0 ? String(t.rows.find((r) => Number(r[col("id")]) === 1)![momento]) : "";
if (momento >= 0) out.push({ name: `filter datetime = shown value (${shownMomento})`, sql: filter("momento", "eq", shownMomento), rows: 1 });

// ---------------------------------------------------------------- generated scripts
const limit = selectLimit(kind, 100);
out.push({ name: "generated select", sql: `SELECT ${limit.top}${t.quoted.join(", ")}\nFROM ${t.qualified}\n${limit.tail}`, rows: 4 });
if (kind === "mssql") {
  // Azure Synapse dedicated / PDW: TOP instead of OFFSET … FETCH (SQL Server runs it as well).
  const top = selectLimit(kind, 100, "Microsoft Azure SQL Data Warehouse — DataWarehouse (10.0) · Azure Synapse dedicated / PDW");
  if (!top.top || top.tail) throw new Error(`Synapse limit: ${JSON.stringify(top)}`);
  out.push({ name: "generated select (Synapse: TOP)", sql: `SELECT ${top.top}${t.quoted.join(", ")}\nFROM ${t.qualified}\n${top.tail}`, rows: 4 });
}
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
if (momento >= 0) edits[`${row2}:${momento}`] = shownMomento;
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
if (momento >= 0) out.push({ name: "changes applied: datetime written as shown", sql: filter("momento", "eq", shownMomento), rows: 2 });
out.push({ name: "changes applied: inserted row", sql: select(`${q("id")} = 5 AND ${q("notas")} = 'con ''comillas'''`), rows: 1 });

// ---------------------------------------------------------------- dates and times as the grid shows them
// Each date/time column of the "dt" table: found by its shown value, and written back as shown (the app fits it).
if (shape.dt) {
  const dt = shape.dt;
  const dtTab = { columnsMeta: dt.columns, quoted: dt.quoted, qualified: dt.qualified };
  const dated = dt.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.primaryKey && /date|time/i.test(c.typeName));
  const first = dt.rows[0];
  const sameAs = (i: number) => dt.rows.filter((r) => String(r[i]) === String(first[i])).length;
  for (const { c, i } of dated) {
    const shown = String(first[i]);
    const where = filterSql(dtTab, { id: "f", col: c.name, op: "eq", value: shown, value2: "", values: [], enabled: true }, kind)!;
    out.push({ name: `${c.typeName} = shown "${shown}"`, sql: `SELECT * FROM ${dt.qualified} WHERE ${where}`, rows: sameAs(i) });
  }
  const dtEdits: Record<string, string | null> = {};
  for (const { i } of dated) dtEdits[`0:${i}`] = String(first[i]);
  out.push({ name: "table changes", sql: changesSql({ ...dtTab, rows: dt.rows, edits: dtEdits, deleted: [], inserts: [] }, kind) });
  for (const { c, i } of dated) {
    const where = filterSql(dtTab, { id: "f", col: c.name, op: "eq", value: String(first[i]), value2: "", values: [], enabled: true }, kind)!;
    out.push({ name: `${c.typeName} written back as shown`, sql: `SELECT * FROM ${dt.qualified} WHERE ${where}`, rows: sameAs(i) });
  }
}

// ---------------------------------------------------------------- UPSERT / MERGE (literals in place of :params)
const lit = (v: string, name: string) => {
  const c = t.columns[col(name)];
  if (c.kind === "number") return v;
  if (c.kind === "bool") return kind === "mssql" ? (v === "true" ? "1" : "0") : kind === "informix" ? (v === "true" ? "'t'" : "'f'") : v.toUpperCase();
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

// ---------------------------------------------------------------- import of typed cells (a sheet, a pasted block)
// What the import wizard writes for an Excel sheet (#120): a date-time into the DATE column keeps the date, a serial
// number into it is a date, a decimal, booleans as true / 0, empty text as NULL. Checked, then taken out again.
{
  const sheetRow = (id: number, nombre: string, activo: SheetCell, alta: SheetCell, importe: SheetCell, notas: SheetCell): SheetCell[] => [id, nombre, activo, alta, importe, notas];
  const names = ["id", "nombre", "activo", "alta", "importe", "notas"];
  const mapping = t.columns.map((c) => names.indexOf(c.name.toLowerCase()));
  const rows = [sheetRow(907, "Importado «907»", true, { d: "2024-03-15 10:20:00" }, 12.5, ""), sheetRow(908, "O'Neil 908", 0, 45366, -3, "nota")];
  for (const sql of importStatements(rows, { qualified: t.qualified, columns: t.columns, quoted: t.quoted, mapping, emptyAsNull: true }, kind)) out.push({ name: "import typed rows", sql });
  const cond = (name: string, op: string, value = "") => filterSql(tab, { id: "f", col: t.columns[col(name)].name, op: op as never, value, value2: "", values: [], enabled: true }, kind)!;
  out.push({ name: "import: date-time into DATE, decimal, true, empty as NULL", sql: select([cond("id", "eq", "907"), cond("alta", "eq", "2024-03-15"), cond("importe", "eq", "12.5"), cond("activo", "eq", "true"), cond("notas", "null")].join(" AND ")), rows: 1 });
  out.push({ name: "import: serial date, negative, 0 as false, text", sql: select([cond("id", "eq", "908"), cond("alta", "eq", "2024-03-15"), cond("importe", "eq", "-3"), cond("activo", "eq", "false"), cond("nombre", "eq", "O'Neil 908")].join(" AND ")), rows: 1 });
  out.push({ name: "import: rows taken out", sql: `DELETE FROM ${t.qualified} WHERE ${q("id")} IN (907, 908)` });
  out.push({ name: "import: none left", sql: select(`${q("id")} IN (907, 908)`), rows: 0 });
}

process.stdout.write(JSON.stringify(out, null, 1));
