// Comparing the structure of two schemas (same or different connections): tables only on one side, and the
// columns that differ (missing, another type, another nullability). Also the script that would make the target
// like the source. Pure: dev/schemacompare-check.ts tests it.
import { quoteIdentFor } from "./sql.ts";
import type { DbKind, TableColumn } from "./types";

export type CompareColumn = Pick<TableColumn, "name" | "typeName" | "nullable" | "primaryKey"> & Partial<Pick<TableColumn, "default" | "identity">>;

export interface SchemaTable {
  name: string;
  columns: CompareColumn[];
}

export interface ColumnDiff {
  name: string;
  change: "only-source" | "only-target" | "type" | "nullable";
  source?: CompareColumn;
  target?: CompareColumn;
}

export interface TableDiff {
  /** The source's name (the target's when the table is only there). */
  name: string;
  /** The target's name when it differs (only by case). */
  targetName?: string;
  status: "only-source" | "only-target" | "different" | "same";
  columns: ColumnDiff[];
}

const SYNONYMS: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  serial: "integer",
  bigserial: "bigint",
  smallserial: "smallint",
  bool: "boolean",
  float8: "double precision",
  float4: "real",
  decimal: "numeric",
  "character varying": "varchar",
  character: "char",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "time without time zone": "time",
  "time with time zone": "timetz",
};

/** A type name compared loosely: case, spaces and the usual synonyms (int4 = integer, varchar = character varying). */
export function normalizeType(typeName: string): string {
  const t = typeName.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  const match = /^([a-z0-9_ ]+?)(\([^)]*\))?((?: unsigned| zerofill)*)(\[\])?$/.exec(t);
  if (!match) return t;
  const base = SYNONYMS[match[1]] ?? match[1];
  let size = match[2] ?? "";
  // MySQL 5.7 writes int(11), 8.0 just int: an integer's display width is not part of its type (tinyint(1) is
  // MySQL's boolean and keeps it).
  if (/^(smallint|mediumint|integer|bigint)$/.test(base) || (base === "tinyint" && size !== "(1)")) size = "";
  return `${base}${size}${match[3] ?? ""}${match[4] ?? ""}`;
}

function byName<T extends { name: string }>(items: T[]): { exact: Map<string, T>; folded: Map<string, T> } {
  const exact = new Map<string, T>();
  const folded = new Map<string, T>();
  for (const item of items) {
    exact.set(item.name, item);
    if (!folded.has(item.name.toLowerCase())) folded.set(item.name.toLowerCase(), item);
  }
  return { exact, folded };
}

/** Same name, or the same name in another case (PostgreSQL folds to lower case, SQL Server keeps it). */
function finder<T extends { name: string }>(items: T[]) {
  const { exact, folded } = byName(items);
  return (name: string) => exact.get(name) ?? folded.get(name.toLowerCase());
}

export function compareColumns(source: CompareColumn[], target: CompareColumn[]): ColumnDiff[] {
  const out: ColumnDiff[] = [];
  const inTarget = finder(target);
  const matched = new Set<CompareColumn>();
  for (const s of source) {
    const t = inTarget(s.name);
    if (!t) {
      out.push({ name: s.name, change: "only-source", source: s });
      continue;
    }
    matched.add(t);
    if (normalizeType(s.typeName) !== normalizeType(t.typeName)) out.push({ name: s.name, change: "type", source: s, target: t });
    else if (s.nullable !== t.nullable) out.push({ name: s.name, change: "nullable", source: s, target: t });
  }
  for (const t of target) if (!matched.has(t)) out.push({ name: t.name, change: "only-target", target: t });
  return out;
}

/** Every table of either side, sorted: differences first, then the ones only on one side, then the equal ones. */
export function compareSchemas(source: SchemaTable[], target: SchemaTable[]): TableDiff[] {
  const out: TableDiff[] = [];
  const inTarget = finder(target);
  const matched = new Set<SchemaTable>();
  for (const s of source) {
    const t = inTarget(s.name);
    if (!t) {
      out.push({ name: s.name, status: "only-source", columns: [] });
      continue;
    }
    matched.add(t);
    const columns = compareColumns(s.columns, t.columns);
    out.push({ name: s.name, targetName: t.name !== s.name ? t.name : undefined, status: columns.length ? "different" : "same", columns });
  }
  for (const t of target) if (!matched.has(t)) out.push({ name: t.name, status: "only-target", columns: [] });
  const rank = { different: 0, "only-source": 1, "only-target": 2, same: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

export function compareCounts(diffs: TableDiff[]) {
  const count = (status: TableDiff["status"]) => diffs.filter((d) => d.status === status).length;
  return { different: count("different"), onlySource: count("only-source"), onlyTarget: count("only-target"), same: count("same") };
}

export interface SyncOptions {
  /** Engine of the target (the script runs there). */
  dialect: DbKind;
  /** The target's schema, to qualify table names ("" or SQLite: unqualified). */
  schema: string;
  /** The source's engine: when it differs, copied DDL is flagged for review. */
  sourceDialect: DbKind;
  /** The source's schema: its name in the copied DDL becomes the target's. */
  sourceSchema?: string;
  /** CREATE statements of the tables only in the source, by name (from the source). */
  sourceDdl: Record<string, string>;
}

/**
 * The script that brings the target to the source's structure: new tables (the source's DDL), new columns,
 * type and nullability changes. Whatever would delete data (tables and columns only in the target) is written
 * commented out, to uncomment on purpose.
 */
export function syncScript(diffs: TableDiff[], options: SyncOptions): string {
  const { dialect } = options;
  const q = (name: string) => quoteIdentFor(name, dialect);
  const table = (name: string) => (options.schema && dialect !== "sqlite" ? `${q(options.schema)}.${q(name)}` : q(name));
  const lines: string[] = [];
  const section = (title: string) => lines.push("", `-- ${title}`);
  const nullSql = (c: CompareColumn) => (c.nullable ? "NULL" : "NOT NULL");

  const created = diffs.filter((d) => d.status === "only-source");
  if (created.length) {
    section(`Tablas que faltan en el destino (${created.length})`);
    for (const d of created) {
      const ddl = options.sourceDdl[d.name]?.trim();
      if (!ddl) {
        lines.push(`-- ${d.name}: no se pudo leer su definición en el origen`);
        continue;
      }
      if (options.sourceDialect !== dialect) lines.push(`-- Definición de ${engineLabel(options.sourceDialect)}: revísala antes de ejecutarla en ${engineLabel(dialect)}`);
      const moved = retarget(ddl, options);
      lines.push(/;\s*$/.test(moved) ? moved : `${moved};`);
    }
  }

  const changed = diffs.filter((d) => d.status === "different");
  for (const d of changed) {
    section(`${d.name}`);
    const t = table(d.targetName ?? d.name);
    for (const c of d.columns) {
      const s = c.source;
      if (c.change === "only-source" && s) {
        const add = dialect === "mssql" ? "ADD" : dialect === "informix" ? "ADD (" : "ADD COLUMN";
        const close = dialect === "informix" ? ")" : "";
        const notNull = s.nullable ? "" : " NOT NULL";
        if (!s.nullable) lines.push(`-- ${s.name} es NOT NULL: con filas en la tabla hará falta un DEFAULT`);
        lines.push(`ALTER TABLE ${t} ${add} ${q(s.name)} ${s.typeName}${notNull}${close};`);
      } else if (c.change === "only-target" && c.target) {
        lines.push(`-- Solo en el destino (borraría sus datos): ALTER TABLE ${t} DROP COLUMN ${q(c.target.name)};`);
      } else if ((c.change === "type" || c.change === "nullable") && s && c.target) {
        const col = q(c.target.name);
        if (dialect === "postgres") {
          if (c.change === "type") lines.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${s.typeName};`);
          if (s.nullable !== c.target.nullable) lines.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${s.nullable ? "DROP" : "SET"} NOT NULL;`);
        } else if (dialect === "mysql") {
          // MODIFY redefines the whole column: what it had besides type and NULL must be written again.
          const kept = [c.target.default != null && c.target.default !== "" ? `DEFAULT ${c.target.default}` : "", c.target.identity ? "AUTO_INCREMENT" : ""].filter(Boolean);
          if (kept.length) lines.push(`-- ${c.target.name} tiene ${kept.join(" y ")}: MODIFY lo quita si no se repite (revisa también COMMENT y COLLATE)`);
          lines.push(`ALTER TABLE ${t} MODIFY COLUMN ${col} ${s.typeName} ${nullSql(s)};`);
        }
        else if (dialect === "mssql") lines.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${s.typeName} ${nullSql(s)};`);
        else if (dialect === "informix") {
          // MODIFY redefines the whole column and drops what it had: its DEFAULT is written again, its constraints
          // cannot be (they are not read), so a comment says so.
          const def = c.target.default != null && c.target.default !== "" ? ` DEFAULT ${c.target.default}` : "";
          const constraints = c.target.primaryKey ? "la PRIMARY KEY si es solo de esta columna, y UNIQUE, REFERENCES o CHECK" : "UNIQUE, REFERENCES o CHECK";
          lines.push(`-- MODIFY quita las restricciones de una sola columna de ${c.target.name} (${constraints}): añádelas detrás si las tenía`);
          lines.push(`ALTER TABLE ${t} MODIFY (${col} ${s.typeName}${def}${s.nullable ? "" : " NOT NULL"});`);
        }
        else lines.push(`-- ${engineLabel(dialect)} no cambia el tipo de una columna con ALTER: ${c.target.name} ${c.target.typeName} → ${s.typeName}${s.nullable === c.target.nullable ? "" : `, ${nullSql(s)}`} (hay que recrear la tabla)`);
      }
    }
  }

  const extra = diffs.filter((d) => d.status === "only-target");
  if (extra.length) {
    section(`Tablas que solo están en el destino (${extra.length}): borrarlas eliminaría sus datos`);
    for (const d of extra) lines.push(`-- DROP TABLE ${table(d.name)};`);
  }
  if (!lines.length) return "-- Los dos esquemas tienen la misma estructura: no hay nada que cambiar.\n";
  return `${lines.join("\n").trim()}\n`;
}

/**
 * The source's DDL pointed at the target schema: "sc_a"."t" (and its REFERENCES to sibling tables) become
 * "sc_b"."t", quoted or not. Without a schema on either side it is left as it is.
 */
function retarget(ddl: string, options: SyncOptions): string {
  const from = options.sourceSchema;
  if (!from || !options.schema || from === options.schema || options.dialect === "sqlite") return ddl;
  const to = `${quoteIdentFor(options.schema, options.dialect)}.`;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedForms = [`"${from.replace(/"/g, '""')}"`, `\`${from.replace(/`/g, "``")}\``, `[${from.replace(/]/g, "]]")}]`].map(escape);
  const pattern = new RegExp(`(?:${quotedForms.join("|")}|(?<![\\w"\`\\]])${escape(from)})\\s*\\.`, "g");
  return ddl.replace(pattern, to);
}

function engineLabel(kind: DbKind): string {
  return { postgres: "PostgreSQL", mysql: "MySQL / MariaDB", mssql: "SQL Server", sqlite: "SQLite", informix: "Informix", odbc: "ODBC" }[kind] ?? kind;
}
