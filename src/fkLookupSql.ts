// The SQL of a foreign-key lookup (fkLookup.ts). Pure, so dev/fklookup-check.ts tests it.
import { sqlLiteral } from "./sql.ts";
import type { DbKind, TableColumn } from "./types";

export const LOOKUP_ROWS = 50;

/** Columns that name a row, best first: a name or title, then something with "name" in it, then a code, an e-mail. */
const LABEL_TIERS = [
  /^(name|nombre|title|t[ií]tulo|label|etiqueta|display_?name|full_?name|nombre_?completo|raz[oó]n_?social|descripci[oó]n|description)$/i,
  /name|nombre|t[ií]tulo|title/i,
  /^(code|c[oó]digo|sku|ref|referencia)$/i,
  /email|e_?mail|correo|username|usuario|login/i,
];

/** The column that tells the referenced rows apart for a person (a name-like text column, else the first text one). */
export function pickLabelColumn(columns: Pick<TableColumn, "name" | "kind">[], key: string): string | null {
  const text = columns.filter((c) => c.name !== key && c.kind === "text");
  for (const tier of LABEL_TIERS) {
    const hit = text.find((c) => tier.test(c.name));
    if (hit) return hit.name;
  }
  return text[0]?.name ?? null;
}

/**
 * The SELECT for a search: key and label of up to `rows` rows whose key or label contains `text` (any case,
 * taken literally: % and _ are not wildcards), ordered by the label. `key` and `label` come quoted, `table`
 * qualified. The label is compared as text, so long-text types (SQL Server ntext, Informix TEXT) work too.
 */
export function lookupSql(kind: DbKind, table: string, key: string, label: string | null, text: string, rows = LOOKUP_ROWS): string {
  const asText = (expr: string) => {
    if (kind === "postgres") return `${expr}::text`;
    if (kind === "mysql") return `CAST(${expr} AS CHAR)`;
    if (kind === "mssql") return `CAST(${expr} AS NVARCHAR(4000))`;
    if (kind === "sqlite") return `CAST(${expr} AS TEXT)`;
    return `CAST(${expr} AS VARCHAR(255))`;
  };
  const top = kind === "mssql" ? `TOP ${rows} ` : kind === "informix" ? `FIRST ${rows} ` : "";
  const limit = kind === "postgres" || kind === "mysql" || kind === "sqlite" ? ` LIMIT ${rows}` : "";
  const cols = label ? `${key}, ${label}` : key;
  const needle = text.trim().toLowerCase().replace(kind === "mssql" ? /[!%_[]/g : /[!%_]/g, "!$&");
  const like = `LIKE ${sqlLiteral(`%${needle}%`, "text", kind)} ESCAPE '!'`;
  const where = needle ? ` WHERE LOWER(${asText(key)}) ${like}${label ? ` OR LOWER(${asText(label)}) ${like}` : ""}` : "";
  // Long-text labels cannot be sorted as they are on SQL Server and Informix.
  const order = label && (kind === "mssql" || kind === "informix" || kind === "odbc") ? asText(label) : (label ?? key);
  return `SELECT ${top}${cols} FROM ${table}${where} ORDER BY ${order}${limit}`;
}
