import type { Cell, ColKind, ColumnInfo, ResultSet } from "./types";

export interface StmtSpan {
  sql: string;
  start: number;
  end: number;
}

/**
 * Walks SQL text and reports, for every position, whether it is code. Strings ('…', E'…'), quoted identifiers
 * ("…", `…`, [..] on SQL Server), PostgreSQL dollar quotes ($$…$$, $tag$…$tag$), and line and block comments
 * are skipped. MySQL treats backslash as an escape inside strings; other engines do not.
 */
function scan(sql: string, dialect: string | undefined, onCode: (index: number, char: string) => boolean | void) {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && dialect === "mysql") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === "$" && dialect !== "mysql" && dialect !== "mssql") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag && !/[\w$]/.test(sql[i - 1] ?? " ")) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    const closing = c === "'" || c === '"' || c === "`" ? c : c === "[" && dialect === "mssql" ? "]" : null;
    if (closing) {
      i++;
      while (i < n) {
        if (dialect === "mysql" && sql[i] === "\\" && closing !== "`") {
          i += 2;
          continue;
        }
        if (sql[i] === closing) {
          if (sql[i + 1] === closing) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (onCode(i, c) === false) return;
    i++;
  }
}

export function splitSql(sql: string, dialect?: string): StmtSpan[] {
  const out: StmtSpan[] = [];
  let start = 0;
  scan(sql, dialect, (index, char) => {
    if (char === ";") {
      push(sql, start, index, out);
      start = index + 1;
    }
  });
  push(sql, start, sql.length, out);
  return out;
}

/** The SQL with strings, quoted identifiers and comments blanked out (same length). */
export function codeOnly(sql: string, dialect?: string): string {
  const chars = new Array<string>(sql.length).fill(" ");
  scan(sql, dialect, (index, char) => {
    chars[index] = char;
  });
  return chars.join("");
}

function push(sql: string, start: number, end: number, out: StmtSpan[]) {
  const raw = sql.slice(start, end);
  if (raw.trim()) out.push({ sql: raw.trim(), start, end });
}

/** The statement under the cursor; a cursor right after a ";" belongs to the statement it ends. */
export function statementAt(sql: string, pos: number, dialect?: string): string {
  const parts = splitSql(sql, dialect);
  if (!parts.length) return sql.trim();
  let chosen = parts[0];
  for (const part of parts) {
    if (pos < part.start) break;
    chosen = part;
    if (pos <= part.end + 1) break;
  }
  return chosen.sql;
}

export function firstKeyword(sql: string): string {
  const m = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s|\()*/, "").match(/^([A-Za-z_]+)/);
  return (m?.[1] ?? "").toUpperCase();
}

const MUTATING = ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "REPLACE", "UPSERT", "RENAME", "CALL", "EXEC", "EXECUTE"];

export function isMutating(sql: string, dialect?: string): boolean {
  return splitSql(sql, dialect).some((s) => {
    const kw = firstKeyword(s.sql);
    if (MUTATING.includes(kw)) return true;
    // WITH x AS (DELETE … RETURNING …) SELECT … also writes.
    return kw === "WITH" && /\b(insert|update|delete|merge)\b/i.test(codeOnly(s.sql, dialect));
  });
}

/** Statements that deserve a confirmation on production connections. */
export function needsProductionConfirm(sql: string, dialect?: string): boolean {
  return splitSql(sql, dialect).some((s) => {
    const code = codeOnly(s.sql, dialect);
    const kw = firstKeyword(s.sql);
    if (kw === "DROP" || kw === "TRUNCATE" || kw === "ALTER" || kw === "MERGE") return true;
    if (kw === "DELETE" || kw === "UPDATE") return !/\bwhere\b/i.test(code);
    if (kw === "WITH") return /\b(delete|update)\b/i.test(code) && !/\bwhere\b/i.test(code);
    return false;
  });
}

/** Quotes an identifier the way the engine expects. */
export function quoteIdentFor(name: string, dialect?: string): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}
const BREAK_BEFORE = [
  "UNION ALL",
  "UNION",
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "DELETE FROM",
  "LEFT OUTER JOIN",
  "RIGHT OUTER JOIN",
  "FULL OUTER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "CROSS JOIN",
  "JOIN",
  "SET",
  "ON",
];

export function formatSql(sql: string, dialect?: string): string {
  const lines = splitSql(sql, dialect).map((part) => formatOne(part.sql));
  return lines.join(";\n\n") + (sql.trim().endsWith(";") ? ";" : "");
}

function formatOne(sql: string): string {
  const tokens = tokenize(sql);
  const keywords = new Set(BREAK_BEFORE.flatMap((k) => k.split(" ")));
  let depth = 0;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "(") depth++;
    if (t === ")") depth = Math.max(0, depth - 1);
    const upper = t.toUpperCase();
    const two = `${upper} ${tokens[i + 1]?.toUpperCase() ?? ""}`;
    const three = `${two} ${tokens[i + 2]?.toUpperCase() ?? ""}`;
    const br = depth === 0 && (BREAK_BEFORE.includes(three) || BREAK_BEFORE.includes(two) || (keywords.has(upper) && BREAK_BEFORE.includes(upper)));
    if (br && out.length) out.push("\n");
    if (keywords.has(upper) && /^[A-Za-z_]+$/.test(t)) out.push(upper);
    else out.push(t);
    // A line comment runs to the end of the line: whatever follows must start on a new one.
    out.push(t.startsWith("--") ? "\n" : " ");
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ +\(/g, " (").trim();
}

function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      tokens.push(sql.slice(i, end === -1 ? sql.length : end));
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      tokens.push(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        tokens.push(sql.slice(i, stop));
        i = stop;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          j++;
          break;
        }
        j++;
      }
      tokens.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (/[(),;.*]/.test(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < sql.length && !/[\s(),;]/.test(sql[j])) j++;
    tokens.push(sql.slice(i, j));
    i = j;
  }
  return tokens;
}

export function cellText(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function isNullCell(value: Cell): boolean {
  return value === null || value === undefined;
}

export function sqlLiteral(value: string | null, kind: ColKind, dialect?: string): string {
  if (value === null) return "NULL";
  if (kind === "number" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())) return value.trim();
  if (kind === "bool") {
    // SQL Server bit columns take 1/0; PostgreSQL rejects 1/0 for boolean; MySQL and SQLite accept TRUE/FALSE.
    const numeric = dialect === "mssql" || dialect === "informix" || dialect === "odbc";
    if (/^(1|true|t|yes|y|✓ true)$/i.test(value.trim())) return numeric ? "1" : "TRUE";
    if (/^(0|false|f|no|n|✗ false)$/i.test(value.trim())) return numeric ? "0" : "FALSE";
  }
  const escaped = dialect === "mysql" ? value.replace(/\\/g, "\\\\").replace(/'/g, "''") : value.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function csvEscape(value: string, delimiter: string): string {
  if (/["\n\r]/.test(value) || value.includes(delimiter)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function resultToText(result: ResultSet, format: "csv" | "tsv" | "json" | "sql" | "markdown" | "html", table = "resultado", delimiterOverride?: string): string {
  const delimiter = format === "tsv" ? "\t" : delimiterOverride ?? ",";
  if (format === "markdown") {
    const esc = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    return [
      `| ${result.columns.map((c) => esc(c.name)).join(" | ")} |`,
      `| ${result.columns.map((c) => (c.kind === "number" ? "---:" : "---")).join(" | ")} |`,
      ...result.rows.map((row) => `| ${row.map((cell) => (isNullCell(cell) ? "NULL" : esc(cellText(cell)))).join(" | ")} |`),
    ].join("\n");
  }
  if (format === "html") {
    const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const head = result.columns.map((c) => `<th>${esc(c.name)}</th>`).join("");
    const body = result.rows.map((row) => `<tr>${row.map((cell) => `<td>${isNullCell(cell) ? "<i>NULL</i>" : esc(cellText(cell))}</td>`).join("")}</tr>`).join("\n");
    return `<!doctype html><meta charset="utf-8"><table border="1" cellpadding="4"><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
  }
  if (format === "json") {
    const objects = result.rows.map((row) => {
      const o: Record<string, Cell> = {};
      result.columns.forEach((col, i) => {
        o[col.name] = row[i] ?? null;
      });
      return o;
    });
    return JSON.stringify(objects, null, 2);
  }
  if (format === "sql") {
    const cols = result.columns.map((c) => quoteIdent(c.name)).join(", ");
    return result.rows
      .map((row) => {
        const vals = row.map((cell, i) => sqlLiteral(isNullCell(cell) ? null : cellText(cell), result.columns[i]?.kind ?? "text"));
        return `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${vals.join(", ")});`;
      })
      .join("\n");
  }
  const head = result.columns.map((c) => csvEscape(c.name, delimiter)).join(delimiter);
  const body = result.rows
    .map((row) => row.map((cell) => csvEscape(isNullCell(cell) ? "" : cellText(cell), delimiter)).join(delimiter))
    .join("\n");
  return `${head}\n${body}`;
}

export function selectionText(
  columns: ColumnInfo[],
  rows: Cell[][],
  rect: { r1: number; c1: number; r2: number; c2: number },
  format: "tsv" | "csv" | "sql",
): string {
  const r1 = Math.min(rect.r1, rect.r2);
  const r2 = Math.max(rect.r1, rect.r2);
  const c1 = Math.min(rect.c1, rect.c2);
  const c2 = Math.max(rect.c1, rect.c2);
  const slice: ResultSet = {
    columns: columns.slice(c1, c2 + 1),
    rows: rows.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1)),
    hasMore: false,
    rowsAffected: null,
  };
  return resultToText(slice, format === "tsv" ? "tsv" : format === "csv" ? "csv" : "sql");
}

export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
