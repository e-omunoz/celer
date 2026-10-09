// Several Celer windows, without the app around them: window labels and names, the layout file (workspace.json
// version 2) and how it is read back, where a window goes when its monitor is gone, where a dragged tab lands,
// what a window that closes would lose and which window shows Gib. Pure functions, tested by
// dev/windows-check.ts; windows.ts talks to the core and to the other windows.

/** "main" is the window Celer starts with; "win-N" are the full windows opened later; "panel-…" show one panel. */
export type WindowKind = "main" | "full" | "panel";

export type PanelKind = "library" | "ai" | "plan" | "er" | "compare" | "schema-compare" | "data-compare";

export const PANEL_KINDS: PanelKind[] = ["library", "ai", "plan", "er", "compare", "schema-compare", "data-compare"];

/** Panels that exist once (they show what every window shares); the others show one plan, diagram or comparison. */
export const SINGLE_PANELS: PanelKind[] = ["library", "ai"];

const PANEL_NAMES: Record<PanelKind, string> = {
  library: "Biblioteca de scripts",
  ai: "Asistente IA",
  plan: "Plan de ejecución",
  er: "Diagrama E-R",
  compare: "Comparación de resultados",
  "schema-compare": "Comparación de esquemas",
  "data-compare": "Comparación de datos",
};

export function panelName(kind: PanelKind): string {
  return PANEL_NAMES[kind];
}

export function windowKind(label: string): WindowKind {
  if (label === "main") return "main";
  return label.startsWith("win-") ? "full" : "panel";
}

/** A window that has tabs, an explorer and a status bar (not a panel). */
export function isFullWindow(label: string): boolean {
  return windowKind(label) !== "panel";
}

/** The panel a panel window shows ("panel-schema-compare-3" → "schema-compare"), or null. */
export function panelOf(label: string): PanelKind | null {
  if (!label.startsWith("panel-")) return null;
  const rest = label.slice("panel-".length);
  // Longest names first: "schema-compare-2" is not a "compare".
  const kinds = PANEL_KINDS.slice().sort((a, b) => b.length - a.length);
  return kinds.find((kind) => rest === kind || rest.startsWith(`${kind}-`)) ?? null;
}

/** 1 for the main window, N for "win-N", 0 for panels. */
export function windowNumber(label: string): number {
  if (label === "main") return 1;
  const match = /^win-(\d+)$/.exec(label);
  return match ? Number(match[1]) : 0;
}

/** "la ventana principal", "la ventana 2", "el panel Biblioteca de scripts": for menus and messages. */
export function windowName(label: string): string {
  if (label === "main") return "la ventana principal";
  const panel = panelOf(label);
  if (panel) return `el panel ${panelName(panel)}`;
  return `la ventana ${windowNumber(label) || "nueva"}`;
}

/** The main window, then the full windows by number, then the panels. */
export function sortWindows<T extends { label: string }>(list: T[]): T[] {
  const rank = (label: string) => (label === "main" ? 0 : isFullWindow(label) ? 1 : 2);
  return list.slice().sort((a, b) => rank(a.label) - rank(b.label) || windowNumber(a.label) - windowNumber(b.label) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- the layout file

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A monitor as the core sees it: physical pixels, and its scale (1.5 on a 150 % screen). */
export interface Monitor extends Rect {
  name: string;
  scale: number;
}

/** Where a window was: physical pixels of its normal (not maximized) frame, and the monitor it was on. */
export interface WindowGeometry extends Rect {
  maximized: boolean;
  monitor: string;
  scale: number;
}

/** One window of workspace.json. `tabs` are the saved tabs of state.ts (opaque here, they only need an id). */
export interface SavedWindow<T extends { id: string } = { id: string }> {
  kind: "full" | "panel";
  /** The panel of a panel window (only the library and the assistant are restored). */
  panel?: PanelKind;
  /** What the window shows, for menus ("ventas.sql"). */
  title: string;
  tabs: T[];
  activeTabId: string;
  explorerOpen?: boolean;
  inspectorOpen?: boolean;
  inspectorMode?: string;
  geometry?: WindowGeometry | null;
}

/**
 * workspace.json, version 2: one entry per window, the main one first. The first window's tabs are also written at
 * the top level, as version 1 had them, so an older Celer still opens those.
 */
export interface LayoutFile<T extends { id: string } = { id: string }> {
  version: 2;
  tabs: T[];
  activeTabId: string;
  sidebarWidth?: number;
  windows: SavedWindow<T>[];
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readGeometry(value: unknown): WindowGeometry | null {
  if (!isObject(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width < 100 || height < 100) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: value.maximized === true,
    monitor: typeof value.monitor === "string" ? value.monitor : "",
    scale: finite(value.scale) && value.scale > 0 ? value.scale : 1,
  };
}

function readTabs(value: unknown, seen: Set<string>): { id: string }[] {
  if (!Array.isArray(value)) return [];
  const tabs: { id: string }[] = [];
  for (const tab of value) {
    // A tab is somewhere once: the same id in two windows (a file written halfway through a move) stays in the first.
    if (!isObject(tab) || typeof tab.id !== "string" || !tab.id || (tab.kind !== "sql" && tab.kind !== "table") || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab as { id: string });
  }
  return tabs;
}

function readWindow(value: unknown, seen: Set<string>): SavedWindow | null {
  if (!isObject(value)) return null;
  const panel = typeof value.panel === "string" && (SINGLE_PANELS as string[]).includes(value.panel) ? (value.panel as PanelKind) : undefined;
  const kind = value.kind === "panel" ? "panel" : "full";
  // Plans, diagrams and comparisons are not restored: they need the session that made them.
  if (kind === "panel" && !panel) return null;
  const tabs = kind === "full" ? readTabs(value.tabs, seen) : [];
  const active = typeof value.activeTabId === "string" && tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : (tabs[0]?.id ?? "");
  const saved: SavedWindow = {
    kind,
    title: typeof value.title === "string" ? value.title : "",
    tabs,
    activeTabId: active,
    geometry: readGeometry(value.geometry),
  };
  if (panel) saved.panel = panel;
  if (typeof value.explorerOpen === "boolean") saved.explorerOpen = value.explorerOpen;
  if (typeof value.inspectorOpen === "boolean") saved.inspectorOpen = value.inspectorOpen;
  if (typeof value.inspectorMode === "string") saved.inspectorMode = value.inspectorMode;
  return saved;
}

/**
 * The windows of a workspace.json (version 1 or 2; nothing for a missing or foreign file). The first one is always
 * a full window, which the main window takes; the others open as new windows.
 */
export function readLayout(file: unknown): SavedWindow[] {
  if (!isObject(file)) return [];
  const seen = new Set<string>();
  let windows: SavedWindow[] = [];
  if (Array.isArray(file.windows)) {
    windows = file.windows.map((value) => readWindow(value, seen)).filter((value): value is SavedWindow => value !== null);
  } else {
    // Version 1: the tabs of the only window.
    const only = readWindow({ kind: "full", tabs: file.tabs, activeTabId: file.activeTabId }, seen);
    if (only) windows = [only];
  }
  const first = windows.findIndex((w) => w.kind === "full");
  if (first < 0) windows.unshift({ kind: "full", title: "", tabs: [], activeTabId: "", geometry: null });
  else if (first > 0) windows.unshift(...windows.splice(first, 1));
  return windows;
}

/** workspace.json from the windows' entries (the core writes the same; the browser demo writes this one). */
export function composeLayout<T extends { id: string }>(windows: SavedWindow<T>[], sidebarWidth?: number): LayoutFile<T> {
  const first = windows.find((w) => w.kind === "full");
  const file: LayoutFile<T> = { version: 2, tabs: first?.tabs ?? [], activeTabId: first?.activeTabId ?? "", windows };
  if (sidebarWidth !== undefined) file.sidebarWidth = sidebarWidth;
  return file;
}

// ---------------------------------------------------------------- monitors

const overlap = (a: Rect, b: Rect) => ({
  width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
});

/** The top of the window (where it is dragged from) is on `monitor`, enough of it to grab it. */
function grabbable(rect: Rect, monitor: Rect): boolean {
  const strip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(40, rect.height) };
  const seen = overlap(strip, monitor);
  return seen.width >= Math.min(120, rect.width) && seen.height >= Math.min(20, strip.height);
}

/** The monitor at (0, 0), which the operating system makes the primary one, or else the first. */
export function primaryMonitor(monitors: Monitor[]): Monitor | undefined {
  return monitors.find((m) => m.x <= 0 && m.y <= 0 && m.x + m.width > 0 && m.y + m.height > 0) ?? monitors[0];
}

/**
 * Where a saved window goes now. On a monitor that is still there (or on any other that shows its title bar) it
 * stays where it was, made smaller if it no longer fits. Otherwise (the monitor was unplugged or moved) it goes to
 * the monitor with its name, or to the primary one: centred, with its size kept in proportion to the screen's
 * scale and never bigger than the screen.
 */
export function placeOnScreen(saved: WindowGeometry, monitors: Monitor[]): WindowGeometry {
  if (!monitors.length) return saved;
  const home = monitors.find((m) => grabbable(saved, m));
  if (home) {
    const width = Math.min(saved.width, home.width);
    const height = Math.min(saved.height, home.height);
    return { ...saved, width, height, monitor: home.name, scale: home.scale };
  }
  const target = monitors.find((m) => m.name && m.name === saved.monitor) ?? primaryMonitor(monitors)!;
  const ratio = target.scale / (saved.scale || 1);
  const width = Math.min(Math.round(saved.width * ratio), Math.round(target.width * 0.95));
  const height = Math.min(Math.round(saved.height * ratio), Math.round(target.height * 0.95));
  return {
    ...saved,
    width,
    height,
    x: target.x + Math.round((target.width - width) / 2),
    y: target.y + Math.round((target.height - height) / 2),
    monitor: target.name,
    scale: target.scale,
  };
}

/** A new window from `origin` (another window's corner): moved down and right, past the windows already there. */
export function cascadeFrom(origin: { x: number; y: number }, taken: { x: number; y: number }[], step = 32): { x: number; y: number } {
  let at = { x: origin.x + step, y: origin.y + step };
  for (let i = 0; i < 20 && taken.some((t) => Math.abs(t.x - at.x) < step / 2 && Math.abs(t.y - at.y) < step / 2); i++) {
    at = { x: at.x + step, y: at.y + step };
  }
  return at;
}

// ---------------------------------------------------------------- dragging a tab out

export interface WindowRect extends Rect {
  label: string;
  minimized: boolean;
}

export type DropTarget = { kind: "window"; label: string; index: number | null } | { kind: "new"; x: number; y: number } | { kind: "none" };

/** How far the new window's corner is from the pointer: the tab ends up about under it. */
export const DROP_OFFSET = { x: 120, y: 18 };

const inside = (point: [number, number], rect: Rect) => point[0] >= rect.x && point[0] < rect.x + rect.width && point[1] >= rect.y && point[1] < rect.y + rect.height;

/**
 * Where a tab dragged out of `source` goes: the tab bar of another window that took the drop (`claim`), else the
 * window under the pointer, else a new window where it was let go. Nothing when it was let go on its own window
 * or the pointer is unknown.
 */
export function dropTarget(source: string, cursor: [number, number] | null, windows: WindowRect[], claim: { label: string; index: number } | null): DropTarget {
  if (claim && claim.label !== source && isFullWindow(claim.label) && windows.some((w) => w.label === claim.label)) {
    return { kind: "window", label: claim.label, index: claim.index };
  }
  if (!cursor) return { kind: "none" };
  const visible = windows.filter((w) => !w.minimized && w.width > 0 && w.height > 0);
  const own = visible.find((w) => w.label === source);
  if (own && inside(cursor, own)) return { kind: "none" };
  const other = sortWindows(visible.filter((w) => w.label !== source && isFullWindow(w.label))).find((w) => inside(cursor, w));
  if (other) return { kind: "window", label: other.label, index: null };
  return { kind: "new", x: Math.round(cursor[0] - DROP_OFFSET.x), y: Math.round(cursor[1] - DROP_OFFSET.y) };
}

/**
 * Where a tab let go at `x` lands in a tab bar: before the first tab whose middle is right of it, so 0 … n (n: after
 * the last). `mids` are the middles of the tabs, left to right.
 */
export function insertionGap(mids: number[], x: number): number {
  let gap = 0;
  for (const mid of mids) if (x > mid) gap++;
  return gap;
}

/** The position (moveTab's `to`) of the tab at `from` dropped at gap `gap` of its own bar; null: it stays. */
export function reorderTarget(from: number, gap: number): number | null {
  if (gap === from || gap === from + 1) return null;
  return gap > from ? gap - 1 : gap;
}

/** `items` put into `list` at `index` (the end when it is null or past it). */
export function insertAt<T>(list: T[], items: T[], index: number | null): T[] {
  const at = index === null || index < 0 || index > list.length ? list.length : index;
  return [...list.slice(0, at), ...items, ...list.slice(at)];
}

// ---------------------------------------------------------------- closing a window

/** What a tab would lose if its window closed without it. */
export interface TabRisk {
  id: string;
  kind: "sql" | "table";
  /** An open transaction (closing the session rolls it back). */
  transaction: boolean;
  /** Table edits not saved yet. */
  edits: boolean;
  /** A console whose text is only in this window (no file, not in the library, or changed since). */
  text: boolean;
}

export function riskyTabs(tabs: TabRisk[]): TabRisk[] {
  return tabs.filter((tab) => tab.transaction || tab.edits || tab.text);
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 consola con una transacción abierta, 2 tablas con cambios sin guardar y 1 consola sin guardar". */
export function riskSummary(tabs: TabRisk[]): string {
  const tx = tabs.filter((tab) => tab.transaction).length;
  const edits = tabs.filter((tab) => tab.edits).length;
  const text = tabs.filter((tab) => tab.text && !tab.transaction).length;
  const parts = [
    tx ? counted(tx, "consola con una transacción abierta", "consolas con transacciones abiertas") : "",
    edits ? counted(edits, "tabla con cambios sin guardar", "tablas con cambios sin guardar") : "",
    text ? counted(text, "consola sin guardar", "consolas sin guardar") : "",
  ].filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------- Gib

/**
 * The window Gib lives in: the full window with the focus, else the main one, else the first full window. Never a
 * panel, and never two at once.
 */
export function gibHost(focused: string, open: string[]): string {
  if (focused && isFullWindow(focused) && open.includes(focused)) return focused;
  if (open.includes("main")) return "main";
  return sortWindows(open.filter(isFullWindow).map((label) => ({ label })))[0]?.label ?? "";
}
