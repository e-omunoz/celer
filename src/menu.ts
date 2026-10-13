// Context menus and their submenus (src/components/Overlays.tsx): where a panel goes and which row the keys move to.
// Pure logic, checked by dev/menu-check.ts.

/**
 * Where a menu panel goes: at the point (the root menu) or beside the row it opens from (a submenu), moved or
 * flipped so it stays inside the window near its edges.
 */
export function placeMenu(
  anchor: { x: number; y: number; row?: { left: number; right: number; top: number } },
  size: { width: number; height: number },
  view: { width: number; height: number },
  margin = 6,
): { x: number; y: number } {
  let x: number;
  let y: number;
  if (anchor.row) {
    // A submenu: to the right of its row, or to the left when it does not fit; its first item level with the row.
    x = anchor.row.right - 2;
    if (x + size.width > view.width - margin) x = Math.max(margin, anchor.row.left - size.width + 2);
    y = Math.min(anchor.row.top - 5, view.height - size.height - margin);
  } else {
    x = Math.min(anchor.x, view.width - size.width - margin);
    y = anchor.y + size.height > view.height - margin ? anchor.y - size.height : anchor.y;
  }
  return { x: Math.max(margin, x), y: Math.max(margin, y) };
}

/** The next item that can be chosen from `from` in direction `dir` (separators and disabled rows skipped), or -1. */
export function nextMenuItem(items: { separator?: boolean; disabled?: boolean }[], from: number, dir: 1 | -1): number {
  const n = items.length;
  let next = from;
  for (let i = 0; i < n; i++) {
    next = (((next + dir) % n) + n) % n;
    if (!items[next].separator && !items[next].disabled) return next;
  }
  return -1;
}
