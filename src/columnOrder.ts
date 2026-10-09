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
