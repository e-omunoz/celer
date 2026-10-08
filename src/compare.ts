// Comparing two results (a pinned one and the current one): rows matched by a key, then classified as equal,
// changed (which cells), only in the old result (gone) or only in the new one (new). Pure: dev/compare-check.ts.
import type { Cell, ColumnInfo, ResultSet } from "./types";

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

const keyText = (cell: Cell) => (cell === null || cell === undefined ? "\u0000NULL" : typeof cell === "number" ? String(cell) : String(cell));

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
    const k = idx.map((i) => keyText(row[i])).join("\u0001");
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** The first column whose values are unique and not null in both results, as a natural key. */
export function guessKey(a: ResultSet, b: ResultSet): string[] {
  const shared = a.columns.map((c) => c.name).filter((name) => columnIndex(b.columns, name) >= 0);
  for (const name of shared) {
    const unique = (r: ResultSet) => {
      const i = columnIndex(r.columns, name);
      const seen = new Set<string>();
      for (const row of r.rows) {
        const v = row[i];
        if (v === null || v === undefined) return false;
        const k = keyText(v);
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
  const idxA = (name: string) => columnIndex(before.columns, name);
  const idxB = (name: string) => columnIndex(after.columns, name);
  const shared = names.filter((name) => idxA(name) >= 0);
  // Key names as the new result writes them.
  const usedKey = key.map((k) => shared.find((s) => s === k) ?? shared.find((s) => s.toLowerCase() === k.toLowerCase())).filter((k): k is string => Boolean(k));
  const keyOf = (row: Cell[], side: "a" | "b", cols: string[]) => cols.map((c) => keyText(row[side === "a" ? idxA(c) : idxB(c)])).join("\u0001");
  const keyCols = usedKey.length ? usedKey : shared;

  // Old rows by key (a list: duplicates are matched in order).
  const old = new Map<string, Cell[][]>();
  for (const row of before.rows) {
    const k = keyOf(row, "a", keyCols);
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
    const k = keyOf(row, "b", keyCols);
    const match = old.get(k)?.shift();
    if (!match) {
      added.push(row);
      continue;
    }
    const at = rows.length;
    let differs = false;
    for (const name of shared) {
      const ia = idxA(name);
      const ib = idxB(name);
      if (keyText(match[ia]) !== keyText(row[ib])) {
        differs = true;
        changed[`${at}:${ib}`] = match[ia] === null || match[ia] === undefined ? null : String(match[ia]);
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
      rows.push(names.map((name) => (idxA(name) >= 0 ? row[idxA(name)] : null)));
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
    onlyNew: names.filter((n) => idxA(n) < 0),
  };
}
