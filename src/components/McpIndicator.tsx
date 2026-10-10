import { Plug, RefreshCw, Settings2, Sparkles, TriangleAlert } from "lucide-solid";
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "../api";
import { actsInApp, clientText, mcpLabel, mcpPlaces, mcpTooltip, staleClients, timeAgo, toolLabel } from "../mcpModel";
import { mcpStatus, refreshMcpStatus, startMcpStatus } from "../mcpStatus";
import { setState } from "../state";
import type { McpStatus } from "../types";

const ACTIVITY = 30;

/**
 * The status bar's MCP indicator: «MCP · Windows + WSL (Ubuntu)» while the MCP server is on (hidden when it is off),
 * with the clients and the last call in its tooltip. A click shows «Actividad de la IA»: the last calls of the audit
 * log, and the way to Settings › IA y MCP.
 */
export function McpIndicator() {
  const [open, setOpen] = createSignal(false);
  let wrap: HTMLSpanElement | undefined;
  onMount(startMcpStatus);
  const status = () => {
    const s = mcpStatus();
    return s?.enabled ? s : null;
  };
  return (
    <Show when={status()}>
      {(s) => (
        <span class="st-mcp-wrap" ref={wrap}>
          <button
            type="button"
            class="st-mcp"
            classList={{ stale: staleClients(s()).length > 0, idle: !s().clients.length, open: open() }}
            title={open() ? "" : mcpTooltip(s(), Date.now(), "Clic: actividad de la IA y ajustes")}
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
          >
            <Show when={staleClients(s()).length} fallback={<Plug size={12} />}><TriangleAlert size={12} /></Show>
            <span>{mcpLabel(s())}</span>
          </button>
          <Show when={open()}>
            <McpActivity status={s()} close={() => setOpen(false)} inside={(node) => Boolean(wrap?.contains(node))} />
          </Show>
        </span>
      )}
    </Show>
  );
}

/** «Actividad de la IA»: the last calls (from mcp-audit.jsonl), newest first. */
function McpActivity(props: { status: McpStatus; close: () => void; inside: (node: Node) => boolean }) {
  const [entries, { refetch }] = createResource(() => api().mcpAudit(ACTIVITY).catch(() => []));
  const now = Date.now();
  onMount(() => {
    const down = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !props.inside(event.target)) props.close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.close();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    });
  });
  const settings = () => {
    props.close();
    setState({ settingsOpen: true, settingsSection: "ai" });
  };
  return (
    <div class="mcp-pop" role="dialog" aria-label="Actividad de la IA">
      <header>
        <Sparkles size={13} />
        <b>Actividad de la IA</b>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Actualizar" onClick={() => { void refetch(); void refreshMcpStatus(); }}><RefreshCw size={12} /></button>
      </header>
      <p class="mcp-pop-note">
        {mcpPlaces(props.status) ? `Clientes: ${mcpPlaces(props.status)}` : "Ningún cliente registrado todavía"}
        {props.status.appControl ? " · puede controlar la aplicación" : ""}
      </p>
      <For each={staleClients(props.status)}>{(stale) => <p class="mcp-pop-note mcp-stale"><TriangleAlert size={12} /> {stale} usa otra ruta de Celer: vuelve a registrarlo</p>}</For>
      <div class="mcp-pop-list">
        <For each={entries() ?? []} fallback={<p class="mcp-pop-note">{entries.loading ? "Cargando…" : "Sin actividad todavía."}</p>}>
          {(entry) => (
            <div class="mcp-act" classList={{ bad: !entry.ok, "mcp-act-app": actsInApp(entry.tool) }} title={`${new Date(entry.at).toLocaleString()}\n${entry.tool}${entry.error ? `\n${entry.error}` : entry.detail ? `\n${entry.detail}` : ""}`}>
              <div class="mcp-act-head">
                <b>{toolLabel(entry)}</b>
                <Show when={entry.connName}><span>{entry.connName}</span></Show>
                <span class="spacer" />
                <time>{timeAgo(entry.at, now)}</time>
              </div>
              <Show when={entry.error || entry.detail}><code>{entry.ok ? entry.detail : `Rechazado: ${entry.error}`}</code></Show>
              <Show when={clientText(entry)}><small>{clientText(entry)}</small></Show>
            </div>
          )}
        </For>
      </div>
      <footer>
        <button type="button" class="btn tiny" onClick={settings}><Settings2 size={12} /> Ajustes › IA y MCP</button>
      </footer>
    </div>
  );
}
