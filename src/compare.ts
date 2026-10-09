// Comparing two results (a pinned one and the current one, two consoles, two connections, two tables): rows matched
// by a key, then classified as equal, changed (which cells), only in the first result (gone) or only in the second
// (new). Values are compared by what they mean for the column's kind, so the same data read from two engines
// (12.50 / 12.5, 1 / true, 2024-03-15T00:00:00 / 2024-03-15) is equal. Pure: dev/compare-check.ts.
import type { Cell, ColKind, ColumnInfo, ResultSet } from "./types";

export interface Comparison {
  /** Columns of the new result (the comparison is shown with them). */
  columns: ColumnInfo[];
  /** Rows to show: equal and changed rows first (new values), then the gone ones, then the new ones. */
  rows: Cell[][];
  /** Changed cells, as `row:col` → the old value (the grid marks them as edited). */
  changed: Record<string, string | null>;
  /** Indexes in `rows` of the rows only in the old result. */
  gone: number[];
  /** Index in `rows` where the rows only in the new result start. */
  newFrom: number;
  counts: { equal: number; changed: number; gone: number; added: number };
  /** Key columns used (names), or [] when whole rows are compared. */
  key: string[];
  /** Columns only in one of the two results (they are not compared). */
  onlyOld: string[];
  onlyNew: string[];
}

const NULL_KEY = "\u0000NULL";

/** A number written in plain decimal without what does not change its value (sign, leading and trailing zeros). */
export function canonicalNumber(cell: Cell): string | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell === 0 ? 0 : cell) : String(cell);
  if (typeof cell !== "string") return null;
  const text = cell.trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) {
    // Exponent notation (1.5E3): through a JavaScript number.
    if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(text)) return String(Number(text));
    return null;
  }
  const int = match[2].replace(/^0+(?=\d)/, "") || "0";
  const frac = (match[3] ?? "").replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return match[1] === "-" && body !== "0" ? `-${body}` : body;
}

/** true / false from the ways engines write a boolean (t, 1, yes…), or null when it is not one. */
export function canonicalBool(cell: Cell): string | null {
  if (typeof cell === "boolean") return String(cell);
  const text = String(cell).trim().toLowerCase();
  if (/^(true|t|1|yes|y|s|sí|si|on)$/.test(text)) return "true";
  if (/^(false|f|0|no|n|off)$/.test(text)) return "false";
  return null;
}

/** A date or timestamp without the parts that differ only in how an engine writes it ("T", .000, a midnight time). */
export function canonicalDate(cell: Cell): string {
  let text = String(cell).trim().replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ");
  text = text.replace(/(\d{2}:\d{2}:\d{2})\.0+(?=$|[ Z+-])/, "$1");
  text = text.replace(/(\d{2}:\d{2}:\d{2}\.\d*?)0+(?=$|[ Z+-])/, "$1");
  text = text.replace(/^(\d{4}-\d{2}-\d{2}) 00:00:00$/, "$1");
  return text;
}

/** The kind two columns are compared as: what either says beyond text (a number in one engine is text in no other). */
function sharedKind(a: ColKind | undefined, b: ColKind | undefined): ColKind | undefined {
  for (const kind of ["bool", "number", "date"] as const) if (a === kind || b === kind) return kind;
  return a ?? b;
}

/** A cell as it is compared for a column of `kind`: equal texts mean equal values. */
export function compareText(cell: Cell, kind?: ColKind): string {
  if (cell === null || cell === undefined) return NULL_KEY;
  if (kind === "bool" || typeof cell === "boolean") {
    const b = canonicalBool(cell);
    if (b !== null) return b;
  }
  if (kind === "number" || typeof cell === "number") {
    const n = canonicalNumber(cell);
    if (n !== null) return n;
  }
  if (kind === "date") return canonicalDate(cell);
  return String(cell);
}

/** The column called `name`, or one called the same in another case (id / Id between engines). */
export function columnIndex(columns: { name: string }[], name: string): number {
  const exact = columns.findIndex((c) => c.name === name);
  return exact >= 0 ? exact : columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}

/** Whether `key` (column names) identifies each row of `r` (no repeated values, nulls included). */
export function keyIsUnique(r: ResultSet, key: string[]): boolean {
  const idx = key.map((k) => columnIndex(r.columns, k));
  if (!idx.length || idx.some((i) => i < 0)) return false;
  const seen = new Set<string>();
  for (const row of r.rows) {
    const k = idx.map((i) => compareText(row[i], r.columns[i]?.kind)).join("\u0001");
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** Whether every column of `key` is in both results (a primary key taken as the comparison's key). */
export function keyFits(a: ResultSet, b: ResultSet, key: string[]): boolean {
  return key.length > 0 && key.every((name) => columnIndex(a.columns, name) >= 0 && columnIndex(b.columns, name) >= 0);
}

/** The first column whose values are unique and not null in both results, as a natural key. */
export function guessKey(a: ResultSet, b: ResultSet): string[] {
  const shared = a.columns.map((c) => c.name).filter((name) => columnIndex(b.columns, name) >= 0);
  for (const name of shared) {
    const unique = (r: ResultSet) => {
      const i = columnIndex(r.columns, name);
      const kind = r.columns[i]?.kind;
      const seen = new Set<string>();
      for (const row of r.rows) {
        const v = row[i];
        if (v === null || v === undefined) return false;
        const k = compareText(v, kind);
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    };
    if (unique(a) && unique(b)) return [name];
  }
  return [];
}

/**
 * Compares `before` with `after` on the columns they share, matching rows by `key` (column names; empty: whole
 * rows, so a changed row shows as gone + new).
 */
export function compareResults(before: ResultSet, after: ResultSet, key: string[] = guessKey(before, after)): Comparison {
  const names = after.columns.map((c) => c.name);
  const posA = new Map<string, number>();
  const posB = new Map<string, number>();
  for (const name of names) {
    posA.set(name, columnIndex(before.columns, name));
    posB.set(name, columnIndex(after.columns, name));
  }
  const shared = names.filter((name) => posA.get(name)! >= 0);
  // Key names as the new result writes them.
  const usedKey = key.map((k) => shared.find((s) => s === k) ?? shared.find((s) => s.toLowerCase() === k.toLowerCase())).filter((k): k is string => Boolean(k));
  const keyCols = usedKey.length ? usedKey : shared;
  // Each shared column once: where it is on each side and the kind its values are compared as.
  const cols = shared.map((name) => {
    const ia = posA.get(name)!;
    const ib = posB.get(name)!;
    return { ia, ib, kind: sharedKind(before.columns[ia]?.kind, after.columns[ib]?.kind) };
  });
  const keyIdx = keyCols.map((name) => cols[shared.indexOf(name)]);
  const keyOf = (row: Cell[], side: "a" | "b") => keyIdx.map((c) => compareText(row[side === "a" ? c.ia : c.ib], c.kind)).join("\u0001");

  // Old rows by key (a list: duplicates are matched in order).
  const old = new Map<string, Cell[][]>();
  for (const row of before.rows) {
    const k = keyOf(row, "a");
    const list = old.get(k);
    if (list) list.push(row);
    else old.set(k, [row]);
  }
  const rows: Cell[][] = [];
  const changed: Record<string, string | null> = {};
  const added: Cell[][] = [];
  let equal = 0;
  let changedRows = 0;
  for (const row of after.rows) {
    const k = keyOf(row, "b");
    const match = old.get(k)?.shift();
    if (!match) {
      added.push(row);
      continue;
    }
    const at = rows.length;
    let differs = false;
    for (const c of cols) {
      if (compareText(match[c.ia], c.kind) !== compareText(row[c.ib], c.kind)) {
        differs = true;
        changed[`${at}:${c.ib}`] = match[c.ia] === null || match[c.ia] === undefined ? null : String(match[c.ia]);
      }
    }
    if (differs) changedRows++;
    else equal++;
    rows.push(row);
  }
  // Gone rows, laid out with the new result's columns (missing ones empty).
  const gone: number[] = [];
  for (const list of old.values()) {
    for (const row of list) {
      gone.push(rows.length);
      rows.push(names.map((name) => (posA.get(name)! >= 0 ? row[posA.get(name)!] : null)));
    }
  }
  const newFrom = rows.length;
  rows.push(...added);
  return {
    columns: after.columns,
    rows,
    changed,
    gone,
    newFrom,
    counts: { equal, changed: changedRows, gone: gone.length, added: added.length },
    key: usedKey,
    onlyOld: before.columns.map((c) => c.name).filter((n) => columnIndex(after.columns, n) < 0),
    onlyNew: names.filter((n) => posA.get(n)! < 0),
  };
}

/** Rows of a comparison that are equal: neither changed, gone nor new. */
function equalRows(c: Comparison): boolean[] {
  const equal = new Array<boolean>(c.rows.length).fill(true);
  for (const key of Object.keys(c.changed)) equal[Number(key.slice(0, key.indexOf(":")))] = false;
  for (const at of c.gone) equal[at] = false;
  for (let at = c.newFrom; at < c.rows.length; at++) equal[at] = false;
  return equal;
}

/** The same comparison with only the rows that differ (changed, gone, new); counts stay those of the whole. */
export function onlyDifferences(c: Comparison): Comparison {
  const equal = equalRows(c);
  const remap = new Int32Array(c.rows.length).fill(-1);
  const rows: Cell[][] = [];
  let newFrom = -1;
  for (let at = 0; at < c.rows.length; at++) {
    if (at === c.newFrom) newFrom = rows.length;
    if (equal[at]) continue;
    remap[at] = rows.length;
    rows.push(c.rows[at]);
  }
  if (newFrom < 0) newFrom = rows.length;
  const changed: Record<string, string | null> = {};
  for (const [key, old] of Object.entries(c.changed)) {
    const sep = key.indexOf(":");
    changed[`${remap[Number(key.slice(0, sep))]}:${key.slice(sep + 1)}`] = old;
  }
  return { ...c, rows, changed, gone: c.gone.map((at) => remap[at]), newFrom };
}

/**
 * A comparison as a plain result to export: a first column with each row's state, the second result's columns, and
 * for each column with a changed cell one more with the first result's value ("<column> (antes)").
 */
export function comparisonTable(c: Comparison, labels: { before: string; after: string }): ResultSet {
  const changedCols = [...new Set(Object.keys(c.changed).map((key) => Number(key.slice(key.indexOf(":") + 1))))].sort((a, b) => a - b);
  const gone = new Set(c.gone);
  const rowChanged = new Set(Object.keys(c.changed).map((key) => Number(key.slice(0, key.indexOf(":")))));
  const columns: ColumnInfo[] = [
    { name: "estado", typeName: "", kind: "text" },
    ...c.columns,
    ...changedCols.map((col) => ({ ...c.columns[col], name: `${c.columns[col].name} (antes)` })),
  ];
  const rows = c.rows.map((row, at) => {
    const state = gone.has(at) ? `solo en ${labels.before}` : at >= c.newFrom ? `solo en ${labels.after}` : rowChanged.has(at) ? "cambiada" : "igual";
    const before = changedCols.map((col) => {
      const key = `${at}:${col}`;
      return Object.prototype.hasOwnProperty.call(c.changed, key) ? c.changed[key] : null;
    });
    return [state, ...row, ...before];
  });
  return { columns, rows, hasMore: false, rowsAffected: null };
}

/**
 * The table a plain single-table SELECT reads (`SELECT … FROM [schema.]table [alias] [WHERE …] [ORDER BY …]…`), to
 * take its primary key as the comparison's key; null for joins, unions, groupings, subqueries and anything else.
 */
export function singleTableOf(sql: string): { schema: string; name: string } | null {
  const code = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!/^select\b/i.test(code) || /\b(join|union|intersect|except|minus|group\s+by|having)\b/i.test(code)) return null;
  const ident = String.raw`(?:"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60|[\p{L}_][\p{L}\p{N}_$#@]*)`;
  const match = new RegExp(String.raw`\bfrom\s+(${ident}(?:\s*\.\s*${ident}){0,2})(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|fetch\b|offset\b|for\b)[\p{L}_][\p{L}\p{N}_]*)?\s*(?:(?:where|order\s+by|limit|fetch|offset|for)\b([\s\S]*))?$`, "iu").exec(code);
  if (!match) return null;
  // What follows the table must not read another one (a subquery in WHERE is fine for the rows, not for this).
  if (match[2] && /\bselect\b/i.test(match[2])) return null;
  // Nor may the select list hold a subquery: its FROM would have been taken for the statement's.
  if (/\bselect\b/i.test(code.slice(6, match.index))) return null;
  const parts = match[1].split(/\s*\.\s*(?=(?:"|\[|\x60|[\p{L}_]))/u).map((part) => part.replace(/^["[\x60]|["\]\x60]$/g, ""));
  const name = parts[parts.length - 1];
  return { schema: parts.length > 1 ? parts[parts.length - 2] : "", name };
}
