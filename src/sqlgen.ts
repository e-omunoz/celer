// SQL that Celer writes for a table: filters, the changes of the table viewer, generated scripts. Pure (plain
// data in, text out), so dev/engine-sql.ts can produce the exact statements for each engine and the Rust
// integration tests run them against real servers.
import { fitInformixDatetime, sqlLiteral } from "./sql.ts";
import type { Cell, DbKind, TableColumn } from "./types";
import type { ColumnFilter } from "./state";

/** What the filter and change builders need from a table tab. */
export interface TableShape {
  columnsMeta: TableColumn[];
  /** Column names quoted for the engine, in columnsMeta order. */
  quoted: string[];
  qualified: string;
}

/** A value as the column takes it: Informix DATETIME columns want exactly their qualifier's fields. */
export function fitValue(value: string, col: TableColumn, engine: DbKind): string {
  return engine === "informix" && /^datetime\b/i.test(col.typeName) ? fitInformixDatetime(value, col.typeName) : value;
}

export function filterSql(tab: TableShape, filter: ColumnFilter, engine: DbKind): string | null {
  const index = tab.columnsMeta.findIndex((col) => col.name === filter.col);
  if (index < 0) return null;
  const ident = tab.quoted[index] ?? filter.col;
  const kind = tab.columnsMeta[index].kind;
  const lit = (value: string) => sqlLiteral(fitValue(value, tab.columnsMeta[index], engine), kind, engine);
  const text = (value: string) => sqlLiteral(value, "text", engine);
  const like = engine === "postgres" ? "ILIKE" : "LIKE";
  const esc = (value: string) => value.replace(/[!%_]/g, (m) => `!${m}`).replace(/\[/g, engine === "mssql" ? "![" : "[");
  const asText = engine === "postgres" ? `${ident}::text` : engine === "mssql" ? `CAST(${ident} AS NVARCHAR(MAX))` : ident;
  switch (filter.op) {
    case "eq": return `${ident} = ${lit(filter.value)}`;
    case "ne": return `${ident} <> ${lit(filter.value)}`;
    case "gt": return `${ident} > ${lit(filter.value)}`;
    case "gte": return `${ident} >= ${lit(filter.value)}`;
    case "lt": return `${ident} < ${lit(filter.value)}`;
    case "lte": return `${ident} <= ${lit(filter.value)}`;
    // The value is literal text: % and _ (and [ on SQL Server) are escaped so they don't act as wildcards.
    case "contains": return `${asText} ${like} ${text(`%${esc(filter.value)}%`)} ESCAPE '!'`;
    case "not-contains": return `${asText} NOT ${like} ${text(`%${esc(filter.value)}%`)} ESCAPE '!'`;
    case "starts": return `${asText} ${like} ${text(`${esc(filter.value)}%`)} ESCAPE '!'`;
    case "ends": return `${asText} ${like} ${text(`%${esc(filter.value)}`)} ESCAPE '!'`;
    case "null": return `${ident} IS NULL`;
    case "not-null": return `${ident} IS NOT NULL`;
    case "empty": return `(${ident} IS NULL OR ${ident} = '')`;
    case "between": return `${ident} BETWEEN ${lit(filter.value)} AND ${lit(filter.value2)}`;
    case "in":
    case "not-in": {
      if (!filter.values.length) return null;
      const hasNull = filter.values.includes("\u0000NULL");
      const list = filter.values.filter((value) => value !== "\u0000NULL").map(lit);
      const parts: string[] = [];
      if (list.length) parts.push(`${ident} ${filter.op === "in" ? "IN" : "NOT IN"} (${list.join(", ")})`);
      if (hasNull) parts.push(`${ident} ${filter.op === "in" ? "IS NULL" : "IS NOT NULL"}`);
      return parts.length > 1 ? `(${parts.join(filter.op === "in" ? " OR " : " AND ")})` : parts[0];
    }
  }
}

/** The WHERE of a table tab: its own text and its enabled filters. */
export function whereOf(tab: TableShape & { where: string; filters: ColumnFilter[] }, engine: DbKind): string {
  const parts = tab.filters.filter((filter) => filter.enabled).map((filter) => filterSql(tab, filter, engine)).filter((part): part is string => Boolean(part));
  if (tab.where.trim()) parts.unshift(parts.length ? `(${tab.where.trim()})` : tab.where.trim());
  return parts.join(" AND ");
}

export function literalOf(value: Cell, col: TableColumn, dialect: DbKind) {
  if (value === null || value === undefined) return "NULL";
  return sqlLiteral(fitValue(String(value), col, dialect), col.kind, dialect);
}

const editLiteral = (value: string | null, col: TableColumn, engine: DbKind) => (value === null ? "NULL" : sqlLiteral(fitValue(value, col, engine), col.kind, engine));

/** The pending changes of a table tab: DELETE, UPDATE and INSERT statements keyed on the primary key. */
export function changesSql(
  tab: TableShape & { rows: Cell[][]; edits: Record<string, string | null>; deleted: number[]; inserts: (string | null)[][] },
  engine: DbKind,
): string {
  const pk = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => item.col.primaryKey);
  const lines: string[] = [];
  const whereFor = (row: number) => pk.map((item) => `${tab.quoted[item.index]} = ${literalOf(tab.rows[row][item.index], item.col, engine)}`).join(" AND ");
  for (const rowIndex of tab.deleted) lines.push(`DELETE FROM ${tab.qualified} WHERE ${whereFor(rowIndex)};`);
  const byRow = new Map<number, number[]>();
  for (const key of Object.keys(tab.edits)) {
    const [rowText, colText] = key.split(":");
    const row = Number(rowText);
    if (tab.deleted.includes(row)) continue;
    byRow.set(row, [...(byRow.get(row) ?? []), Number(colText)]);
  }
  for (const [row, cols] of byRow) {
    const sets = cols.map((col) => `${tab.quoted[col]} = ${editLiteral(tab.edits[`${row}:${col}`], tab.columnsMeta[col], engine)}`).join(", ");
    lines.push(`UPDATE ${tab.qualified} SET ${sets} WHERE ${whereFor(row)};`);
  }
  for (const insert of tab.inserts) {
    const usable = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => !(item.col.identity && (insert[item.index] === null || insert[item.index] === "")) && !(insert[item.index] === null && item.col.default));
    const names = usable.map((item) => tab.quoted[item.index]).join(", ");
    const values = usable.map((item) => editLiteral(insert[item.index], item.col, engine)).join(", ");
    lines.push(usable.length ? `INSERT INTO ${tab.qualified} (${names}) VALUES (${values});` : `INSERT INTO ${tab.qualified} DEFAULT VALUES;`);
  }
  return lines.join("\n");
}

/** A :name parameter for a column (letters, digits and _; numbered when two columns clash). */
export function paramNamesFor(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((name, i) => {
    let base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
    if (!/^[a-z_]/.test(base)) base = `p${i + 1}${base ? `_${base}` : ""}`;
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}${n}`;
    used.add(candidate);
    return `:${candidate}`;
  });
}

/**
 * Insert-or-update in each engine's own syntax, keyed on the primary key. `cols` are the columns written (keys
 * included); `insertable` the ones MERGE may insert (identity columns are generated by the database).
 */
export function upsertSql(dialect: DbKind, q: string, quoted: string[], params: string[], cols: number[], keys: number[], identityKey: boolean, insertable: number[]) {
  const names = cols.map((i) => quoted[i]);
  const values = cols.map((i) => params[i]);
  const updatable = cols.filter((i) => !keys.includes(i));
  const keyNames = keys.map((i) => quoted[i]).join(", ");
  if (dialect === "postgres" || dialect === "sqlite") {
    const action = updatable.length ? `DO UPDATE SET ${updatable.map((i) => `${quoted[i]} = EXCLUDED.${quoted[i]}`).join(",\n    ")}` : "DO NOTHING";
    // A GENERATED ALWAYS identity key only accepts a value with OVERRIDING SYSTEM VALUE (harmless otherwise).
    const overriding = dialect === "postgres" && identityKey ? "\nOVERRIDING SYSTEM VALUE" : "";
    return `INSERT INTO ${q} (${names.join(", ")})${overriding}\nVALUES (${values.join(", ")})\nON CONFLICT (${keyNames}) ${action};`;
  }
  if (dialect === "mysql") {
    const set = (updatable.length ? updatable : keys).map((i) => `${quoted[i]} = VALUES(${quoted[i]})`).join(",\n    ");
    return `INSERT INTO ${q} (${names.join(", ")})\nVALUES (${values.join(", ")})\nON DUPLICATE KEY UPDATE ${set};`;
  }
  // SQL Server, Informix and others: standard MERGE from a one-row source.
  const source = dialect === "mssql" ? `(VALUES (${values.join(", ")})) AS s (${names.join(", ")})` : `(SELECT ${cols.map((i) => `${params[i]} AS ${quoted[i]}`).join(", ")} FROM ${dialect === "informix" ? "sysmaster:sysdual" : "(VALUES (1)) AS one"}) s`;
  const on = keys.map((i) => `t.${quoted[i]} = s.${quoted[i]}`).join(" AND ");
  const update = updatable.length ? `\nWHEN MATCHED THEN\n  UPDATE SET ${updatable.map((i) => `${quoted[i]} = s.${quoted[i]}`).join(", ")}` : "";
  const inserted = cols.filter((i) => insertable.includes(i));
  return `MERGE INTO ${q} ${dialect === "mssql" ? "AS t" : "t"}\nUSING ${source}\nON ${on}${update}\nWHEN NOT MATCHED THEN\n  INSERT (${inserted.map((i) => quoted[i]).join(", ")}) VALUES (${inserted.map((i) => `s.${quoted[i]}`).join(", ")});`;
}

export function limitClause(kind: DbKind, n: number) {
  if (kind === "mssql") return `ORDER BY 1 OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  if (kind === "informix") return "";
  return `LIMIT ${n}`;
}

export function explainPrefix(kind: DbKind | undefined) {
  if (kind === "postgres") return "EXPLAIN (ANALYZE false, VERBOSE, COSTS)";
  if (kind === "mysql") return "EXPLAIN";
  if (kind === "sqlite") return "EXPLAIN QUERY PLAN";
  return "";
}
