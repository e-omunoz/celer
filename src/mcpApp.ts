// What an assistant asks this window to do through MCP («Controlar la aplicación», #100). The MCP process
// (src-tauri/src/mcp.rs) has already checked the switches, the connection's level, the read filter and the masking,
// and written the audit entry; the core (mcp_app.rs, windows.rs) brings the request to the last focused full window.
// Here it is done the way the user would do it, and said: a tab the AI opens carries a badge («Abierto por la IA ·
// hace N min») and a short highlight, and a notice says what was opened and where, with «Ir». Nothing takes the
// focus: while the user is typing the tab opens in the background, and a window in the background gets its taskbar
// button flashed by the core.
import { createSignal } from "solid-js";
import { api, errorText } from "./api";
import { addLibraryScriptFromAi, revealLibraryScript } from "./library";
import { aiTabTitle, isTyping } from "./mcpModel";
import { refreshMcpStatus } from "./mcpStatus";
import { connectionById, erSchemaPath, notify, openErDiagram, openQuery, openTable, patchTab, runActive, selectTab, state, type TableTab } from "./state";
import type { ObjectRef } from "./types";
import { windowName } from "./windowModel";
import { focusThisWindow, windowLabel } from "./windows";

let lastKey = 0;
const [clock, setClock] = createSignal(Date.now());
let started = false;

/** Notes the user's typing (to open in the background meanwhile) and keeps the badges' «hace N min» current. */
export function startMcpApp() {
  if (started) return;
  started = true;
  window.addEventListener("keydown", () => (lastKey = Date.now()), true);
  window.setInterval(() => setClock(Date.now()), 30_000);
}

function typing(): boolean {
  return isTyping(lastKey, Date.now(), document.hasFocus());
}

/** The badge's tooltip for a tab an assistant opened. */
export function aiBadgeTitle(tab: { aiOpenedAt?: number; aiClient?: string }): string {
  return tab.aiOpenedAt ? aiTabTitle(tab.aiOpenedAt, clock(), tab.aiClient) : "";
}

/** A request from the core's inbox: done, and answered (also when it fails, with the reason). */
export async function handleMcpRequest(message: Record<string, unknown>) {
  const id = typeof message.id === "string" ? message.id : "";
  const action = typeof message.action === "string" ? message.action : "";
  const args = message.args && typeof message.args === "object" ? (message.args as Record<string, unknown>) : {};
  const client = typeof message.client === "string" ? message.client : "";
  try {
    const result = await act(action, args, client);
    await api().mcpAppReply(id, true, result);
  } catch (err) {
    await api().mcpAppReply(id, false, null, errorText(err)).catch(() => false);
  }
  void refreshMcpStatus();
}

function mark(tabId: string, client: string) {
  patchTab(tabId, { aiOpenedAt: Date.now(), aiClient: client || undefined });
}

/** «La IA ha abierto la consola «ventas» en la ventana principal», with «Ir». */
function announce(what: string, tabId: string, background: boolean, client: string) {
  const detail = [background ? "En segundo plano: estabas escribiendo" : "", client].filter(Boolean).join(" · ");
  notify(`La IA ha abierto ${what} en ${windowName(windowLabel)}`, "info", detail || undefined, {
    label: "Ir",
    run: () => {
      if (state.tabs.some((tab) => tab.id === tabId)) selectTab(tabId);
      void focusThisWindow();
    },
  });
}

function where() {
  return { window: windowLabel, windowName: windowName(windowLabel) };
}

async function act(action: string, args: Record<string, unknown>, client: string): Promise<unknown> {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const connId = text("connId");
  if (connId && !connectionById(connId)) throw new Error("Esa conexión ya no existe en Celer");
  switch (action) {
    case "open_console": {
      const background = typing();
      const sql = text("sql");
      const tabId = openQuery(connId || null, sql, text("title") || undefined, { background, database: text("database") || undefined });
      mark(tabId, client);
      const title = state.tabs.find((tab) => tab.id === tabId)?.title ?? "";
      announce(`la consola «${title}»`, tabId, background, client);
      const out: Record<string, unknown> = { ...where(), tabId, title, background };
      if (args.run === true) Object.assign(out, await runIn(tabId, sql));
      return out;
    }
    case "open_table": {
      const obj = args.obj as ObjectRef | undefined;
      if (!connId || !obj?.name) throw new Error("Falta la tabla");
      const background = typing();
      const section = (["data", "columns", "indexes", "keys", "ddl"].includes(text("section")) ? text("section") : "data") as TableTab["section"];
      const query = section === "data" ? { where: text("where"), orderBy: text("orderBy") } : {};
      const tabId = await openTable(connId, obj, section, [], { background, ...query });
      if (!tabId) throw new Error(`No se pudo abrir «${obj.name}»`);
      mark(tabId, client);
      const tab = state.tabs.find((item) => item.id === tabId);
      announce(`${section === "data" ? "la tabla" : "la definición de"} «${obj.name}»`, tabId, background, client);
      return { ...where(), tabId, title: tab?.title ?? obj.name, background, ...(tab?.kind === "table" && tab.error ? { error: tab.error } : {}) };
    }
    case "open_er_diagram": {
      if (!connId) throw new Error("Falta la conexión");
      const obj = (args.obj as ObjectRef | null) ?? undefined;
      const database = text("database");
      const path = erSchemaPath(connId, obj ?? { database, schema: text("schema"), name: "", kind: "table" }, database);
      const what = obj ? `el diagrama de relaciones de «${obj.name}»` : `el diagrama E-R de «${path.filter((part, i) => part !== path[i - 1]).join(" · ")}»`;
      if (typing()) {
        // A diagram covers the workspace: offered, not opened, while the user types.
        notify(`La IA quiere mostrarte ${what}`, "info", client || undefined, { label: "Abrir", run: () => void openErDiagram(connId, path, obj) });
        return { ...where(), opened: false, offered: true, reason: "El usuario estaba escribiendo: se le ha ofrecido abrirlo con un aviso" };
      }
      const loading = openErDiagram(connId, path, obj);
      notify(`La IA ha abierto ${what} en ${windowName(windowLabel)}`, "info", client || undefined, { label: "Ir", run: () => void focusThisWindow() });
      await loading;
      return { ...where(), opened: true, ...(state.er?.error ? { error: state.er.error } : { tables: state.er?.tables.length ?? 0 }) };
    }
    case "add_library_script": {
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const script = await addLibraryScriptFromAi({ name: text("name"), sql: text("sql"), folder: text("folder"), tags, notes: text("notes"), connId: connId || null }, client);
      notify(`La IA ha añadido «${script.name}» a la biblioteca`, "success", client || undefined, { label: "Ver", run: () => revealLibraryScript(script.id) });
      return { id: script.id, name: script.name, folder: script.folder };
    }
    default:
      throw new Error(`Celer no sabe hacer «${action}»`);
  }
}

/** Runs a console's SQL the way «Ejecutar» does (confirmations on production included) and says how it went. */
async function runIn(tabId: string, sql: string): Promise<Record<string, unknown>> {
  const before = state.tabs.find((tab) => tab.id === tabId);
  const outputs = before?.kind === "sql" ? before.output.length : 0;
  await runActive("script", sql, tabId);
  const tab = state.tabs.find((item) => item.id === tabId);
  if (tab?.kind !== "sql") return { ran: false, reason: "La consola se cerró" };
  const last = tab.output.length > outputs ? tab.output[tab.output.length - 1] : null;
  if (!last) return { ran: false, reason: "No se ejecutó (el usuario no lo confirmó o la consola estaba ocupada)" };
  return { ran: true, ok: last.ok, summary: last.text.split("\n")[0] };
}
