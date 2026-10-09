// Live templates for the SQL editor, query parameters (:name, ?, ${name}) and the "no WHERE" check.
// Pure functions: the editor and the run path use them; dev/snippets-check.ts tests them.
import { analyzedStatement, codeOnly, firstKeyword, splitSql } from "./sql.ts";
import type { DbKind, Snippet } from "./types";

export type { Snippet };

// A Snippet's body is a CodeMirror template: ${name} is a field (Tab jumps to the next one; fields with the same
// name are edited together), ${} an empty field, ${0} where the caret ends. Its name is what you type (sel, ins…).
// Built-in names are never SQL keywords (case, join…): Enter after a keyword must stay a keyword.

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
    { name: "lim", description: "Primeras filas de una tabla", body: limited(kind) },
    { name: "cnt", description: "Contar filas", body: "SELECT count(*)\nFROM ${tabla}\nWHERE ${condición};" },
    { name: "grp", description: "Agrupar y contar", body: "SELECT ${columna}, count(*) AS total\nFROM ${tabla}\nGROUP BY ${columna}\nORDER BY total DESC;" },
    { name: "dist", description: "Valores distintos de una columna", body: "SELECT DISTINCT ${columna}\nFROM ${tabla}\nORDER BY ${columna};" },
    { name: "dup", description: "Buscar duplicados", body: "SELECT ${columna}, count(*) AS veces\nFROM ${tabla}\nGROUP BY ${columna}\nHAVING count(*) > 1\nORDER BY veces DESC;" },
    { name: "jn", description: "JOIN … ON", body: "JOIN ${tabla} ${t} ON ${t}.${id} = ${}" },
    { name: "lj", description: "LEFT JOIN … ON", body: "LEFT JOIN ${tabla} ${t} ON ${t}.${id} = ${}" },
    { name: "ins", description: "INSERT INTO … VALUES", body: "INSERT INTO ${tabla} (${columnas})\nVALUES (${valores});" },
    { name: "upd", description: "UPDATE … SET … WHERE", body: "UPDATE ${tabla}\nSET ${columna} = ${valor}\nWHERE ${condición};" },
    { name: "del", description: "DELETE … WHERE", body: "DELETE FROM ${tabla}\nWHERE ${condición};" },
    { name: "cte", description: "WITH … AS (…)", body: "WITH ${nombre} AS (\n\tSELECT ${}\n)\nSELECT *\nFROM ${nombre};" },
    { name: "cw", description: "CASE WHEN … END", body: "CASE\n\tWHEN ${condición} THEN ${valor}\n\tELSE ${otro}\nEND" },
    { name: "ex", description: "WHERE EXISTS (subconsulta)", body: "WHERE EXISTS (\n\tSELECT 1\n\tFROM ${tabla} ${t}\n\tWHERE ${t}.${id} = ${}\n)" },
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
  /** "nombre" for :nombre, ${nombre} (and SQLite's $nombre / @nombre); "?1", "?2"… for positional ones. */
  name: string;
  from: number;
  to: number;
}

/**
 * Parameters in a SQL text, outside strings, quoted identifiers and comments:
 * - `:name` (not `::type` casts, not `db:table` in Informix, not `a[1:n]` slices),
 * - `${name}`, and on SQLite also `$name` and `@name`,
 * - `?` and `?NNN` on engines where ? is not an operator (PostgreSQL uses it for jsonb). A plain `?` takes the
 *   number after the highest one so far, like SQLite does, so `?2 … ?` is `?2` then `?3`.
 */
export function findParams(sql: string, dialect?: string): ParamRef[] {
  const code = codeOnly(sql, dialect);
  const out: ParamRef[] = [];
  const named = dialect === "sqlite" ? /\$\{([A-Za-z_]\w*)\}|:([A-Za-z_]\w*)|[$@]([A-Za-z_]\w*)/g : /\$\{([A-Za-z_]\w*)\}|:([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(code))) {
    if (m[2] !== undefined || m[3] !== undefined) {
      const before = code[m.index - 1] ?? " ";
      // "::int" (cast), "db:table" (Informix), "a[1:n]" (slice) are not parameters.
      if (before === ":" || /[\w\]\)"`$@]/.test(before)) continue;
    }
    out.push({ name: m[1] ?? m[2] ?? m[3], from: m.index, to: m.index + m[0].length });
  }
  if (dialect !== "postgres") {
    let highest = 0;
    const positional = /\?(\d+)?/g;
    while ((m = positional.exec(code))) {
      const n = m[1] ? Number(m[1]) : highest + 1;
      highest = Math.max(highest, n);
      out.push({ name: `?${n}`, from: m.index, to: m.index + m[0].length });
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
 * in as they are; everything else becomes a quoted string. Digits with leading zeros (a postcode, "007") are
 * text, not numbers.
 */
export function paramLiteral(value: string, raw: boolean, dialect?: string): string {
  const v = value.trim();
  if (raw) return value;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) || /^(null|true|false)$/i.test(v)) return v;
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

/** The code with everything inside parentheses blanked out: what is left is the statement's own clauses. */
function topLevel(code: string): string {
  let depth = 0;
  let out = "";
  for (const c of code) {
    if (c === "(") depth++;
    out += depth > 0 ? " " : c;
    if (c === ")") depth = Math.max(0, depth - 1);
  }
  return out;
}

/**
 * DELETE and UPDATE statements without a WHERE of their own (they touch every row). A WHERE or LIMIT inside
 * a subquery does not count; WITH … DELETE/UPDATE is checked too. Not flagged: bounded writes (LIMIT n,
 * TOP (n)), writes restricted by a JOIN … ON (MySQL / SQL Server) and UPDATE STATISTICS.
 */
export function unfilteredWrites(sql: string, dialect?: string): UnfilteredWrite[] {
  const out: UnfilteredWrite[] = [];
  for (const part of splitSql(sql, dialect)) {
    const code = codeOnly(part.sql, dialect);
    let top = topLevel(code);
    let kw = firstKeyword(part.sql, dialect);
    // EXPLAIN ANALYZE DELETE … runs the DELETE.
    const explained = analyzedStatement(kw, code);
    if (explained) {
      kw = explained.kw;
      top = top.slice(code.length - explained.code.length);
    }
    if (kw === "WITH") {
      // PostgreSQL: WITH d AS (DELETE FROM t RETURNING *) SELECT … deletes too.
      for (const write of cteWrites(codeOnly(sql.slice(part.start, part.end), dialect))) out.push({ keyword: write.keyword, from: part.start + write.at, to: part.start + write.at + write.keyword.length });
      // The main statement after the CTEs (their bodies are blanked out): its first keyword decides. A SELECT …
      // FOR UPDATE or an INSERT … ON CONFLICT DO UPDATE is not a DELETE/UPDATE.
      const main = /\b(select|insert|update|delete|merge|values|table)\b/i.exec(top);
      if (!main || !/^(delete|update)$/i.test(main[1])) continue;
      kw = main[1].toUpperCase();
      top = top.slice(main.index);
    } else if (kw !== "DELETE" && kw !== "UPDATE") continue;
    if (/^\s*update\s+statistics\b/i.test(top)) continue;
    if (/\bwhere\b/i.test(top)) continue;
    if (/\blimit\s+\d+/i.test(top) || /^\s*(delete|update)\s+top\s*\(/i.test(code.slice(code.search(/\b(delete|update)\b/i)))) continue;
    if ((dialect === "mysql" || dialect === "mssql") && /\bjoin\b[\s\S]*\bon\b/i.test(top)) continue;
    // Where the keyword is in the text (comments before it are blanked out, so they cannot match).
    const at = part.start + Math.max(0, topLevel(codeOnly(sql.slice(part.start, part.end), dialect)).search(new RegExp(`\\b${kw}\\b`, "i")));
    out.push({ keyword: kw, from: at, to: at + kw.length });
  }
  return out;
}

/** DELETE / UPDATE CTE bodies (`name AS [NOT] [MATERIALIZED] ( … )` at the top level) without WHERE or LIMIT. */
function cteWrites(code: string): { keyword: string; at: number }[] {
  const out: { keyword: string; at: number }[] = [];
  const re = /\bas\s+(?:not\s+)?(?:materialized\s+)?\(/gi;
  let depth = 0;
  let scanned = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    for (; scanned < m.index; scanned++) depth += code[scanned] === "(" ? 1 : code[scanned] === ")" ? -1 : 0;
    if (depth !== 0) continue;
    const open = m.index + m[0].length - 1;
    let close = code.length;
    for (let i = open, d = 0; i < code.length; i++) {
      if (code[i] === "(") d++;
      else if (code[i] === ")" && --d === 0) {
        close = i;
        break;
      }
    }
    const body = topLevel(code.slice(open + 1, close));
    const kw = /^\s*(delete|update)\b/i.exec(body);
    if (kw && !/\bwhere\b/i.test(body) && !/\blimit\s+\d+/i.test(body)) out.push({ keyword: kw[1].toUpperCase(), at: open + 1 + body.search(/\S/) });
    re.lastIndex = close;
    scanned = close + 1;
  }
  return out;
}

/** True when the SQL has a DELETE or UPDATE without WHERE. */
export function hasUnfilteredWrite(sql: string, dialect?: string): boolean {
  return unfilteredWrites(sql, dialect).length > 0;
}