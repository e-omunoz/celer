// The result grid's column order: its headers can be dragged, and what is on screen (painting, selection, copy,
// the record view, the export) follows. An order is a permutation of the query's column indexes: `order[i]` is the
// query column shown i-th. Pure helpers, checked by dev/columnorder-check.ts.

/** A grid's column order as the export takes it: `names` tells which query it was made for. */
export interface ColumnOrder {
  names: string[];
  order: number[];
}

/** The query's own order: 0, 1, 2… */
export function identityOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

export function isIdentity(order: readonly number[]): boolean {
  for (let i = 0; i < order.length; i++) if (order[i] !== i) return false;
  return true;
}

/** True when `order` holds each of 0…count-1 exactly once. */
export function isPermutation(order: readonly number[], count: number): boolean {
  if (order.length !== count) return false;
  const seen = new Uint8Array(count);
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= count || seen[index]) return false;
    seen[index] = 1;
  }
  return true;
}

/** Screen position of each query column: the inverse of `order`. */
export function inverseOrder(order: readonly number[]): number[] {
  const at: number[] = new Array(order.length);
  for (let i = 0; i < order.length; i++) at[order[i]] = i;
  return at;
}

/**
 * The column shown at `from` taken out and put back at the gap `gap` (0: before the first, length: after the last).
 * Dropping it next to itself changes nothing and gives back `order` itself.
 */
export function moveColumn(order: readonly number[], from: number, gap: number): readonly number[] {
  if (from < 0 || from >= order.length || gap < 0 || gap > order.length || gap === from || gap === from + 1) return order;
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(gap > from ? gap - 1 : gap, 0, moved);
  return next;
}

/**
 * The gap nearest to `x` among columns whose left edges are `xs` (one more entry: the right edge of the last): a
 * point on a column's left half drops before it, on its right half after it.
 */
export function dropGap(xs: readonly number[], x: number): number {
  const count = xs.length - 1;
  for (let col = 0; col < count; col++) if (x < (xs[col] + xs[col + 1]) / 2) return col;
  return Math.max(0, count);
}

/** `items` (a row, the column list) in screen order. */
export function inOrder<T>(items: readonly T[], order: readonly number[]): T[] {
  return order.map((index) => items[index]);
}

/**
 * While a column is dragged the others slide to open a gap for it: the gap where the column at screen position
 * `from`, its ghost's left edge at `left`, would drop. `widths` are the screen columns' widths and `start` the left
 * edge of the first (after the gutter). The column takes the slot among the others (packed without it) whose left
 * edge is nearest to the ghost's: it passes a neighbour once it has covered half of that neighbour's width, either
 * way, and the result depends only on where the ghost is (no flicker back and forth).
 */
export function slideGap(widths: readonly number[], from: number, left: number, start = 0): number {
  if (from < 0 || from >= widths.length) return Math.max(0, from);
  let x = start;
  let slot = 0;
  for (let col = 0; col < widths.length; col++) {
    if (col === from) continue;
    if (left <= x + widths[col] / 2) break;
    slot++;
    x += widths[col];
  }
  // `slot` is the place it takes among the others; as a gap of the current order (see moveColumn).
  return slot <= from ? slot : slot + 1;
}

/**
 * Left edge of each query column (indexed by query column, not by screen position) when the screen order is
 * `order` and `widthOf(query column)` gives the widths: where the columns slide to while a move is previewed.
 */
export function layoutByColumn(order: readonly number[], widthOf: (col: number) => number, start = 0): Float64Array {
  const xs = new Float64Array(order.length);
  let x = start;
  for (const col of order) {
    xs[col] = x;
    x += widthOf(col);
  }
  return xs;
}

/**
 * One frame of the slide: each position eases towards its target (exponentially, `tau` ms) and snaps once within
 * half a pixel; `instant` (reduced motion) jumps straight there. True while anything is still moving.
 */
export function easeTowards(current: Float64Array, target: Float64Array, dt: number, tau = 45, instant = false): boolean {
  const k = instant ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau);
  let moving = false;
  for (let i = 0; i < current.length; i++) {
    const diff = target[i] - current[i];
    if (k >= 1 || Math.abs(diff) < 0.5) current[i] = target[i];
    else {
      current[i] += diff * k;
      moving = true;
    }
  }
  return moving;
}
