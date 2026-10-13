// What the test data generator (testData.ts) reads from a table besides its columns, per dialect: unique keys and
// indexes, CHECK constraints, native enums; the catalog SQL for each engine, the row counts and maxima it starts
// after, the parent keys a foreign key may take, and how a column's declared type bounds its values (length,
// precision, range). Pure, so dev/testdata-check.ts tests it and dev/engine-sql.ts runs its SQL on every engine.
import { sqlLiteral } from "./sql.ts";
import type { Cell, DbKind, TableColumn } from "./types";

// ---------------------------------------------------------------- dialect

/**
 * The SQL dialect behind a connection: its own kind, or for generic ODBC the engine its driver reports (psqlODBC to
 * PostgreSQL writes and reads like PostgreSQL). "odbc" when the engine is not one Celer knows.
 */
export function effectiveDialect(kind: DbKind, serverInfo = ""): DbKind {
  if (kind !== "odbc") return kind;
  const info = serverInfo.toLowerCase();
  if (/postgres/.test(info)) return "postgres";
  if (/mysql|mariadb/.test(info)) return "mysql";
  if (/sql server|microsoft sql/.test(info)) return "mssql";
  if (/sqlite/.test(info)) return "sqlite";
  if (/informix|\bids\b/.test(info)) return "informix";
  return "odbc";
}

// ---------------------------------------------------------------- declared types

export type TypeFamily = "int" | "decimal" | "float" | "bool" | "date" | "datetime" | "time" | "year" | "uuid" | "json" | "xml" | "text" | "char" | "binary" | "interval" | "other";

export interface TypeInfo {
  family: TypeFamily;
  /** Characters (or bytes, see `bytes`) a text column holds; bytes a binary one holds. Undefined: no stated limit. */
  maxLength?: number;
  /** CHAR(n) / BINARY(n): every value is padded to n by the server; a shorter one is fine, but n is the target. */
  fixed?: boolean;
  /** The limit counts bytes (Informix VARCHAR / CHAR; a multi-byte character takes several). */
  bytes?: boolean;
  precision?: number;
  scale?: number;
  /** Integer range of the type (decimal strings: BIGINT does not fit a JavaScript number). */
  min?: string;
  max?: string;
  /** Why values of this type cannot be written as SQL literals (Informix BYTE / TEXT / BLOB). */
  noLiteral?: string;
}

const INT_RANGES: Record<string, [string, string]> = {
  tinyint: ["-128", "127"],
  smallint: ["-32768", "32767"],
  mediumint: ["-8388608", "8388607"],
  int: ["-2147483648", "2147483647"],
  bigint: ["-9223372036854775808", "9223372036854775807"],
};

/** The family, limits and range of a column's declared type, as each driver names it. */
export function typeInfo(col: Pick<TableColumn, "typeName" | "kind">, dialect: DbKind): TypeInfo {
  const raw = col.typeName.trim().toLowerCase();
  const args = /\(([^)]*)\)/.exec(raw)?.[1]?.split(",").map((part) => Number(part.trim())) ?? [];
  const base = raw.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  const unsigned = /\bunsigned\b/.test(base);
  const word = base.replace(/\b(unsigned|zerofill|signed)\b/g, "").trim();
  const n = Number.isFinite(args[0]) && args[0] > 0 ? args[0] : undefined;
  const intRange = (name: keyof typeof INT_RANGES): TypeInfo => {
    // SQLite keeps any integer in up to 8 bytes, whatever the declared type says.
    let [min, max] = INT_RANGES[dialect === "sqlite" ? "bigint" : name];
    if (unsigned && dialect !== "sqlite") {
      max = (BigInt(max) * 2n + 1n).toString();
      min = "0";
    }
    // SQL Server's TINYINT is 0..255.
    if (name === "tinyint" && dialect === "mssql") [min, max] = ["0", "255"];
    return { family: "int", min, max };
  };
  if (dialect === "informix" && /^(byte|text|blob|clob)$/.test(word)) return { family: word === "text" || word === "clob" ? "text" : "binary", noLiteral: `Informix no admite valores literales en columnas ${word.toUpperCase()}` };
  if (/^(bool|boolean|bit)$/.test(word) && (word !== "bit" || dialect === "mssql" || !n || n === 1)) return { family: "bool" };
  // MySQL / MariaDB BIT(n): an integer of n bits (written as a number, 0 … 2^n - 1).
  if (word === "bit" && dialect === "mysql" && n && n > 1 && n <= 64) return { family: "int", min: "0", max: (2n ** BigInt(n) - 1n).toString() };
  // MySQL / MariaDB spatial types take only geometry values (ST_GeomFromText…), never a plain literal.
  if (dialect === "mysql" && /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)$/.test(word)) {
    return { family: "other", noLiteral: `Celer no genera valores espaciales (${word.toUpperCase()})` };
  }
  if (/^tinyint$/.test(word) && col.kind === "bool") return { family: "bool" };
  if (/^(tinyint|int1)$/.test(word)) return intRange("tinyint");
  if (/^(smallint|int2|smallserial|serial2)$/.test(word)) return intRange("smallint");
  if (/^mediumint$/.test(word)) return intRange("mediumint");
  if (/^(int|integer|int4|serial|serial4)$/.test(word)) return intRange("int");
  if (/^(bigint|int8|bigserial|serial8|long)$/.test(word)) return intRange("bigint");
  if (/^(decimal|numeric|dec|number)$/.test(word)) {
    // A floating DECIMAL (Informix DECIMAL(p) without scale, PostgreSQL NUMERIC without precision): 2 decimals.
    const precision = n;
    const scale = Number.isFinite(args[1]) ? args[1] : dialect === "informix" || !precision ? 2 : 0;
    return { family: "decimal", precision: precision ?? 12, scale: Math.min(scale, precision ?? 12) };
  }
  if (/^(money|smallmoney)$/.test(word)) return { family: "decimal", precision: word === "smallmoney" ? 10 : 15, scale: 2 };
  if (/^(real|float|float4|float8|double|double precision|smallfloat|binary_float|binary_double)$/.test(word)) return { family: "float", precision: 9, scale: 2 };
  if (/^year$/.test(word)) return { family: "year", min: "1901", max: "2155" };
  if (/^date$/.test(word)) return { family: "date" };
  if (/^(time|timetz|time with(out)? time zone)$/.test(word) || /^datetime hour to/.test(word)) return { family: "time" };
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset|timestamp|timestamptz|timestamp with(out)? time zone)$/.test(word) || /^datetime year to/.test(word)) {
    if (/^datetime year to (year|month|day)$/.test(word)) return { family: "date" };
    return { family: "datetime" };
  }
  if (/^interval/.test(word)) return { family: "interval" };
  if (/^(uuid|uniqueidentifier)$/.test(word)) return { family: "uuid" };
  if (/^(json|jsonb)$/.test(word)) return { family: "json" };
  if (/^xml$/.test(word)) return { family: "xml" };
  if (/^(rowversion)$/.test(word)) return { family: "other" };
  if (/^(binary|varbinary|bytea|blob|tinyblob|mediumblob|longblob|image|raw|byte|long raw)$/.test(word)) {
    return { family: "binary", maxLength: word === "binary" || word === "varbinary" ? n : undefined, fixed: word === "binary" };
  }
  if (/^(char|nchar|character|bpchar)$/.test(word)) return { family: "char", maxLength: n, fixed: true, bytes: dialect === "informix" };
  if (/^(varchar|nvarchar|character varying|varchar2|nvarchar2|lvarchar|varying character|string|citext)$/.test(word) || /^(enum|set)$/.test(word)) {
    // VARCHAR(MAX) / NVARCHAR(MAX) read as -1 or 0: no limit. LVARCHAR without a size holds 2048.
    const limit = n && n > 0 ? n : word === "lvarchar" ? 2048 : undefined;
    return { family: "text", maxLength: limit, bytes: dialect === "informix" };
  }
  if (/^(text|ntext|tinytext|mediumtext|longtext|clob|nclob|memo)$/.test(word)) return { family: "text", maxLength: word === "tinytext" ? 255 : undefined };
  if (/^(inet|cidr|inet4|inet6)$/.test(word)) return { family: "other" };
  // By the kind the driver gave, for names Celer does not list.
  if (col.kind === "number") return /int/.test(word) ? intRange("int") : { family: "decimal", precision: 12, scale: 2 };
  if (col.kind === "bool") return { family: "bool" };
  if (col.kind === "date") return /time/.test(word) ? { family: "datetime" } : { family: "date" };
  if (col.kind === "binary") return { family: "binary" };
  if (col.kind === "text") return { family: "text", maxLength: n };
  return { family: "other" };
}

/** The values of a MySQL ENUM('a','b') / SET('a','b') column type, else null. */
export function enumValues(typeName: string): string[] | null {
  const m = /^\s*(enum|set)\s*\((.*)\)\s*$/is.exec(typeName);
  if (!m) return null;
  const out: string[] = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[2]))) out.push(hit[1].replace(/''/g, "'").replace(/\\(.)/g, "$1"));
  return out;
}

// ---------------------------------------------------------------- catalog queries

export interface TableRef {
  /** Database (catalog) and schema (owner on Informix) of the table; empty: the session's. */
  database: string;
  schema: string;
  name: string;
  /** The qualified name as the driver writes it. */
  qualified: string;
}

export type CatalogPart = "unique" | "check" | "enum" | "auto" | "engine" | "domain";

/** One catalog query. Every one returns four columns: a constraint or index name, a column, a position, a text. */
export interface CatalogQuery {
  part: CatalogPart;
  sql: string;
}

/** A string literal. MySQL and MariaDB read a backslash as an escape, so it is doubled there too: otherwise a name
 *  with a backslash before a quote would close the literal early and the rest of the name would run as SQL. */
const lit = (value: string, dialect?: DbKind) => sqlLiteral(value, "text", dialect === "mysql" ? "mysql" : undefined);

/**
 * The catalog queries for a table: its unique keys and indexes (primary key included, partial and expression ones
 * left out), its CHECK constraints and its native enum types. Each is run on its own; one the server refuses (an old
 * version without that view) leaves that part unknown. `serverInfo` tells MariaDB from MySQL.
 */
export function catalogQueries(dialect: DbKind, t: TableRef, serverInfo = ""): CatalogQuery[] {
  const out: CatalogQuery[] = [];
  if (dialect === "postgres") {
    const where = `n.nspname = COALESCE(NULLIF(${lit(t.schema)}, ''), current_schema()) AND c.relname = ${lit(t.name)}`;
    const from = "pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace";
    out.push({
      part: "unique",
      sql:
        `SELECT ic.relname::text, a.attname::text, k.ord::int, '' FROM ${from} ` +
        "JOIN pg_catalog.pg_index i ON i.indrelid = c.oid JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid " +
        "CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) " +
        "JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum " +
        `WHERE i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL AND k.ord <= i.indnkeyatts AND ${where} ORDER BY 1, 3`,
    });
    out.push({
      part: "check",
      sql: `SELECT con.conname::text, '', 0, pg_catalog.pg_get_constraintdef(con.oid) FROM ${from} JOIN pg_catalog.pg_constraint con ON con.conrelid = c.oid WHERE con.contype = 'c' AND ${where} ORDER BY 1`,
    });
    out.push({
      part: "enum",
      sql:
        `SELECT t.typname::text, a.attname::text, a.attnum::int, e.enumlabel::text FROM ${from} ` +
        "JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped " +
        "JOIN pg_catalog.pg_type t ON t.oid = a.atttypid JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid " +
        `WHERE ${where} ORDER BY a.attnum, e.enumsortorder`,
    });
    out.push({
      part: "auto",
      sql:
        `SELECT '', a.attname::text, a.attnum::int, '' FROM ${from} JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ` +
        "LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum " +
        `WHERE (a.attidentity <> '' OR a.attgenerated <> '' OR pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%') AND ${where}`,
    });
    // Columns of a domain: its base type with its modifiers (varchar(4)), its NOT NULL (position 1) and its CHECKs.
    const domainCols = `${from} JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped JOIN pg_catalog.pg_type t ON t.oid = a.atttypid`;
    out.push({
      part: "domain",
      sql:
        `SELECT 'type', a.attname::text, CASE WHEN t.typnotnull THEN 1 ELSE 0 END, pg_catalog.format_type(t.typbasetype, t.typtypmod) FROM ${domainCols} WHERE t.typtype = 'd' AND ${where} ` +
        `UNION ALL SELECT 'check', a.attname::text, 0, pg_catalog.pg_get_constraintdef(con.oid) FROM ${domainCols} JOIN pg_catalog.pg_constraint con ON con.contypid = t.oid ` +
        `WHERE t.typtype = 'd' AND con.contype = 'c' AND ${where}`,
    });
  } else if (dialect === "mysql") {
    const db = `COALESCE(NULLIF(${lit(t.database || t.schema, dialect)}, ''), DATABASE())`;
    out.push({
      part: "unique",
      sql: `SELECT INDEX_NAME, COALESCE(COLUMN_NAME, ''), SEQ_IN_INDEX, '' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${lit(t.name, dialect)} AND NON_UNIQUE = 0 ORDER BY 1, 3`,
    });
    out.push({
      part: "auto",
      // Computed columns, not MySQL 8's DEFAULT_GENERATED (a DEFAULT CURRENT_TIMESTAMP column takes values).
      sql: `SELECT '', COLUMN_NAME, ORDINAL_POSITION, '' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${lit(t.name, dialect)} AND (EXTRA LIKE '%auto_increment%' OR EXTRA LIKE '%VIRTUAL GENERATED%' OR EXTRA LIKE '%STORED GENERATED%' OR EXTRA LIKE '%PERSISTENT GENERATED%')`,
    });
    out.push({ part: "engine", sql: tableEngineSql(t) });
    // MariaDB names a column-level CHECK after its column (names repeat across tables) and lists the table itself.
    out.push(
      /mariadb/i.test(serverInfo)
        ? { part: "check", sql: `SELECT CONSTRAINT_NAME, '', 0, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${db} AND TABLE_NAME = ${lit(t.name, dialect)} ORDER BY 1` }
        : {
            part: "check",
            sql:
              "SELECT cc.CONSTRAINT_NAME, '', 0, cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc " +
              "ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME " +
              `WHERE tc.CONSTRAINT_TYPE = 'CHECK' AND tc.TABLE_SCHEMA = ${db} AND tc.TABLE_NAME = ${lit(t.name, dialect)} ORDER BY 1`,
          },
    );
  } else if (dialect === "mssql") {
    const id = `OBJECT_ID(N${lit(t.qualified)})`;
    out.push({
      part: "unique",
      sql:
        "SELECT i.name, c.name, ic.key_ordinal, '' FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id " +
        `JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = ${id} AND i.is_unique = 1 AND i.has_filter = 0 AND ic.is_included_column = 0 ORDER BY 1, 3`,
    });
    out.push({
      part: "check",
      sql: `SELECT cc.name, COALESCE(c.name, ''), 0, cc.definition FROM sys.check_constraints cc LEFT JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id WHERE cc.parent_object_id = ${id} AND cc.is_disabled = 0 ORDER BY 1`,
    });
    out.push({
      part: "auto",
      sql: `SELECT '', c.name, c.column_id, '' FROM sys.columns c WHERE c.object_id = ${id} AND (c.is_identity = 1 OR c.is_computed = 1 OR TYPE_NAME(c.system_type_id) = 'timestamp')`,
    });
  } else if (dialect === "sqlite") {
    const schema = lit(t.schema || "main");
    out.push({
      part: "unique",
      sql: `SELECT il.name, COALESCE(ii.name, ''), ii.seqno, '' FROM pragma_index_list(${lit(t.name)}, ${schema}) AS il, pragma_index_info(il.name, ${schema}) AS ii WHERE il."unique" = 1 AND il.partial = 0 ORDER BY 1, 3`,
    });
    // The CHECK constraints are read from the CREATE TABLE text.
    out.push({ part: "check", sql: `SELECT name, '', 0, sql FROM ${schema === "'main'" ? "" : `"${(t.schema || "main").replace(/"/g, '""')}".`}sqlite_master WHERE type = 'table' AND name = ${lit(t.name)}` });
  } else if (dialect === "informix") {
    const db = t.database ? `${t.database}:` : "";
    const owner = t.schema ? ` AND t.owner = ${lit(t.schema)}` : "";
    const parts = Array.from({ length: 16 }, (_, i) => `ABS(i.part${i + 1})`).join(", ");
    out.push({
      part: "unique",
      sql: `SELECT i.idxname, c.colname, c.colno, '' FROM ${db}systables t, ${db}sysindexes i, ${db}syscolumns c WHERE t.tabname = ${lit(t.name)}${owner} AND i.tabid = t.tabid AND i.idxtype = 'U' AND c.tabid = t.tabid AND c.colno IN (${parts}) ORDER BY 1, 3`,
    });
    out.push({
      part: "check",
      sql: `SELECT c.constrname, '', k.seqno, k.checktext FROM ${db}systables t, ${db}sysconstraints c, ${db}syschecks k WHERE t.tabname = ${lit(t.name)}${owner} AND c.tabid = t.tabid AND c.constrtype = 'C' AND k.constrid = c.constrid AND k.type = 'T' ORDER BY 1, 3`,
    });
  }
  return out;
}

/**
 * MySQL / MariaDB: the table's storage engine and whether it takes transactions (YES / NO; MyISAM, Aria, MEMORY… keep
 * every row written before a failure or a Cancelar). Four columns like catalogQueries: engine, '', 0, transactions.
 */
export function tableEngineSql(t: Pick<TableRef, "database" | "schema" | "name">): string {
  const db = `COALESCE(NULLIF(${lit(t.database || t.schema, "mysql")}, ''), DATABASE())`;
  return (
    "SELECT t.ENGINE, '', 0, COALESCE(e.TRANSACTIONS, '') FROM information_schema.TABLES t LEFT JOIN information_schema.ENGINES e ON e.ENGINE = t.ENGINE " +
    `WHERE t.TABLE_SCHEMA = ${db} AND t.TABLE_NAME = ${lit(t.name, "mysql")}`
  );
}

/** The engine of a table whose engine takes no transactions, from tableEngineSql's rows; "" when it takes them. */
export function nonTransactionalEngine(rows: Cell[][] | null): string {
  const row = rows?.[0];
  return row && text(row[3]).trim().toUpperCase() === "NO" ? text(row[0]).trim() || "?" : "";
}

/** The warning before writing into a table whose engine takes no transactions (test data and the import). */
export function nonTransactionalNote(engine: string): string {
  return `La tabla es ${engine}, que no admite transacciones: si la inserción falla o se cancela, las filas ya insertadas se quedan en la tabla`;
}

/** The rows of the table and, for each listed column, its largest value: unique numbers continue after it. */
export function statsSql(qualified: string, quoted: string[]): string {
  return `SELECT COUNT(*)${quoted.map((q) => `, MAX(${q})`).join("")} FROM ${qualified}`;
}

/** Up to `limit` keys of a referenced table (rows with every key column set), in a stable order. */
export function parentKeysSql(dialect: DbKind, qualified: string, quoted: string[], limit: number): string {
  const top = dialect === "mssql" ? `TOP ${limit} ` : dialect === "informix" ? `FIRST ${limit} ` : "";
  const tail = dialect === "postgres" || dialect === "mysql" || dialect === "sqlite" ? ` LIMIT ${limit}` : "";
  const order = quoted.map((_, i) => String(i + 1)).join(", ");
  return `SELECT ${top}${quoted.join(", ")} FROM ${qualified} WHERE ${quoted.map((q) => `${q} IS NOT NULL`).join(" AND ")} ORDER BY ${order}${tail}`;
}

/**
 * Up to `limit` values already in a column (so unique values do not repeat them). SQL Server and Informix take a single
 * NULL in a unique column, so its NULL is read too (a generated one would be a duplicate); the table is read whole
 * anyway (existingToRead: not more rows than the limit).
 */
export function existingValuesSql(dialect: DbKind, qualified: string, quoted: string, limit: number): string {
  const top = dialect === "mssql" ? `TOP ${limit} ` : dialect === "informix" ? `FIRST ${limit} ` : "";
  const tail = dialect === "postgres" || dialect === "mysql" || dialect === "sqlite" ? ` LIMIT ${limit}` : "";
  const where = dialect === "mssql" || dialect === "informix" ? "" : ` WHERE ${quoted} IS NOT NULL`;
  return `SELECT ${top}${quoted} FROM ${qualified}${where}${tail}`;
}

// ---------------------------------------------------------------- reading the catalog's answers

export interface CatalogFacts {
  /** Unique keys and indexes (the primary key too), as column names, each once. */
  uniques: string[][];
  /** CHECK constraint texts. */
  checks: { name: string; column: string; text: string }[];
  /** Native enum values per column (PostgreSQL). */
  enums: Record<string, string[]>;
  /** Columns the server fills (identity, computed): what a generic ODBC driver does not say. */
  auto?: string[];
  /** The table's storage engine when it takes no transactions (MySQL MyISAM, MariaDB Aria…); else empty. */
  nonTransactional?: string;
  /** Columns of a PostgreSQL domain: its base type (with modifiers) and whether the domain is NOT NULL. Its CHECKs
   *  are in `checks`, VALUE written as the column. */
  domains?: Record<string, { type: string; notNull: boolean }>;
}

const text = (cell: Cell | undefined) => (cell === null || cell === undefined ? "" : String(cell));

/** The answers of catalogQueries, read: `parts` pairs each query's part with its rows (null: the server refused it). */
export function readCatalog(parts: { part: CatalogPart; rows: Cell[][] | null }[], dialect: DbKind): CatalogFacts {
  const facts: CatalogFacts = { uniques: [], checks: [], enums: {}, auto: [] };
  for (const { part, rows } of parts) {
    if (!rows) continue;
    if (part === "unique") {
      const byIndex = new Map<string, string[]>();
      const broken = new Set<string>();
      for (const row of rows) {
        const name = text(row[0]).trim();
        const col = text(row[1]).trim();
        if (!col) broken.add(name);
        else byIndex.set(name, [...(byIndex.get(name) ?? []), col]);
      }
      const seen = new Set<string>();
      for (const [name, cols] of byIndex) {
        if (broken.has(name)) continue;
        const key = [...cols].sort().join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        facts.uniques.push(cols);
      }
    } else if (part === "check") {
      if (dialect === "sqlite") {
        for (const row of rows) for (const clause of checkClauses(text(row[3]))) facts.checks.push({ name: "", column: "", text: clause });
        continue;
      }
      // Informix keeps a CHECK in pieces of 32 characters (seqno order); a piece's trailing blanks are part of it.
      const byName = new Map<string, { column: string; pieces: string[] }>();
      for (const row of rows) {
        const name = text(row[0]).trim();
        const entry = byName.get(name) ?? { column: text(row[1]).trim(), pieces: [] };
        entry.pieces.push(text(row[3]));
        byName.set(name, entry);
      }
      for (const [name, entry] of byName) {
        let joined = dialect === "informix" ? entry.pieces.map((piece, i) => (i < entry.pieces.length - 1 ? piece.padEnd(32, " ") : piece)).join("") : entry.pieces.join("");
        // MySQL 8 shows the quotes of a CHECK escaped: (`p` in (_utf8mb4\'a\',_utf8mb4\'b\')).
        if (dialect === "mysql") joined = joined.replace(/\\'/g, "'");
        facts.checks.push({ name, column: entry.column, text: joined.trim() });
      }
    } else if (part === "domain") {
      for (const row of rows) {
        const col = text(row[1]);
        if (text(row[0]) === "type") (facts.domains ??= {})[col] = { type: text(row[3]).trim(), notNull: Number(row[2]) === 1 };
        else facts.checks.push({ name: "", column: col, text: domainCheck(text(row[3]), col) });
      }
    } else if (part === "engine") {
      facts.nonTransactional = nonTransactionalEngine(rows);
    } else if (part === "auto") {
      for (const row of rows) (facts.auto ??= []).push(text(row[1]));
    } else if (part === "enum") {
      for (const row of rows) {
        const col = text(row[1]);
        (facts.enums[col] ??= []).push(text(row[3]));
      }
    }
  }
  return facts;
}

/** A domain's CHECK with VALUE written as the column (outside string literals), to read like a table's CHECK. */
export function domainCheck(check: string, column: string): string {
  const quoted = `"${column.replace(/"/g, '""')}"`;
  return check
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\bVALUE\b/gi, quoted)))
    .join("");
}

/** The CHECK (…) clauses of a CREATE TABLE text (SQLite keeps only that). */
export function checkClauses(ddl: string): string[] {
  const out: string[] = [];
  const re = /\bcheck\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ddl))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote = "";
    const start = i;
    for (; i < ddl.length && depth > 0; i++) {
      const c = ddl[i];
      if (quote) {
        if (c === quote) quote = ddl[i + 1] === quote ? (i++, quote) : "";
        continue;
      }
      if (c === "'" || c === '"' || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(ddl.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

// ---------------------------------------------------------------- CHECK constraints

/** What a CHECK constraint says about one column: the values it allows, or the range. */
export interface ColumnRule {
  values?: string[];
  min?: number;
  max?: number;
  /** Strict bounds (> and <). */
  minOpen?: boolean;
  maxOpen?: boolean;
  /** json_valid(col) / ISJSON(col): only JSON text goes in (MariaDB's JSON is LONGTEXT with this CHECK). */
  json?: boolean;
}

export interface CheckReading {
  rules: Record<string, ColumnRule>;
  /** Columns a CHECK limits in a way Celer does not read (the generator may break it). */
  unknown: string[];
}

type Tok = { t: "id" | "num" | "str" | "op" | "(" | ")" | "," | "[" | "]"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      let v = "";
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (src[i] === "'") {
          i++;
          break;
        } else if (src[i] === "\\" && i + 1 < src.length) {
          v += src[i + 1];
          i += 2;
        } else v += src[i++];
      }
      out.push({ t: "str", v });
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      // "[" opens an identifier on SQL Server; elsewhere (ARRAY[…]) a bracket.
      if (c === "[" && out.length && /^array$/i.test(out[out.length - 1].v)) {
        out.push({ t: "[", v: c });
        i++;
        continue;
      }
      const end = src.indexOf(close, i + 1);
      out.push({ t: "id", v: src.slice(i + 1, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 1;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_À-￿]/.test(c)) {
      const m = /^[A-Za-z_À-￿][\w$À-￿]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else if (c === "(" || c === ")" || c === "," || c === "]") {
      out.push({ t: c as Tok["t"], v: c });
      i++;
    } else if (src.startsWith("::", i)) {
      out.push({ t: "op", v: "::" });
      i += 2;
    } else {
      const m = /^(<=|>=|<>|!=|=|<|>|\|\||[-+*/%])/.exec(src.slice(i));
      out.push({ t: "op", v: m ? m[0] : c });
      i += m ? m[0].length : 1;
    }
  }
  return out;
}

type Node =
  | { k: "and" | "or"; parts: Node[] }
  | { k: "not"; part: Node }
  | { k: "cmp"; op: string; left: Expr; right: Expr }
  | { k: "in"; left: Expr; list: Expr[]; not: boolean }
  | { k: "between"; left: Expr; low: Expr; high: Expr; not: boolean }
  | { k: "isnull"; left: Expr; not: boolean }
  | { k: "json"; col: string }
  | { k: "other"; cols: string[] };
type Expr = { k: "col"; name: string } | { k: "lit"; value: string; num: boolean } | { k: "fn"; name: string; cols: string[] } | { k: "list"; items: Expr[] };

/** A recursive-descent reading of a CHECK expression, enough for IN, BETWEEN, comparisons, AND, OR and NOT. */
function parseCheck(src: string, columns: string[]): Node {
  // MySQL charset introducers (_utf8mb4'a'), SQL Server's national string prefix (N'a') and PostgreSQL casts
  // (::text, ::character varying[]) say nothing here.
  const toks = tokenize(src).filter((tok, i, all) => !(tok.t === "id" && /^(_\w+|n)$/i.test(tok.v) && all[i + 1]?.t === "str"));
  let pos = 0;
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const peek = (o = 0) => toks[pos + o];
  const isKw = (tok: Tok | undefined, kw: string) => tok?.t === "id" && tok.v.toUpperCase() === kw;
  const colsIn = (e: Expr): string[] => (e.k === "col" ? [e.name] : e.k === "fn" ? e.cols : e.k === "list" ? e.items.flatMap(colsIn) : []);
  const skipCast = () => {
    while (peek()?.t === "op" && peek().v === "::") {
      pos++;
      while (peek()?.t === "id" && !isKw(peek(), "AND") && !isKw(peek(), "OR") && !isKw(peek(), "IN")) pos++;
      if (peek()?.t === "(") {
        let depth = 0;
        do {
          if (peek().t === "(") depth++;
          if (peek().t === ")") depth--;
          pos++;
        } while (pos < toks.length && depth > 0);
      }
      if (peek()?.t === "[" || (peek()?.t === "op" && peek().v === "[")) pos += 2;
    }
  };
  const primary = (): Expr => {
    const tok = peek();
    if (!tok) return { k: "lit", value: "", num: false };
    if (tok.t === "(") {
      pos++;
      const items: Expr[] = [];
      // A parenthesised value, or an expression (the caller sees an "other").
      const start = pos;
      const first = addExpr();
      if (peek()?.t === ")") {
        pos++;
        skipCast();
        return first;
      }
      if (peek()?.t === ",") {
        items.push(first);
        while (peek()?.t === ",") {
          pos++;
          items.push(addExpr());
        }
        if (peek()?.t === ")") pos++;
        return { k: "list", items };
      }
      // Not a value: skip to the matching parenthesis, keep the columns it uses.
      pos = start;
      let depth = 1;
      const cols: string[] = [];
      while (pos < toks.length && depth > 0) {
        const t = toks[pos++];
        if (t.t === "(") depth++;
        else if (t.t === ")") depth--;
        else if (t.t === "id" && lower.has(t.v.toLowerCase())) cols.push(lower.get(t.v.toLowerCase())!);
      }
      return { k: "fn", name: "", cols };
    }
    if (tok.t === "num") {
      pos++;
      skipCast();
      return { k: "lit", value: tok.v, num: true };
    }
    if (tok.t === "str") {
      pos++;
      // PostgreSQL writes a negative bound as a string cast to a number: '-10'::integer.
      const numeric = peek()?.t === "op" && peek().v === "::" && /^(integer|int|int[248]|bigint|smallint|numeric|decimal|real|double|float[48])$/i.test(peek(1)?.v ?? "") && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(tok.v.trim());
      skipCast();
      return { k: "lit", value: numeric ? tok.v.trim().replace(/^\+/, "") : tok.v, num: numeric };
    }
    if (tok.t === "op" && (tok.v === "-" || tok.v === "+") && peek(1)?.t === "num") {
      pos += 2;
      skipCast();
      return { k: "lit", value: (tok.v === "-" ? "-" : "") + toks[pos - 1].v, num: true };
    }
    // MySQL 8 writes it as -(10).
    if (tok.t === "op" && (tok.v === "-" || tok.v === "+") && peek(1)?.t === "(" && peek(2)?.t === "num" && peek(3)?.t === ")") {
      pos += 4;
      skipCast();
      return { k: "lit", value: (tok.v === "-" ? "-" : "") + toks[pos - 2].v, num: true };
    }
    if (tok.t === "id") {
      pos++;
      if (isKw(tok, "ARRAY") && (peek()?.t === "[")) {
        pos++;
        const items: Expr[] = [];
        while (peek() && peek().t !== "]") {
          items.push(addExpr());
          if (peek()?.t === ",") pos++;
        }
        pos++;
        skipCast();
        return { k: "list", items };
      }
      if (peek()?.t === "(") {
        // A function call: its columns are what matters.
        let depth = 0;
        const cols: string[] = [];
        do {
          const t = toks[pos++];
          if (t.t === "(") depth++;
          else if (t.t === ")") depth--;
          else if (t.t === "id" && lower.has(t.v.toLowerCase())) cols.push(lower.get(t.v.toLowerCase())!);
        } while (pos < toks.length && depth > 0);
        skipCast();
        return { k: "fn", name: tok.v.toLowerCase(), cols };
      }
      // table.column: the column.
      while (peek()?.t === "op" && peek().v === "." && peek(1)?.t === "id") pos += 2;
      skipCast();
      const name = lower.get(tok.v.toLowerCase());
      if (isKw(tok, "NULL")) return { k: "lit", value: "NULL", num: false };
      if (isKw(tok, "TRUE") || isKw(tok, "FALSE")) return { k: "lit", value: tok.v.toLowerCase(), num: false };
      return name ? { k: "col", name } : { k: "fn", name: tok.v.toLowerCase(), cols: [] };
    }
    pos++;
    return { k: "fn", name: "?", cols: [] };
  };
  const addExpr = (): Expr => {
    let left = primary();
    while (peek()?.t === "op" && /^[-+*/%]$|^\|\|$/.test(peek().v)) {
      pos++;
      const right = primary();
      left = { k: "fn", name: "arith", cols: [...colsIn(left), ...colsIn(right)] };
    }
    return left;
  };
  const predicate = (): Node => {
    if (peek()?.t === "(") {
      // A parenthesised condition, or a parenthesised value compared afterwards.
      const save = pos;
      pos++;
      const inner = orExpr();
      if (peek()?.t === ")") {
        pos++;
        const next = peek();
        if (!(next && (next.t === "op" || isKw(next, "IN") || isKw(next, "BETWEEN") || isKw(next, "IS") || isKw(next, "NOT")))) return inner;
      }
      pos = save;
    }
    const left = addExpr();
    const tok = peek();
    let not = false;
    if (isKw(tok, "NOT") && (isKw(peek(1), "IN") || isKw(peek(1), "BETWEEN") || isKw(peek(1), "LIKE"))) {
      not = true;
      pos++;
    }
    const kw = peek();
    if (isKw(kw, "IN")) {
      pos++;
      const list = primary();
      return { k: "in", left, list: list.k === "list" ? list.items : [list], not };
    }
    if (isKw(kw, "BETWEEN")) {
      pos++;
      const low = addExpr();
      if (isKw(peek(), "AND")) pos++;
      const high = addExpr();
      return { k: "between", left, low, high, not };
    }
    if (isKw(kw, "IS")) {
      pos++;
      const isNot = isKw(peek(), "NOT");
      if (isNot) pos++;
      if (isKw(peek(), "NULL")) pos++;
      return { k: "isnull", left, not: isNot };
    }
    if (kw?.t === "op" && /^(=|<>|!=|<|>|<=|>=)$/.test(kw.v)) {
      pos++;
      if (isKw(peek(), "ANY") || isKw(peek(), "SOME")) {
        pos++;
        const list = primary();
        return kw.v === "=" ? { k: "in", left, list: list.k === "list" ? list.items : [list], not: false } : { k: "other", cols: colsIn(left) };
      }
      const right = addExpr();
      // ISJSON(col) = 1 / > 0 (SQL Server writes it so): the column holds JSON.
      if (left.k === "fn" && /^(json_valid|isjson)$/.test(left.name) && right.k === "lit" && ((kw.v === "=" && right.value === "1") || (kw.v === ">" && right.value === "0"))) return { k: "json", col: left.cols[0] ?? "" };
      return { k: "cmp", op: kw.v === "!=" ? "<>" : kw.v, left, right };
    }
    if (isKw(kw, "LIKE")) {
      pos++;
      addExpr();
      return { k: "other", cols: colsIn(left) };
    }
    return left.k === "fn" && /^(json_valid|isjson)$/.test(left.name) ? { k: "json", col: left.cols[0] ?? "" } : { k: "other", cols: colsIn(left) };
  };
  const notExpr = (): Node => {
    if (isKw(peek(), "NOT")) {
      pos++;
      return { k: "not", part: notExpr() };
    }
    return predicate();
  };
  const andExpr = (): Node => {
    const parts = [notExpr()];
    while (isKw(peek(), "AND")) {
      pos++;
      parts.push(notExpr());
    }
    return parts.length === 1 ? parts[0] : { k: "and", parts };
  };
  const orExpr = (): Node => {
    const parts = [andExpr()];
    while (isKw(peek(), "OR")) {
      pos++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { k: "or", parts };
  };
  const node = orExpr();
  return pos < toks.length ? { k: "other", cols: toks.filter((t) => t.t === "id" && lower.has(t.v.toLowerCase())).map((t) => lower.get(t.v.toLowerCase())!) } : node;
}

function nodeCols(node: Node): string[] {
  const exprCols = (e: Expr): string[] => (e.k === "col" ? [e.name] : e.k === "fn" ? e.cols : e.k === "list" ? e.items.flatMap(exprCols) : []);
  switch (node.k) {
    case "and":
    case "or":
      return node.parts.flatMap(nodeCols);
    case "not":
      return nodeCols(node.part);
    case "cmp":
      return [...exprCols(node.left), ...exprCols(node.right)];
    case "in":
      return [...exprCols(node.left), ...node.list.flatMap(exprCols)];
    case "between":
      return [...exprCols(node.left), ...exprCols(node.low), ...exprCols(node.high)];
    case "isnull":
      return exprCols(node.left);
    case "json":
      return [node.col];
    case "other":
      return node.cols;
  }
}

const FLIP: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "=": "=", "<>": "<>" };

/** A rule for one column from a condition that must hold, or null when it is not one Celer reads. */
function ruleOf(node: Node): { col: string; rule: ColumnRule } | null {
  if (node.k === "cmp") {
    let { left, right, op } = node;
    if (left.k === "lit" && right.k === "col") {
      [left, right] = [right, left];
      op = FLIP[op];
    }
    if (left.k !== "col" || right.k !== "lit") return null;
    if (op === "=") return { col: left.name, rule: { values: [right.value] } };
    if (!right.num) return null;
    const n = Number(right.value);
    if (op === ">=") return { col: left.name, rule: { min: n } };
    if (op === ">") return { col: left.name, rule: { min: n, minOpen: true } };
    if (op === "<=") return { col: left.name, rule: { max: n } };
    if (op === "<") return { col: left.name, rule: { max: n, maxOpen: true } };
    return null;
  }
  if (node.k === "json") return node.col ? { col: node.col, rule: { json: true } } : null;
  if (node.k === "in" && !node.not && node.left.k === "col" && node.list.every((e) => e.k === "lit" && e.value !== "NULL")) {
    return { col: node.left.name, rule: { values: node.list.map((e) => (e as { value: string }).value) } };
  }
  if (node.k === "between" && !node.not && node.left.k === "col" && node.low.k === "lit" && node.high.k === "lit" && node.low.num && node.high.num) {
    return { col: node.left.name, rule: { min: Number(node.low.value), max: Number(node.high.value) } };
  }
  if (node.k === "or") {
    // col = 'a' OR col = 'b' (SQL Server writes IN like this): the values together.
    const each = node.parts.map(ruleOf);
    if (each.every((r) => r && r.rule.values && r.col === each[0]!.col)) return { col: each[0]!.col, rule: { values: each.flatMap((r) => r!.rule.values!) } };
    return null;
  }
  return null;
}

function mergeRule(into: ColumnRule, add: ColumnRule) {
  if (add.json) into.json = true;
  if (add.values) into.values = into.values ? into.values.filter((v) => add.values!.includes(v)) : [...add.values];
  if (add.min !== undefined && (into.min === undefined || add.min > into.min || (add.min === into.min && add.minOpen))) {
    into.min = add.min;
    into.minOpen = add.minOpen;
  }
  if (add.max !== undefined && (into.max === undefined || add.max < into.max || (add.max === into.max && add.maxOpen))) {
    into.max = add.max;
    into.maxOpen = add.maxOpen;
  }
}

/**
 * What the CHECK constraints of a table say about its columns: value lists (IN, = ANY (ARRAY[…]), OR of equalities)
 * and ranges (BETWEEN, comparisons with a number), joined with AND. A condition read only in part lists its columns
 * in `unknown`; IS NOT NULL says nothing the generator does not already respect, json_valid() marks the column `json`.
 */
export function readChecks(checks: string[], columns: string[]): CheckReading {
  const rules: Record<string, ColumnRule> = {};
  const unknown = new Set<string>();
  for (const text of checks) {
    const node = parseCheck(text.replace(/^\s*check\s*/i, "").replace(/\s+not valid\s*$/i, ""), columns);
    const conjuncts = node.k === "and" ? node.parts : [node];
    for (const part of conjuncts) {
      if (part.k === "isnull") continue;
      const rule = ruleOf(part);
      if (rule) mergeRule((rules[rule.col] ??= {}), rule.rule);
      else for (const col of nodeCols(part)) unknown.add(col);
    }
  }
  return { rules, unknown: [...unknown].filter((col) => col) };
}
