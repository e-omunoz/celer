import { $RAW } from "solid-js/store";

/**
 * The plain value behind a store proxy, in O(1). Use it instead of `unwrap` for result rows:
 * `unwrap` on a plain array walks every element (and every cell) to strip nested proxies, so calling
 * it per row or per paint on 200k rows is quadratic and freezes the window.
 */
export function raw<T>(value: T): T {
  return ((value as { [$RAW]?: T } | null | undefined)?.[$RAW] ?? value) as T;
}

/**
 * Marks a plain array (result rows) as its own raw value, so a store write that carries it (`setState(..., { rows })`)
 * does not walk it: `unwrap` looks for nested proxies in every row and cell of a plain array, 20 million steps
 * (~700 ms) for a 200-column, 100k-row result each time a page of rows is added.
 */
export function asRaw<T extends object>(value: T): T {
  Object.defineProperty(value, $RAW, { value, enumerable: false, configurable: true });
  return value;
}
