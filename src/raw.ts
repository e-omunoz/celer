import { $RAW } from "solid-js/store";

/**
 * The plain value behind a store proxy, in O(1). Use it instead of `unwrap` for result rows:
 * `unwrap` on a plain array walks every element (and every cell) to strip nested proxies, so calling
 * it per row or per paint on 200k rows is quadratic and freezes the window.
 */
export function raw<T>(value: T): T {
  return ((value as { [$RAW]?: T } | null | undefined)?.[$RAW] ?? value) as T;
}
