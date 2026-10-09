/**
 * Gives the focus back to `opener` (what had it before a dialog or the palette opened) once the overlay is gone,
 * unless something else took it meanwhile: the editor and grid shortcuts need it, and <body> takes none.
 */
export function returnFocus(opener: Element | null) {
  if (!(opener instanceof HTMLElement) || opener === document.body) return;
  queueMicrotask(() => {
    const now = document.activeElement;
    if (now && now !== document.body) return;
    if (opener.isConnected) opener.focus({ preventScroll: true });
  });
}

// ---- moving between panels (F6 / Mayús+F6)
//
// The panels are the elements with `data-focus-region` (explorer, editor, results, right panel), in the order they
// are on screen; only those shown count (the active tab's, not the hidden ones). Each remembers what had the focus
// in it, so coming back lands where you were; otherwise its `data-focus-default` element, or its first focusable.

const lastFocused = new WeakMap<Element, HTMLElement>();
let tracking = false;

function shown(el: Element): boolean {
  return el.getClientRects().length > 0 && !el.closest(".pane-host:not(.active)");
}

/** The panels on show, in screen order. */
export function focusRegions(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-focus-region]")].filter(shown);
}

/** Starts remembering, per panel, what had the focus last (once per window). */
export function trackRegionFocus() {
  if (tracking) return;
  tracking = true;
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const region = target.closest("[data-focus-region]");
    if (region) lastFocused.set(region, target);
  });
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Where the focus goes in a panel: where it was, its default, its first focusable, or the panel itself. */
export function regionTarget(region: HTMLElement): HTMLElement {
  const last = lastFocused.get(region);
  if (last && last.isConnected && region.contains(last) && shown(last)) return last;
  const preferred = region.querySelector<HTMLElement>("[data-focus-default]");
  if (preferred && shown(preferred)) return preferred;
  const first = [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].find(shown);
  if (first) return first;
  if (!region.hasAttribute("tabindex")) region.tabIndex = -1;
  return region;
}

/** The next panel after (or before, `dir` -1) the one with the focus; the first (or last) when none has it. */
export function nextRegion(regions: HTMLElement[], active: Element | null, dir: 1 | -1): HTMLElement | null {
  if (!regions.length) return null;
  const at = active ? regions.findIndex((region) => region.contains(active)) : -1;
  if (at < 0) return dir > 0 ? regions[0] : regions[regions.length - 1];
  return regions[(at + dir + regions.length) % regions.length];
}

/** F6 / Mayús+F6: the focus moves to the next or previous panel, which lights up for a moment. */
export function focusPanel(dir: 1 | -1) {
  const region = nextRegion(focusRegions(), document.activeElement, dir);
  if (!region) return;
  regionTarget(region).focus({ preventScroll: true });
  region.classList.remove("region-flash");
  void region.offsetWidth;
  region.classList.add("region-flash");
  window.setTimeout(() => region.classList.remove("region-flash"), 600);
}

/**
 * A panel that holds the focus is closing: the focus goes to the active tab's editor or results (never lost on
 * <body>, where no shortcut of the editor or the grid reaches).
 */
export function rescueFocus(panel: Element | undefined) {
  if (!panel || !panel.contains(document.activeElement)) return;
  queueMicrotask(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const main = focusRegions().find((region) => region.dataset.focusRegion === "editor" || region.dataset.focusRegion === "results");
    if (main) regionTarget(main).focus({ preventScroll: true });
  });
}
