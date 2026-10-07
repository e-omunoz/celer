import type { Cell, ColKind, ColumnInfo, ResultSet } from "./types";

export interface StmtSpan {
  sql: string;
  start: number;
  end: number;
}

export function splitSql(sql: string): StmtSpan[] {
  const out: StmtSpan[] = [];
  let start = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (quote) {
      if (c === quote) {
        if (n === quote) {
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "-" && n === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(sql.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === ";") {
      push(sql, start, i, out);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  push(sql, start, sql.length, out);
  return out;
}

function push(sql: string, start: number, end: number, out: StmtSpan[]) {
  const raw = sql.slice(start, end);
  if (raw.trim()) out.push({ sql: raw.trim(), start, end });
}

export function statementAt(sql: string, pos: number): string {
  const parts = splitSql(sql);
  if (!parts.length) return sql.trim();
  let chosen = parts[0];
  for (const part of parts) {
    if (pos < part.start) break;
    chosen = part;
    if (pos <= part.end) break;
  }
  return chosen.sql;
}

export function firstKeyword(sql: string): string {
  const m = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, "").match(/^([A-Za-z_]+)/);
  return (m?.[1] ?? "").toUpperCase();
}

export function isMutating(sql: string): boolean {
  return splitSql(sql).some((s) =>
    ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "REPLACE"].includes(
      firstKeyword(s.sql),
    ),
  );
}

export function needsProductionConfirm(sql: string): boolean {
  return splitSql(sql).some((s) => {
    const kw = firstKeyword(s.sql);
    if (kw === "DROP" || kw === "TRUNCATE" || kw === "ALTER") return true;
    if (kw === "DELETE" || kw === "UPDATE") return !/\bwhere\b/i.test(s.sql);
    return false;
  });
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

export function formatSql(sql: string): string {
  const lines = splitSql(sql).map((part) => formatOne(part.sql));
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
    out.push(" ");
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

export function sqlLiteral(value: string | null, kind: ColKind): string {
  if (value === null) return "NULL";
  if (kind === "number" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())) return value.trim();
  if (kind === "bool") {
    if (/^(1|true)$/i.test(value.trim())) return "1";
    if (/^(0|false)$/i.test(value.trim())) return "0";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function csvEscape(value: string, delimiter: string): string {
  if (/["\n\r]/.test(value) || value.includes(delimiter)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function resultToText(result: ResultSet, format: "csv" | "tsv" | "json" | "sql", table = "resultado"): string {
  const delimiter = format === "tsv" ? "\t" : ";";
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
