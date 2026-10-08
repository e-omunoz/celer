// Live templates for the SQL editor, query parameters (:name, ?, ${name}) and the "no WHERE" check.
// Pure functions: the editor and the run path use them; dev/snippets-check.ts tests them.
import { codeOnly, firstKeyword, splitSql } from "./sql.ts";
import type { DbKind, Snippet } from "./types";

export type { Snippet };

// A Snippet's body is a CodeMirror template: ${name} is a field (Tab jumps to the next one; fields with the same
// name are edited together), ${} an empty field, ${0} where the caret ends. Its name is what you type (sel, ins…).

/** Row limit written the way each engine does it. */
function limited(kind: DbKind | undefined): string {
  if (kind === "mssql") return "SELECT TOP ${100} *\nFROM ${tabla};";
  if (kind === "informix") return "SELECT FIRST ${100} *\nFROM ${tabla};";
  return "SELECT *\nFROM ${tabla}\nLIMIT ${100};";
}

export function builtinSnippets(kind: DbKind | undefined): Snippet[] {
  return [
    { name: "sel", description: "SELECT … FROM", body: "SELECT ${*}\nFROM ${tabla};" },
    { name: "selw", description: "SELECT … FROM … WHERE", body: "SELECT ${*}\nFROM ${tabla}\nWHERE ${condición};" },
    { name: "top", description: "Primeras filas de una tabla", body: limited(kind) },
    { name: "cnt", description: "Contar filas", body: "SELECT count(*)\nFROM ${tabla}\nWHERE ${condición};" },
    { name: "grp", description: "Agrupar y contar", body: "SELECT ${columna}, count(*) AS total\nFROM ${tabla}\nGROUP BY ${columna}\nORDER BY total DESC;" },
    { name: "dist", description: "Valores distintos de una columna", body: "SELECT DISTINCT ${columna}\nFROM ${tabla}\nORDER BY ${columna};" },
    { name: "dup", description: "Buscar duplicados", body: "SELECT ${columna}, count(*) AS veces\nFROM ${tabla}\nGROUP BY ${columna}\nHAVING count(*) > 1\nORDER BY veces DESC;" },
    { name: "join", description: "JOIN … ON", body: "JOIN ${tabla} ${t} ON ${t}.${id} = ${}" },
    { name: "lj", description: "LEFT JOIN … ON", body: "LEFT JOIN ${tabla} ${t} ON ${t}.${id} = ${}" },
    { name: "ins", description: "INSERT INTO … VALUES", body: "INSERT INTO ${tabla} (${columnas})\nVALUES (${valores});" },
    { name: "upd", description: "UPDATE … SET … WHERE", body: "UPDATE ${tabla}\nSET ${columna} = ${valor}\nWHERE ${condición};" },
    { name: "del", description: "DELETE … WHERE", body: "DELETE FROM ${tabla}\nWHERE ${condición};" },
    { name: "cte", description: "WITH … AS (…)", body: "WITH ${nombre} AS (\n\tSELECT ${}\n)\nSELECT *\nFROM ${nombre};" },
    { name: "case", description: "CASE WHEN … END", body: "CASE\n\tWHEN ${condición} THEN ${valor}\n\tELSE ${otro}\nEND" },
    { name: "exists", description: "WHERE EXISTS (subconsulta)", body: "WHERE EXISTS (\n\tSELECT 1\n\tFROM ${tabla} ${t}\n\tWHERE ${t}.${id} = ${}\n)" },
    { name: "tx", description: "Transacción", body: kind === "mssql" ? "BEGIN TRANSACTION;\n${}\nCOMMIT;" : "BEGIN;\n${}\nCOMMIT;" },
  ];
}

/** Built-in templates plus the user's (a user template with the same name replaces the built-in one). */
export function allSnippets(kind: DbKind | undefined, user: Snippet[]): Snippet[] {
  const own = user.filter((s) => s.name.trim() && s.body.trim());
  const names = new Set(own.map((s) => s.name.trim().toLowerCase()));
  return [...own, ...builtinSnippets(kind).filter((s) => !names.has(s.name))];
}

// ---------------------------------------------------------------- query parameters

export interface ParamRef {
  /** "nombre" for :nombre and ${nombre}; "?1", "?2"… for positional ones. */
  name: string;
  from: number;
  to: number;
}

/**
 * Parameters in a SQL text, outside strings, quoted identifiers and comments:
 * - `:name` (not `::type` casts, not `db:table` in Informix, not `:=`),
 * - `${name}`,
 * - `?` on engines where it is not an operator (PostgreSQL uses ? for jsonb).
 */
export function findParams(sql: string, dialect?: string): ParamRef[] {
  const code = codeOnly(sql, dialect);
  const out: ParamRef[] = [];
  const named = /\$\{([A-Za-z_][\w]*)\}|:([A-Za-z_][\w]*)/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(code))) {
    if (m[2] !== undefined) {
      const before = code[m.index - 1] ?? " ";
      // "::int" (cast), "db:table" (Informix), "a[1:n]" (slice) and labels are not parameters.
      if (before === ":" || /[\w\]\)"`]/.test(before)) continue;
      if (code[m.index + m[0].length] === "=") continue;
    }
    out.push({ name: m[1] ?? m[2], from: m.index, to: m.index + m[0].length });
  }
  if (dialect !== "postgres") {
    let n = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === "?") out.push({ name: `?${++n}`, from: i, to: i + 1 });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Distinct parameter names, in order of appearance. */
export function paramNames(refs: ParamRef[]): string[] {
  return [...new Set(refs.map((r) => r.name))];
}

/**
 * The SQL value to write for what the user typed: numbers, NULL, TRUE/FALSE and anything marked as raw SQL go
 * in as they are; everything else becomes a quoted string.
 */
export function paramLiteral(value: string, raw: boolean, dialect?: string): string {
  const v = value.trim();
  if (raw) return value;
  if (/^-?\d+(\.\d+)?$/.test(v) || /^(null|true|false)$/i.test(v)) return v;
  const escaped = dialect === "mysql" ? value.replace(/\\/g, "\\\\").replace(/'/g, "''") : value.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** Replaces every parameter with its literal (from the end, so offsets stay valid). */
export function bindParams(sql: string, refs: ParamRef[], values: Record<string, string>, raw: Record<string, boolean>, dialect?: string): string {
  let out = sql;
  for (const ref of [...refs].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, ref.from) + paramLiteral(values[ref.name] ?? "", Boolean(raw[ref.name]), dialect) + out.slice(ref.to);
  }
  return out;
}

// ---------------------------------------------------------------- writes without WHERE

export interface UnfilteredWrite {
  /** "DELETE" or "UPDATE". */
  keyword: string;
  /** Offset of the keyword in the whole text. */
  from: number;
  to: number;
}

/** DELETE and UPDATE statements without a WHERE (they touch every row). */
export function unfilteredWrites(sql: string, dialect?: string): UnfilteredWrite[] {
  const out: UnfilteredWrite[] = [];
  for (const part of splitSql(sql, dialect)) {
    const kw = firstKeyword(part.sql);
    if (kw !== "DELETE" && kw !== "UPDATE") continue;
    const code = codeOnly(part.sql, dialect);
    if (/\bwhere\b/i.test(code)) continue;
    // MySQL/SQLite "DELETE … LIMIT n" and SQL Server "DELETE TOP (n)" are bounded on purpose.
    if (/\blimit\s+\d+/i.test(code) || /^\s*(delete|update)\s+top\s*\(/i.test(code)) continue;
    // Where the keyword is in the text (comments before it are blanked out, so they cannot match).
    const at = part.start + Math.max(0, codeOnly(sql.slice(part.start, part.end), dialect).search(new RegExp(`\\b${kw}\\b`, "i")));
    out.push({ keyword: kw, from: at, to: at + kw.length });
  }
  return out;
}

/** True when the SQL has a DELETE or UPDATE without WHERE. */
export function hasUnfilteredWrite(sql: string, dialect?: string): boolean {
  return unfilteredWrites(sql, dialect).length > 0;
}
