// The result grid's multiple selection (#218): besides the rectangle of cells from the anchor to the focus, whole
// rows picked with Ctrl+click (Cmd+click on macOS), Shift+click and Ctrl+Shift+click, which need not be next to each
// other (rows 2, 5 and 9). Rows are screen rows (positions in the grid's current order), kept as ranges so that
// "every row but one" of a million is two numbers. No solid-js: dev/gridselection-check.ts tests it with node.

/** Screen rows as inclusive ranges `[from, to]`: sorted, disjoint and not touching (normalised). */
export type RowRanges = readonly (readonly [number, number])[];

/** `ranges` sorted, with overlapping and adjacent ranges merged and reversed ones turned round. */
export function normalizeRows(ranges: Iterable<readonly [number, number]>): RowRanges {
  const sorted = [...ranges].map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The rows from `a` to `b`, either way round. */
export function rowRange(a: number, b: number): RowRanges {
  return [a <= b ? [a, b] : [b, a]];
}

/** Index of the range holding `row`, or -1 (binary search: painting asks for every visible row). */
function rangeIndex(ranges: RowRanges, row: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (row < a) hi = mid - 1;
    else if (row > b) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function hasRow(ranges: RowRanges, row: number): boolean {
  return rangeIndex(ranges, row) >= 0;
}

/** `ranges` with `row` added, or taken out when it was there. */
export function toggleRow(ranges: RowRanges, row: number): RowRanges {
  const at = rangeIndex(ranges, row);
  if (at < 0) return normalizeRows([...ranges, [row, row]]);
  const [a, b] = ranges[at];
  const parts: [number, number][] = [];
  if (a < row) parts.push([a, row - 1]);
  if (row < b) parts.push([row + 1, b]);
  return [...ranges.slice(0, at), ...parts, ...ranges.slice(at + 1)];
}

/** `ranges` with the rows from `a` to `b` added. */
export function addRows(ranges: RowRanges, a: number, b: number): RowRanges {
  return normalizeRows([...ranges, ...rowRange(a, b)]);
}

/** How many rows `ranges` holds. */
export function rowCount(ranges: RowRanges): number {
  let n = 0;
  for (const [a, b] of ranges) n += b - a + 1;
  return n;
}

/** Every row of `ranges`, top to bottom (screen order). */
export function rowList(ranges: RowRanges): number[] {
  const rows: number[] = [];
  for (const [a, b] of ranges) for (let row = a; row <= b; row++) rows.push(row);
  return rows;
}

export interface RowClickMods {
  /** Ctrl+click (Cmd+click on macOS): add or remove the row, keeping the rest. */
  toggle: boolean;
  /** Shift+click: the rows from the last clicked one. With `toggle`, they are added to the selection. */
  range: boolean;
}

/**
 * The rows selected after a click on screen row `row`. `current` is what is selected now (the rectangle's rows when
 * no rows were picked) and `anchor` the row clicked last. Ctrl+click toggles the row, Shift+click selects the rows
 * from the anchor, Ctrl+Shift+click adds them; a plain click gives null: back to the single selection.
 */
export function clickRows(current: RowRanges, anchor: number | null, row: number, mods: RowClickMods): RowRanges | null {
  const from = anchor ?? row;
  if (mods.toggle && mods.range) return addRows(current, from, row);
  if (mods.toggle) return toggleRow(current, row);
  if (mods.range) return rowRange(from, row);
  return null;
}
