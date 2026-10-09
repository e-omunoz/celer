// Multi-selection in a tree of rows (the explorer): click, Ctrl+click, Shift+click, Ctrl+Shift+click, Shift+arrows and
// Ctrl+A, all in visible order. Rows are known by their keys; the caller says which rows may be selected together (their
// family) and what "the same kind" is for Ctrl+A. No solid-js, so dev/explorer-check.ts tests it with node.

/** The selected keys (in visible order), the anchor Shift ranges start from, and the focused key (the cursor). */
export interface TreeSelection {
  keys: string[];
  anchor: string;
  focus: string;
}

/** Rows of the same family can be selected together; `null` is a row that is only ever selected on its own. */
export type FamilyOf = (key: string) => string | null;

export interface ClickMods {
  /** Ctrl+click (Cmd+click on macOS): add or remove one row. */
  toggle: boolean;
  /** Shift+click: the range from the anchor. With `toggle`, the range is added to the selection. */
  range: boolean;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** The modifier that adds a row: Cmd on macOS (where Ctrl+click is the right click), Ctrl elsewhere. */
export function isToggleClick(event: { ctrlKey: boolean; metaKey: boolean }, mac = MAC): boolean {
  return mac ? event.metaKey : event.ctrlKey || event.metaKey;
}

export function singleSelection(key: string): TreeSelection {
  return { keys: key ? [key] : [], anchor: key, focus: key };
}

/** `keys` in visible order, without the ones that are not shown. */
export function inOrder(order: string[], keys: Iterable<string>): string[] {
  const set = new Set(keys);
  return order.filter((key) => set.has(key));
}

/** The rows between `from` and `to` (both included, either direction) that are of `to`'s family. */
export function rangeKeys(order: string[], from: string, to: string, familyOf: FamilyOf): string[] {
  const end = order.indexOf(to);
  if (end < 0) return [];
  const start = order.indexOf(from);
  const family = familyOf(to);
  if (start < 0 || family === null) return [to];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return order.slice(lo, hi + 1).filter((key) => familyOf(key) === family);
}

/**
 * What the selection is after a click on `key`. A plain click selects that row alone. Ctrl+click adds or removes it
 * when it is of the selection's family (otherwise it starts again from it); removing the last one leaves it selected,
 * and the focus goes to the nearest row still selected. Shift+click selects the rows of the anchor's family from the
 * anchor to it; Ctrl+Shift+click adds them. A row of another family, or one that is never multi-selected, is selected
 * alone.
 */
export function clickSelection(sel: TreeSelection, order: string[], key: string, mods: ClickMods, familyOf: FamilyOf): TreeSelection {
  const family = familyOf(key);
  const current = inOrder(order, sel.keys);
  const sameFamily = family !== null && current.length > 0 && current.every((k) => familyOf(k) === family);
  if (mods.range && family !== null && order.includes(sel.anchor) && familyOf(sel.anchor) === family) {
    const range = rangeKeys(order, sel.anchor, key, familyOf);
    return { keys: mods.toggle && sameFamily ? inOrder(order, [...current, ...range]) : range, anchor: sel.anchor, focus: key };
  }
  if (mods.toggle && sameFamily) {
    if (!current.includes(key)) return { keys: inOrder(order, [...current, key]), anchor: key, focus: key };
    const rest = current.filter((k) => k !== key);
    if (!rest.length) return singleSelection(key);
    const focus = nearest(order, rest, key);
    return { keys: rest, anchor: key, focus };
  }
  return singleSelection(key);
}

/** The row of `keys` closest to `key` in visible order (the one after it on a tie). */
function nearest(order: string[], keys: string[], key: string): string {
  const at = order.indexOf(key);
  let best = keys[0];
  let distance = Infinity;
  for (const k of keys) {
    const d = Math.abs(order.indexOf(k) - at);
    if (d < distance || (d === distance && order.indexOf(k) > at)) {
      best = k;
      distance = d;
    }
  }
  return best;
}

/**
 * Where Shift+arrow (`step` 1 or -1) or Shift+Home/End (`step` ±Infinity) moves the focus to: the next row of the
 * anchor's family in that direction, skipping the others. `null` when there is none.
 */
export function stepKey(order: string[], from: string, step: number, family: string | null, familyOf: FamilyOf): string | null {
  const same = order.filter((key) => family === null || familyOf(key) === family);
  if (!same.length) return null;
  if (step === Infinity) return same[same.length - 1];
  if (step === -Infinity) return same[0];
  const at = order.indexOf(from);
  if (step > 0) return order.slice(at + 1).find((key) => same.includes(key)) ?? null;
  return order.slice(0, Math.max(0, at)).reverse().find((key) => same.includes(key)) ?? null;
}

/** Shift+arrows: the range from the anchor to `key` (the new focus). */
export function extendSelection(sel: TreeSelection, order: string[], key: string, familyOf: FamilyOf): TreeSelection {
  return clickSelection(sel, order, key, { toggle: false, range: true }, familyOf);
}

/** Ctrl+A: every visible row of the focused row's kind (`null` when that row has none, and nothing changes). */
export function selectAllLike(order: string[], focus: string, kindOf: (key: string) => string | null): TreeSelection | null {
  const kind = kindOf(focus);
  if (kind === null) return null;
  const keys = order.filter((key) => kindOf(key) === kind);
  if (!keys.length) return null;
  return { keys, anchor: keys[0], focus: keys.includes(focus) ? focus : keys[0] };
}

/**
 * The rows the selection is now: its visible keys while the focus is still the one it set, else the focused row alone
 * (anything that moves the focus elsewhere, such as a disconnect or a deletion, ends a multi-selection).
 */
export function effectiveKeys(sel: TreeSelection, order: string[], focus: string): string[] {
  if (!focus || !order.includes(focus)) return [];
  if (sel.focus !== focus) return [focus];
  const keys = inOrder(order, sel.keys);
  return keys.includes(focus) ? keys : [focus];
}

/** "1 conexión", "3 conexiones". */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a selection of connections and folders is, for menus and confirmations: "3 conexiones y 1 carpeta". */
export function selectionLabel(conns: number, folders: number): string {
  const parts = [conns ? countOf(conns, "conexión", "conexiones") : "", folders ? countOf(folders, "carpeta", "carpetas") : ""].filter(Boolean);
  return parts.join(" y ") || "nada";
}
