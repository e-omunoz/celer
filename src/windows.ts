// Several windows of one Celer. Each window is its own page with its own state.ts: its tabs and their sessions,
// its explorer, its panels and its focus. What they share (connections, settings, the library, Gib's memory) has
// one owner: the core writes the files and tells every window (events "celer://shared"). The core also keeps the
// sessions, so a tab moved to another window goes on with the same connection, transaction, pending rows and
// #temp tables: only the window that shows it changes. Windows talk to each other through the core
// (src-tauri/src/windows.rs): a message is left in the other window's inbox and the core rings it.
//
// Panels (the library, the assistant, a plan, a diagram, a comparison) can also go to a window of their own and
// come back ("Acoplar"). A panel window shows the panel and asks its window (the one it came from, or the last
// focused one for the library and the assistant) to do what needs a console or a connection.
//
// The logic without the app around it (layout file, monitors, where a dragged tab lands, Gib's window) is in
// windowModel.ts. Design notes: docs/ARCHITECTURE.md, "Windows".
import { createEffect, createRoot, createSignal, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import type { AiMessage } from "./ai";
import {
  activeSql,
  activeTab,
  adoptTab,
  applySharedSettings,
  beforeClose,
  blankSql,
  closeCompare,
  closeErDiagram,
  closeTabsQuietly,
  compareWithCurrent,
  confirmDialog,
  connect,
  connectionById,
  detachTab,
  disconnect,
  endTransactions,
  explainStatement,
  fileDirty,
  insertIntoActive,
  notify,
  openInspector,
  openTable,
  patchTab,
  persistNow,
  persistSoon,
  refreshConnections,
  releaseWindowSessions,
  replaceActiveSql,
  settleTransactions,
  restoreTabs,
  runText,
  savedTabs,
  setCompareKey,
  setGibEvent,
  setState,
  showPlan,
  state,
  tabMoveBlocker,
  tableDirty,
  uid,
  type ColumnFilter,
  type ErState,
  type GibEvent,
  type SavedTab,
  type SqlTab,
  type Tab,
  type TableTab,
} from "./state";
import { applySharedLibrary, insertLibraryScript, libraryDirty, loadLibrary, openLibraryScript, revertConsole, saveToLibrary, scriptById } from "./library";
import { closeSchemaCompare, openSyncScript, schemaCompare, setSchemaCompare, swapCompare } from "./schemaCompareRun";
import { closeDataCompare, dataCompare, openDataSyncScript, setDataCompare, swapDataCompare } from "./dataCompareRun";
import { installOnClose } from "./update";
import { raw } from "./raw";
import type { CompletionSchema, ObjectRef, Settings } from "./types";
import {
  cascadeFrom,
  composeLayout,
  dropTarget,
  gibHost,
  isFullWindow,
  panelOf,
  placeOnScreen,
  readLayout,
  riskSummary,
  riskyTabs,
  SINGLE_PANELS,
  sortWindows,
  windowKind,
  windowName,
  type PanelKind,
  type SavedWindow,
  type TabRisk,
  type WindowGeometry,
  type WindowRect,
} from "./windowModel";

// ---------------------------------------------------------------- talking to the core

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

async function listen<T>(event: string, handler: (payload: T) => void) {
  const { listen: on } = await import("@tauri-apps/api/event");
  return on<T>(event, (e) => handler(e.payload));
}

async function thisWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

/** This window's label: "main", "win-2", "panel-library"… ("main" in the browser demo). */
function readLabel(): string {
  if (!isTauri()) return "main";
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label || "main";
}

export const windowLabel = readLabel();
/** The panel this window shows, or null for a full window. */
export const panelKind: PanelKind | null = panelOf(windowLabel);

export function isPanelWindow(): boolean {
  return panelKind !== null;
}

interface WindowInfo {
  label: string;
  title: string;
  focused: boolean;
}

/** What the core says about the window: physical pixels, its monitor and every monitor. */
interface Screen {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  monitor: string;
  scale: number;
  monitors: { name: string; x: number; y: number; width: number; height: number; scale: number }[];
}

const [openWindows, setOpenWindows] = createSignal<WindowInfo[]>([{ label: windowLabel, title: "", focused: true }]);
/** The full window that had the focus last (panels do not count). */
const [focusedWindow, setFocusedWindow] = createSignal(isFullWindow(windowLabel) ? windowLabel : "");
/** A tab is being dragged out of another window: this one's tab bar takes it. */
const [incomingDrag, setIncomingDrag] = createSignal<{ source: string; title: string } | null>(null);
export { incomingDrag, openWindows };

/** The other full windows, the main one first. */
export function otherFullWindows(): WindowInfo[] {
  return sortWindows(openWindows().filter((w) => w.label !== windowLabel && isFullWindow(w.label)));
}

async function refreshWindows() {
  if (!isTauri()) return;
  const list = await invoke<WindowInfo[]>("window_list").catch(() => null);
  if (!list) return;
  setOpenWindows(sortWindows(list));
  const focused = list.find((w) => w.focused);
  if (focused) setFocusedWindow(focused.label);
}

type Message = Record<string, unknown> & { kind: string; from?: string };

/** Leaves a message in another window's inbox ("*": every other window); false when that window is gone. */
async function post(target: string, message: Message): Promise<boolean> {
  if (!isTauri() || !target) return false;
  return invoke<boolean>("window_post", { target, message: { ...message, from: windowLabel } }).catch(() => false);
}

let draining = Promise.resolve();
let started: () => void = () => {};
/** Messages wait until the window has started (its settings, connections and own tabs are in). */
const ready = new Promise<void>((resolve) => (started = resolve));

function scheduleDrain() {
  draining = draining
    .then(() => ready)
    .then(async () => {
      const messages = await invoke<Message[]>("window_inbox").catch(() => [] as Message[]);
      for (const message of messages) await handle(message).catch((err) => notify("No se pudo atender a otra ventana", "error", errorText(err)));
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- start

let startMessages: Message[] = [];
let layoutFile: unknown = null;
let layoutError = "";
/** The window's frame when it was last not maximized (what is saved for a maximized window). */
let normal: WindowGeometry | null = null;

/** Listens to the core: inbox, focus, windows opened and closed, tabs dragged, shared files changed. */
export function startWindows() {
  if (!isTauri()) {
    started();
    return;
  }
  void listen<string>("celer://inbox", (target) => {
    if (target === windowLabel) scheduleDrain();
  });
  void listen<string>("celer://focus", (label) => {
    setFocusedWindow(label);
    if (!openWindows().some((w) => w.label === label)) void refreshWindows();
  });
  void listen<null>("celer://windows", () => void refreshWindows());
  void listen<{ active: boolean; source?: string; title?: string }>("celer://drag", (drag) =>
    setIncomingDrag(drag.active && drag.source && drag.source !== windowLabel && !panelKind ? { source: drag.source, title: drag.title ?? "" } : null),
  );
  void listen<{ name: string; value?: unknown; from: string }>("celer://shared", (change) => {
    if (change.from !== windowLabel) applyShared(change.name, change.value);
  });
  void refreshWindows();
  // Moving or resizing the window is part of the layout.
  void thisWindow().then(async (win) => {
    await win.onMoved(() => persistSoon());
    await win.onResized(() => persistSoon());
  });
  if (!panelKind) createRoot(mirrorEffects);
}

/**
 * Before the window is shown: where it goes on the screen (as it was when Celer closed, on a monitor that is still
 * there) and what it was opened with.
 */
export async function prepareWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    let geometry: WindowGeometry | null | undefined;
    if (windowLabel === "main") {
      layoutFile = await invoke<unknown>("window_layout_load").catch((err) => {
        layoutError = errorText(err);
        return null;
      });
      geometry = readLayout(layoutFile)[0]?.geometry;
    } else {
      startMessages = await invoke<Message[]>("window_inbox").catch(() => [] as Message[]);
      const restore = startMessages.find((m) => m.kind === "restore");
      geometry = (restore?.entry as SavedWindow | undefined)?.geometry;
    }
    if (geometry) await place(geometry);
  } catch {
    // Shown where the core put it.
  }
}

async function place(saved: WindowGeometry) {
  const screen = await invoke<Screen>("window_screen");
  const target = placeOnScreen(saved, screen.monitors);
  normal = { ...target, maximized: false };
  await invoke("window_place", { x: target.x, y: target.y, width: target.width, height: target.height, maximized: target.maximized });
}

/**
 * Called by boot() once settings and connections are in: this window's tabs. The main window takes the first window
 * of workspace.json and opens the others again; another window takes what it was opened with.
 */
export async function restoreWindowLayout(connectionsLoaded: boolean) {
  const known = (id: string | null) => !id || !connectionsLoaded || state.connections.some((conn) => conn.id === id);
  try {
    if (!isTauri()) {
      await restoreDemo(known);
      return;
    }
    if (windowLabel === "main") {
      if (layoutError) notify("No se pudieron restaurar las pestañas de la última sesión", "error", layoutError);
      const [first, ...rest] = readLayout(layoutFile);
      if (first) applyEntry(first, known);
      for (const entry of rest) {
        const kind = entry.kind === "panel" ? entry.panel : "full";
        if (!kind) continue;
        void invoke("window_open", { request: { kind, layout: entry, messages: [{ kind: "restore", entry, from: windowLabel }] } }).catch(() => {});
      }
    } else {
      for (const message of startMessages) await handle(message, known);
      startMessages = [];
      startPanel();
    }
  } finally {
    started();
  }
}

/** The browser demo: one window, its tabs in localStorage. */
let demoUnreadable = false;
async function restoreDemo(known: (id: string | null) => boolean) {
  try {
    const first = readLayout(await api().loadJson("workspace"))[0];
    if (first) applyEntry(first, known);
  } catch (err) {
    demoUnreadable = true;
    notify("No se pudieron restaurar las pestañas de la última sesión", "error", errorText(err));
  }
}

function applyEntry(entry: SavedWindow, known: (id: string | null) => boolean) {
  restoreTabs(entry.tabs as SavedTab[], entry.activeTabId, known);
  const ui: Partial<{ explorerOpen: boolean; inspectorOpen: boolean }> = {};
  if (entry.explorerOpen !== undefined) ui.explorerOpen = entry.explorerOpen;
  if (entry.inspectorOpen !== undefined) ui.inspectorOpen = entry.inspectorOpen;
  setState(ui);
  if (entry.inspectorMode && ["value", "record", "history", "library", "ai"].includes(entry.inspectorMode)) setState("inspectorMode", entry.inspectorMode as typeof state.inspectorMode);
}

// ---------------------------------------------------------------- saving the layout

/** This window's entry of workspace.json, with its place on the screen. */
async function entry(): Promise<SavedWindow<SavedTab>> {
  const saved: SavedWindow<SavedTab> = panelKind
    ? { kind: "panel", panel: panelKind, title: "", tabs: [], activeTabId: "" }
    : {
        kind: "full",
        title: activeTab()?.title ?? "",
        tabs: savedTabs(),
        activeTabId: state.activeTabId,
        explorerOpen: state.explorerOpen,
        inspectorOpen: state.inspectorOpen,
        inspectorMode: state.inspectorMode,
      };
  if (isTauri()) {
    const screen = await invoke<Screen>("window_screen").catch(() => null);
    if (screen) {
      if (!screen.maximized) normal = { x: screen.x, y: screen.y, width: screen.width, height: screen.height, maximized: false, monitor: screen.monitor, scale: screen.scale };
      saved.geometry = normal ? { ...normal, maximized: screen.maximized } : null;
    }
  }
  return saved;
}

/** Hands this window's part of workspace.json to the core, which writes the whole file (one writer). */
export async function saveWindowLayout(): Promise<void> {
  if (!isTauri()) {
    if (!demoUnreadable) await api().saveJson("workspace", composeLayout([await entry()], state.settings.sidebarWidth));
    return;
  }
  // Plans, diagrams and comparisons are not kept: they need the session that made them.
  if (panelKind && !SINGLE_PANELS.includes(panelKind)) return;
  await invoke("window_report", { entry: await entry() });
}

// ---------------------------------------------------------------- shared files

function applyShared(name: string, value: unknown) {
  if (name === "settings" && value && typeof value === "object") applySharedSettings(value as Partial<Settings>);
  else if (name === "library") applySharedLibrary(value);
  else if (name === "connections") void connectionsChanged();
}

/** Connections saved, moved or deleted in another window. A deleted one is disconnected here too. */
async function connectionsChanged() {
  await refreshConnections().catch(() => {});
  for (const id of Object.keys(state.sessions)) if (!connectionById(id)) void disconnect(id, false);
}

// ---------------------------------------------------------------- Gib

/** Gib is shown here (the full window with the focus, or the main one). */
export function gibHere(): boolean {
  if (!isTauri()) return true;
  return gibHost(focusedWindow(), openWindows().map((w) => w.label)) === windowLabel;
}

/** Something for Gib happened in a window without him: told to the window he is in. */
export function forwardGib(event: GibEvent) {
  const host = gibHost(focusedWindow(), openWindows().map((w) => w.label));
  if (host && host !== windowLabel) void post(host, { kind: "gib", event: clone(event) });
}

// ---------------------------------------------------------------- moving tabs

/** The pointer's spot for a new window opened from this one: down and right of it. */
async function cascadeAt(): Promise<[number, number] | null> {
  const screen = await invoke<Screen>("window_screen").catch(() => null);
  if (!screen) return null;
  const at = cascadeFrom({ x: screen.x, y: screen.y }, []);
  return [at.x, at.y];
}

/** A tab and what it needs on the other side: the password typed for its connection, if any. */
function tabMessage(tabs: Tab[], index: number | null): Message {
  const passwords: Record<string, string> = {};
  for (const tab of tabs) if (tab.connId && state.passwords[tab.connId]) passwords[tab.connId] = state.passwords[tab.connId];
  // The plain tabs behind the store, not a clone: the message is serialized once on its way, and a loaded result
  // can be up to a million rows.
  return { kind: "adopt", tabs: tabs.map(raw), index, passwords };
}

/** Rows a tab carries with it to another window (its results, pinned ones included, or a table's page). */
function loadedRows(tab: Tab): number {
  if (tab.kind === "table") return tab.rows.length;
  return [...tab.results, ...tab.pinned.map((pin) => pin.result)].reduce((sum, result) => sum + result.rows.length, 0);
}

/**
 * Moves a tab to another window (`target`) or to a new one (null; at `at`, physical pixels of the screen). Its
 * session is not touched: the other window shows it as it was.
 */
export async function sendTab(tabId: string, target: string | null, options: { at?: [number, number]; index?: number | null } = {}) {
  if (!isTauri() || panelKind || target === windowLabel) return;
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  const blocker = tabMoveBlocker(tab);
  if (blocker) {
    notify(blocker, "warning");
    return;
  }
  const rows = loadedRows(tab);
  if (rows > 100_000) notify(`Moviendo la pestaña con ${rows.toLocaleString()} filas cargadas: puede tardar unos segundos`, "info");
  const message = tabMessage([tab], options.index ?? null);
  let sent: boolean;
  if (target) {
    sent = await post(target, message);
    if (!sent) notify("Esa ventana ya no está abierta", "warning");
  } else {
    const at = options.at ?? (await cascadeAt());
    sent = await invoke<string>("window_open", { request: { kind: "full", messages: [{ ...message, from: windowLabel }], at } })
      .then(() => true)
      .catch((err) => {
        notify("No se pudo abrir la ventana", "error", errorText(err));
        return false;
      });
  }
  if (!sent) return;
  detachTab(tabId);
  // A window left without tabs closes, as a browser's does (never the main one).
  if (windowKind(windowLabel) === "full" && !state.tabs.length) await closeWindowNow();
}

/** Ctrl+Mayús+N: a new window with its own explorer and tabs, connected to what this one is connected to. */
export async function openNewWindow() {
  if (!isTauri()) {
    notify("Las ventanas nuevas son de la aplicación de escritorio", "info");
    return;
  }
  const at = await cascadeAt();
  const message: Message = { kind: "init", connect: Object.keys(state.sessions), passwords: clone(state.passwords), from: windowLabel };
  await invoke<string>("window_open", { request: { kind: "full", messages: [message], at } }).catch((err) => notify("No se pudo abrir la ventana", "error", errorText(err)));
}

/** Brings another window to the front. */
export async function raiseWindow(label: string) {
  if (isTauri()) await invoke("window_raise", { label }).catch(() => {});
}

async function focusSelf() {
  if (isTauri()) await thisWindow().then((win) => win.setFocus()).catch(() => {});
}

// ---- dragging a tab out of the tab bar

let dragging = "";

/** A tab starts to be dragged: the other windows' tab bars get ready to take it. */
export function startTabDrag(tabId: string, title: string) {
  if (!isTauri() || panelKind) return;
  dragging = tabId;
  void invoke("tab_drag_start", { tab: tabId, title }).catch(() => {});
}

/** The tab was dropped on this window's tab bar while it came from another window. */
export function claimTabDrop(index: number) {
  if (incomingDrag()) void invoke("tab_drag_claim", { index }).catch(() => {});
}

/**
 * The drag ended. Unless this window's own tab bar took it (`handled`), the tab goes to the window that took it or
 * that it was let go on, or to a new window where it was let go.
 */
export async function endTabDrag(tabId: string, handled: boolean) {
  if (!isTauri() || panelKind || dragging !== tabId) return;
  dragging = "";
  // The window it was dropped on claims it meanwhile (its drop event may come after this one).
  if (!handled) await sleep(180);
  const end = await invoke<{ claim: { label: string; index: number } | null; cursor: [number, number] | null; windows: WindowRect[] }>("tab_drag_end").catch(() => null);
  if (!end || handled) return;
  const where = dropTarget(windowLabel, end.cursor, end.windows, end.claim);
  if (where.kind === "window") await sendTab(tabId, where.label, { index: where.index });
  else if (where.kind === "new") await sendTab(tabId, null, { at: [where.x, where.y] });
}

// ---------------------------------------------------------------- messages from other windows

async function handle(message: Message, known: (id: string | null) => boolean = () => true) {
  switch (message.kind) {
    case "restore": {
      const saved = readLayout({ version: 2, windows: [message.entry] })[0];
      if (saved) applyEntry(saved, known);
      // A restored panel shows what it shows (the library reads the shared file, the assistant starts empty).
      break;
    }
    case "init": {
      takePasswords(message.passwords);
      const ids = Array.isArray(message.connect) ? message.connect.filter((id): id is string => typeof id === "string" && Boolean(connectionById(id))) : [];
      // One after another: the first one opens a console, the others join the explorer.
      void (async () => {
        for (const id of ids) await connect(id);
      })();
      break;
    }
    case "adopt":
      adopt(message);
      break;
    case "gib":
      if (message.event && typeof message.event === "object") setGibEvent({ ...(message.event as GibEvent), at: Date.now() });
      break;
    case "panel-action":
      await panelAction(String(message.action ?? ""), (message.args ?? {}) as Record<string, unknown>);
      break;
    case "panel-dock":
      undetach(message.from ?? "");
      dock(String(message.panel ?? ""), (message.data ?? {}) as Record<string, unknown>);
      void focusSelf();
      break;
    case "panel-closed":
      undetach(message.from ?? "");
      if (message.panel === "schema-compare") closeSchemaCompare();
      if (message.panel === "data-compare") closeDataCompare();
      break;
    case "panel-data":
      panelData(message);
      break;
    case "context":
      applyContext(message);
      break;
    case "context-request":
      contextSent.delete(message.from ?? "");
      setContextWanted((n) => n + 1);
      break;
    case "ask":
      await answer(message);
      break;
    case "answer": {
      const waiting = asked.get(String(message.id ?? ""));
      waiting?.(message.answer);
      break;
    }
  }
}

function takePasswords(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [id, password] of Object.entries(value as Record<string, unknown>)) {
    if (typeof password === "string" && password && !state.passwords[id]) setState("passwords", id, password);
  }
}

/** Tabs from another window, with their sessions; their connections join this window's explorer. */
function adopt(message: Message) {
  if (panelKind) return;
  takePasswords(message.passwords);
  const tabs = Array.isArray(message.tabs) ? (message.tabs as Tab[]).filter((tab) => tab && typeof tab.id === "string") : [];
  let index = typeof message.index === "number" ? message.index : null;
  for (const tab of tabs) {
    adoptTab(tab, index);
    if (index !== null) index++;
  }
  const ids = new Set(tabs.map((tab) => tab.connId).filter((id): id is string => Boolean(id)));
  for (const id of ids) if (!state.sessions[id] && !state.connecting[id] && connectionById(id)) void connect(id);
  if (tabs.length) void focusSelf();
}

// ---- asking every window (closing Celer)

const asked = new Map<string, (answer: unknown) => void>();

/** Asks every other full window `question`; their answers, or what came before `timeout`. */
async function askAll<T>(question: string, timeout = 1500): Promise<T[]> {
  await refreshWindows();
  const others = otherFullWindows();
  if (!others.length) return [];
  const id = uid();
  const answers: T[] = [];
  return new Promise<T[]>((resolve) => {
    const done = () => {
      asked.delete(id);
      resolve(answers);
    };
    const timer = window.setTimeout(done, timeout);
    asked.set(id, (value) => {
      answers.push(value as T);
      if (answers.length >= others.length) {
        window.clearTimeout(timer);
        done();
      }
    });
    for (const w of others) void post(w.label, { kind: "ask", question, id });
  });
}

interface WindowRisk {
  label: string;
  tx: number;
  edits: number;
}

function ownRisk(): WindowRisk {
  return {
    label: windowLabel,
    tx: state.tabs.filter((tab) => tab.kind === "sql" && tab.inTransaction).length,
    edits: state.tabs.filter((tab) => tab.kind === "table" && tableDirty(tab)).length,
  };
}

/** This window's consoles with an open transaction. */
const txTabIds = () => state.tabs.filter((tab) => tab.kind === "sql" && tab.inTransaction).map((tab) => tab.id);

async function answer(message: Message) {
  let value: unknown = null;
  if (message.question === "risk") value = ownRisk();
  // Quitting Celer: the user chose Commit or Rollback for every window's open transactions (confirmQuit).
  if (message.question === "tx-commit" || message.question === "tx-rollback") value = await endTransactions(txTabIds(), message.question === "tx-rollback");
  if (message.question === "flush") {
    await persistNow().catch(() => {});
    // The window that downloaded an update installs it as Celer closes.
    await installOnClose();
  }
  await post(message.from ?? "", { kind: "answer", id: message.id, answer: value });
}

// ---------------------------------------------------------------- closing

/** What each tab of this window would lose if the window closed without it. */
function tabRisks(): TabRisk[] {
  return state.tabs.map((tab): TabRisk => {
    if (tab.kind === "table") return { id: tab.id, kind: "table", transaction: false, edits: tableDirty(tab), text: false };
    const text = Boolean(tab.sql.trim()) && (tab.libraryId ? !scriptById(tab.libraryId) || libraryDirty(tab.libraryId) : !tab.filePath || fileDirty(tab));
    return { id: tab.id, kind: "sql", transaction: tab.inTransaction, edits: false, text };
  });
}

export interface WindowChoice {
  label: string;
  value: string;
  style?: "primary" | "danger";
}

/** A question with several answers (closing a window); "" when cancelled. */
const [windowAsk, setWindowAsk] = createStore({ current: null as { title: string; body: string; choices: WindowChoice[]; resolve: (value: string) => void } | null });
export { windowAsk };

export function askWindow(title: string, body: string, choices: WindowChoice[]): Promise<string> {
  windowAsk.current?.resolve("");
  return new Promise<string>((resolve) => setWindowAsk("current", { title, body, choices, resolve }));
}

export function answerWindow(value: string) {
  const current = windowAsk.current;
  setWindowAsk("current", null);
  current?.resolve(value);
}

let closing = false;

/** Forgets this window in the layout and closes it without asking again (its explorer's sessions too). */
async function closeWindowNow() {
  closing = true;
  await releaseWindowSessions();
  await invoke("window_forget").catch(() => {});
  await thisWindow().then((win) => win.destroy()).catch(() => {});
}

/**
 * The window is about to close (its button, Alt+F4, the taskbar). The last full window closes Celer as always; the
 * main one with others open asks whether to quit Celer or close only it; another window asks what to do with the
 * tabs that would lose work. False keeps it open.
 */
export async function windowCloseRequested(): Promise<boolean> {
  if (!isTauri()) return beforeClose();
  if (closing) return true;
  if (panelKind) {
    await panelClosing();
    return true;
  }
  await refreshWindows();
  const others = otherFullWindows();
  if (!others.length) {
    if (!(await beforeClose())) return false;
    await installOnClose();
    // Panels left alone would keep Celer running.
    if (openWindows().some((w) => !isFullWindow(w.label))) await invoke("window_quit").catch(() => {});
    return true;
  }
  if (windowLabel === "main") {
    const choice = await askWindow(
      "Cerrar la ventana principal",
      `Hay ${others.length === 1 ? "otra ventana" : `otras ${others.length} ventanas`} de Celer. Si sales de Celer, la próxima vez se abren todas como estaban.`,
      [
        { label: "Cerrar solo esta", value: "close" },
        { label: "Salir de Celer", value: "quit", style: "primary" },
      ],
    );
    if (choice === "quit") {
      void quitCeler();
      return false;
    }
    if (choice !== "close") return false;
  }
  if (!(await handOverTabs(others[0].label))) return false;
  await closeTabsQuietly(state.tabs.map((tab) => tab.id));
  await releaseWindowSessions();
  closing = true;
  await invoke("window_forget").catch(() => {});
  return true;
}

/** Before another window closes: its tabs that would lose work go to `target`, or are given up, or it stays. */
async function handOverTabs(target: string): Promise<boolean> {
  const risky = riskyTabs(tabRisks());
  if (!risky.length) return true;
  const tx = risky.some((tab) => tab.transaction);
  // Open transactions: Commit or Rollback here, or the consoles go on in the other window (never an implicit commit).
  const choice = await askWindow(
    `Cerrar ${windowName(windowLabel)}`,
    tx
      ? `Tiene ${riskSummary(risky)}. Puedes moverlas a ${windowName(target)}, con sus sesiones y transacciones como están; si no, elige qué hacer con las transacciones (lo demás se pierde).`
      : `Tiene ${riskSummary(risky)}. Puedes moverlas a ${windowName(target)}, con sus sesiones como están; si no, se pierden.`,
    tx
      ? [
          { label: "Commit y cerrar", value: "commit" },
          { label: "Rollback y cerrar", value: "discard", style: "danger" },
          { label: `Moverlas a ${windowName(target)}`, value: "move", style: "primary" },
        ]
      : [
          { label: "Cerrar y descartar", value: "discard", style: "danger" },
          { label: `Moverlas a ${windowName(target)}`, value: "move", style: "primary" },
        ],
  );
  if (choice === "commit" || choice === "discard") return endTransactions(txTabIds(), choice === "discard");
  if (choice !== "move") return false;
  const ids = new Set(risky.map((tab) => tab.id));
  const tabs = state.tabs.filter((tab) => ids.has(tab.id));
  const stuck = tabs.find((tab) => tabMoveBlocker(tab));
  if (stuck) {
    notify(tabMoveBlocker(stuck), "warning");
    return false;
  }
  if (!(await post(target, tabMessage(tabs, null)))) {
    notify(`No se pudieron mover: ${windowName(target)} ya no está abierta`, "error");
    return false;
  }
  for (const tab of tabs) detachTab(tab.id);
  return true;
}

/**
 * Before Celer ends with several windows open: open transactions and unsaved edits in any of them are confirmed,
 * then every window writes its part of the layout. With one window, as always (beforeClose). False: it goes on.
 */
export async function confirmQuit(): Promise<boolean> {
  if (!isTauri()) return beforeClose();
  await refreshWindows();
  if (!otherFullWindows().length) return beforeClose();
  const risks = [ownRisk(), ...(await askAll<WindowRisk | null>("risk")).filter((r): r is WindowRisk => Boolean(r))];
  const tx = risks.reduce((n, r) => n + r.tx, 0);
  const edits = risks.reduce((n, r) => n + r.edits, 0);
  if (tx) {
    // Only this window's: the same question as with one window.
    if (tx === risks[0].tx) {
      if (!(await settleTransactions(state.tabs, "salir de Celer"))) return false;
    } else {
      const where = risks.filter((r) => r.tx).map((r) => windowName(r.label));
      const choice = await askWindow(
        "¿Salir de Celer?",
        `Hay ${tx} ${tx === 1 ? "consola con una transacción abierta" : "consolas con transacciones abiertas"} en ${where.join(", ")}. Antes de salir, confírma${tx === 1 ? "la" : "las"} (Commit) o deshaz${tx === 1 ? "la" : "las"} (Rollback).`,
        [
          { label: "Commit en todas", value: "commit", style: "primary" },
          { label: "Rollback en todas", value: "rollback", style: "danger" },
        ],
      );
      if (choice !== "commit" && choice !== "rollback") return false;
      const rollback = choice === "rollback";
      const own = await endTransactions(txTabIds(), rollback);
      // A window that does not answer in time keeps its transactions, and Celer stays open.
      const answers = await askAll<boolean | null>(rollback ? "tx-rollback" : "tx-commit", 15000);
      if (!own || answers.length < risks.length - 1 || answers.some((ok) => ok !== true)) {
        notify("No se pudieron cerrar todas las transacciones: Celer sigue abierto", "error");
        return false;
      }
    }
  }
  if (edits) {
    const where = risks.filter((r) => r.edits).map((r) => windowName(r.label));
    const ok = await confirmDialog("¿Salir de Celer?", `Hay ${edits} ${edits === 1 ? "tabla con cambios sin guardar" : "tablas con cambios sin guardar"} en ${where.join(", ")}.`, "Salir de todos modos", true);
    if (!ok) return false;
  }
  await Promise.all([persistNow().catch(() => {}), askAll("flush", 2000)]);
  return true;
}

/** "Salir de Celer": closes every window and remembers them all for the next start (closing them one by one forgets each). */
export async function quitCeler() {
  if (!isTauri() || !(await confirmQuit())) return;
  await installOnClose();
  await invoke("window_quit").catch(() => {});
}

// ---------------------------------------------------------------- panels in their own window

/** Owned panels on show in other windows: their label, what they show and the console they belong to. */
interface Detached {
  label: string;
  kind: PanelKind;
  tabId?: string;
}

const [detached, setDetached] = createStore({ list: [] as Detached[] });

/** That panel of this window is in a window of its own (the docked one is not shown). */
export function isDetached(kind: PanelKind): boolean {
  return detached.list.some((d) => d.kind === kind && openWindows().some((w) => w.label === d.label));
}

function undetach(label: string) {
  if (label) setDetached("list", (list) => list.filter((d) => d.label !== label));
}

/** The library's or the assistant's own window, when open: brought to the front (true). */
export function raisePanel(kind: "library" | "ai"): boolean {
  if (panelKind === kind) return true;
  if (!openWindows().some((w) => w.label === `panel-${kind}`)) return false;
  void raiseWindow(`panel-${kind}`);
  return true;
}

/** Where a panel's window opens: over the right side of this window. */
async function panelAt(kind: PanelKind): Promise<[number, number] | null> {
  const screen = await invoke<Screen>("window_screen").catch(() => null);
  if (!screen) return null;
  const narrow = kind === "library" || kind === "ai";
  return narrow ? [screen.x + Math.max(0, screen.width - Math.round(460 * screen.scale)), screen.y + Math.round(60 * screen.scale)] : [screen.x + Math.round(80 * screen.scale), screen.y + Math.round(80 * screen.scale)];
}

/** A panel goes to a window of its own: the library, the assistant, a plan, the E-R diagram or a comparison. */
export async function detachPanel(kind: PanelKind) {
  if (!isTauri()) {
    notify("Las ventanas aparte son de la aplicación de escritorio", "info");
    return;
  }
  if (panelKind) return;
  let data: Message | null = null;
  let tabId: string | undefined;
  let hide = () => {};
  switch (kind) {
    case "library":
      hide = () => state.inspectorMode === "library" && setState("inspectorOpen", false);
      break;
    case "ai":
      if (state.ai.running) {
        notify("Espera a que el asistente termine de responder", "warning");
        return;
      }
      // The conversation goes with it.
      data = { kind: "panel-data", ai: clone(state.ai.messages) };
      hide = () => {
        setState("ai", "messages", []);
        if (state.inspectorMode === "ai") setState("inspectorOpen", false);
      };
      break;
    case "plan": {
      const tab = activeSql();
      if (!tab?.plan) {
        notify("La consola no tiene un plan de ejecución (Ctrl+Mayús+E)", "info");
        return;
      }
      tabId = tab.id;
      data = { kind: "panel-data", tab: clone(tab) };
      hide = () => patchTab(tab.id, { activePlan: false });
      break;
    }
    case "er":
      if (!state.er || state.er.loading) {
        notify(state.er ? "Espera a que el diagrama termine de cargar" : "No hay un diagrama abierto", "info");
        return;
      }
      data = { kind: "panel-data", er: clone(state.er) };
      hide = closeErDiagram;
      break;
    case "compare": {
      const tab = activeSql();
      if (!tab?.compare) {
        notify("No hay una comparación de resultados abierta", "info");
        return;
      }
      tabId = tab.id;
      data = { kind: "panel-data", tab: clone(tab) };
      hide = () => closeCompare(tab.id);
      break;
    }
    case "schema-compare":
      if (!schemaCompare.open) return;
      data = { kind: "panel-data", store: clone(schemaCompare) };
      break;
    case "data-compare":
      if (!dataCompare.open) return;
      data = { kind: "panel-data", store: clone(dataCompare) };
      break;
  }
  const at = await panelAt(kind);
  const label = await invoke<string>("window_open", { request: { kind, messages: data ? [{ ...data, from: windowLabel }] : [], at } }).catch((err) => {
    notify("No se pudo abrir la ventana", "error", errorText(err));
    return "";
  });
  if (!label) return;
  hide();
  if (!SINGLE_PANELS.includes(kind)) setDetached("list", (list) => [...list.filter((d) => d.label !== label), { label, kind, tabId }]);
  void refreshWindows();
}

/** The detachable panel on show in this window ("Abrir en su propia ventana" in the palette): the topmost one. */
export function detachablePanel(): PanelKind | null {
  if (panelKind) return null;
  if (schemaCompare.open && !isDetached("schema-compare")) return "schema-compare";
  if (dataCompare.open && !isDetached("data-compare")) return "data-compare";
  if (state.er && !state.er.loading) return "er";
  const tab = activeSql();
  if (tab?.compare) return "compare";
  if (tab?.plan && tab.activePlan) return "plan";
  if (state.inspectorOpen && (state.inspectorMode === "library" || state.inspectorMode === "ai")) return state.inspectorMode;
  return null;
}

/** A panel comes back from its window ("Acoplar"). */
function dock(kind: string, data: Record<string, unknown>) {
  const tabId = typeof data.tabId === "string" ? data.tabId : "";
  const tab = state.tabs.find((item) => item.id === tabId);
  switch (kind) {
    case "library":
      openInspector("library", true);
      break;
    case "ai":
      if (Array.isArray(data.messages) && !state.ai.running) setState("ai", "messages", data.messages as AiMessage[]);
      openInspector("ai", true);
      break;
    case "plan":
      if (tab?.kind === "sql" && tab.plan) showPlan(tab.id);
      break;
    case "er":
      if (data.er && typeof data.er === "object") setState("er", data.er as ErState);
      break;
    case "compare":
      if (tab?.kind === "sql" && typeof data.pinId === "string" && tab.pinned.some((pin) => pin.id === data.pinId)) {
        compareWithCurrent(tab.id, data.pinId);
        if (Array.isArray(data.key) || data.key === null) setCompareKey(tab.id, data.key as string[] | null);
      }
      break;
  }
}

/** What a panel window asks its window to do (see forwardFromPanel). */
async function panelAction(action: string, args: Record<string, unknown>) {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (action) {
    case "insert":
      insertIntoActive(text("text"));
      break;
    case "replace":
      replaceActiveSql(text("sql"));
      break;
    case "run-text":
      await runText(text("sql"));
      break;
    case "library-open":
      await openLibraryScript(text("id"), args.run === true);
      void focusSelf();
      break;
    case "library-insert":
      insertLibraryScript(text("id"));
      break;
    case "library-save":
      await saveToLibrary(args.asNew === true, typeof args.folder === "string" ? args.folder : undefined);
      void focusSelf();
      break;
    case "library-revert":
      revertConsole(text("id"));
      break;
    case "open-table":
      if (text("connId") && args.obj && typeof args.obj === "object") {
        await openTable(text("connId"), args.obj as ObjectRef, (text("section") || "data") as TableTab["section"], Array.isArray(args.filters) ? (args.filters as ColumnFilter[]) : []);
        void focusSelf();
      }
      break;
    case "plan-explain":
      await explainStatement(text("tabId"), text("sql"), args.analyze === true);
      break;
    case "schema-swap":
      swapCompare();
      break;
    case "schema-script":
      openSyncScript();
      void focusSelf();
      break;
    case "data-swap":
      swapDataCompare();
      break;
    case "data-script":
      openDataSyncScript();
      void focusSelf();
      break;
  }
}

/** The window a panel works for: the one it came from, or the last focused one for the library and the assistant. */
const [panelOwner, setPanelOwner] = createSignal("");

function panelTarget(): string {
  const focused = focusedWindow();
  const owner = panelOwner();
  if (panelKind && !SINGLE_PANELS.includes(panelKind) && owner && openWindows().some((w) => w.label === owner)) return owner;
  if (focused && isFullWindow(focused) && openWindows().some((w) => w.label === focused)) return focused;
  return otherFullWindows()[0]?.label ?? "main";
}

/**
 * In a panel window, `action` needs a console or a connection: the window it works for does it (true: sent, the
 * caller does nothing else). False in a full window.
 */
export function forwardFromPanel(action: string, args: Record<string, unknown> = {}): boolean {
  if (!panelKind) return false;
  void post(panelTarget(), { kind: "panel-action", action, args: clone(args) }).then((ok) => {
    if (!ok) notify("La ventana de Celer de este panel ya no está abierta", "warning");
  });
  return true;
}

const [panelReady, setPanelReady] = createSignal(false);
export { panelReady };

/** What a panel window shows, sent by its window (and again when it changes). */
function panelData(message: Message) {
  if (!panelKind) return;
  if (message.from && !SINGLE_PANELS.includes(panelKind)) setPanelOwner(message.from);
  if (message.tab && typeof message.tab === "object") {
    const tab = message.tab as Tab;
    setState("tabs", [tab]);
    setState("activeTabId", tab.id);
  }
  if (message.er && typeof message.er === "object") setState("er", message.er as ErState);
  if (message.store && typeof message.store === "object") {
    if (panelKind === "schema-compare") setSchemaCompare(message.store as Partial<typeof schemaCompare>);
    if (panelKind === "data-compare") setDataCompare(message.store as Partial<typeof dataCompare>);
  }
  if (Array.isArray(message.ai)) setState("ai", "messages", message.ai as AiMessage[]);
  setPanelReady(true);
}

/** The panel window starts: the library reads the shared file; the others wait for what their window sends. */
export function startPanel() {
  if (!panelKind) return;
  if (panelKind === "library") void loadLibrary();
  if (SINGLE_PANELS.includes(panelKind)) {
    setPanelReady(true);
    void post(panelTarget(), { kind: "context-request" });
  }
}

/** "Acoplar": the panel goes back to its window, which shows it again. */
export async function dockPanel() {
  if (!panelKind) return;
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  const data: Record<string, unknown> = {};
  if (panelKind === "ai") data.messages = clone(state.ai.messages);
  if (panelKind === "er" && state.er) data.er = clone(state.er);
  if (tab?.kind === "sql") {
    data.tabId = tab.id;
    if (tab.compare) {
      data.pinId = tab.compare.pinId;
      data.key = clone(tab.compare.key);
    }
  }
  await post(panelTarget(), { kind: "panel-dock", panel: panelKind, data });
  await closeWindowNow();
}

/** The panel window closes (its button, or its content was closed): its window shows it docked again if it can. */
async function panelClosing() {
  closing = true;
  await post(panelTarget(), { kind: "panel-closed", panel: panelKind });
  await invoke("window_forget").catch(() => {});
}

/** Its content was closed (the diagram's ×, Esc, a comparison closed): the panel window closes too. */
export async function closePanelWindow() {
  if (closing) return;
  await panelClosing();
  await thisWindow().then((win) => win.destroy()).catch(() => {});
}

// ---- the window a panel works for keeps it up to date

/** Bumped when a library or assistant window asks for the active console again. */
const [contextWanted, setContextWanted] = createSignal(0);
/** What completion was last sent to each panel window (sent again only when it changes). */
const contextSent = new Map<string, string>();
const pushTimers = new Map<string, number>();

/** Sends `make()` to `label` a moment later (a burst of changes sends once); a window that is gone is forgotten. */
function pushSoon(label: string, make: () => Message, ms = 220) {
  window.clearTimeout(pushTimers.get(label));
  pushTimers.set(
    label,
    window.setTimeout(() => {
      pushTimers.delete(label);
      void post(label, make()).then((ok) => ok || undetach(label));
    }, ms),
  );
}

/** The parts of a console a library or assistant window needs. */
function contextTab(tab: SqlTab) {
  return { id: tab.id, kind: "sql" as const, title: tab.title, connId: tab.connId, database: tab.database, serverInfo: tab.serverInfo, sql: tab.sql, cursor: tab.cursor, selection: tab.selection, error: tab.error, libraryId: tab.libraryId };
}

function mirrorEffects() {
  // A new plan of a console whose plan is in a window of its own goes there too.
  createEffect(() => {
    for (const d of detached.list) {
      if (d.kind !== "plan") continue;
      const tab = state.tabs.find((item) => item.id === d.tabId);
      if (tab?.kind !== "sql" || !tab.plan) continue;
      void tab.plan;
      untrack(() => pushSoon(d.label, () => ({ kind: "panel-data", tab: clone(state.tabs.find((item) => item.id === d.tabId) ?? null) })));
    }
  });
  // Comparisons of schemas and data: their progress and their result, also after "Intercambiar".
  createEffect(() => {
    const d = detached.list.find((item) => item.kind === "schema-compare");
    if (!d) return;
    JSON.stringify(schemaCompare);
    untrack(() => pushSoon(d.label, () => ({ kind: "panel-data", store: clone(schemaCompare) })));
  });
  createEffect(() => {
    const d = detached.list.find((item) => item.kind === "data-compare");
    if (!d) return;
    JSON.stringify(dataCompare);
    untrack(() => pushSoon(d.label, () => ({ kind: "panel-data", store: clone(dataCompare) })));
  });
  // The library and the assistant work with the active console of the last focused window: that window sends it.
  // Focused again after another window: the panels have that one's completion now, so everything goes again.
  let wasFocused = false;
  createEffect(() => {
    contextWanted();
    if (focusedWindow() !== windowLabel) {
      wasFocused = false;
      return;
    }
    if (!wasFocused) contextSent.clear();
    wasFocused = true;
    const targets: string[] = openWindows()
      .map((w) => w.label)
      .filter((label) => label === "panel-ai" || label === "panel-library");
    for (const label of [...contextSent.keys()]) if (!targets.includes(label)) contextSent.delete(label);
    if (!targets.length) return;
    const tab = activeSql();
    const consoles = state.tabs.filter((item): item is SqlTab => item.kind === "sql" && (item.id === tab?.id || Boolean(item.libraryId)));
    const tabs = consoles.map(contextTab);
    const completion = tab?.completion ?? null;
    const catalog = tab?.connId ? (state.catalog[tab.connId] ?? null) : null;
    const key = tab ? `${tab.id}|${tab.connId}|${tab.database}|${completion?.tables.length ?? -1}|${catalog?.tables.length ?? -1}` : "";
    untrack(() => {
      for (const label of targets) {
        pushSoon(label, () => {
          const message: Message = { kind: "context", tabs, activeTabId: tab?.id ?? "" };
          if (contextSent.get(label) !== key) {
            contextSent.set(label, key);
            message.completion = clone(completion);
            message.catalog = tab?.connId && catalog ? { connId: tab.connId, value: clone(catalog) } : null;
          }
          return message;
        });
      }
    });
  });
}

/** A library or assistant window: the consoles of the window it works for, as if they were its own. */
function applyContext(message: Message) {
  if (!panelKind) return;
  const incoming = Array.isArray(message.tabs) ? (message.tabs as ReturnType<typeof contextTab>[]) : [];
  const activeId = typeof message.activeTabId === "string" ? message.activeTabId : "";
  const tabs = incoming.map((t): SqlTab => {
    const before = state.tabs.find((item) => item.id === t.id);
    const keep = before?.kind === "sql" && before.connId === t.connId && before.database === t.database ? before.completion : null;
    const completion = t.id === activeId && "completion" in message ? ((message.completion as CompletionSchema | null) ?? null) : keep;
    return { ...blankSql(t.id), ...t, completion };
  });
  setState("tabs", tabs);
  setState("activeTabId", activeId);
  const catalog = message.catalog as { connId: string; value: { database: string; tables: CompletionSchema["tables"] } } | null | undefined;
  if (catalog?.connId && catalog.value) setState("catalog", catalog.connId, catalog.value);
}
