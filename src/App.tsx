import { onMount, Show } from "solid-js";
import { Modals } from "./components/Modals";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { Companion } from "./gib/Companion";
import { Mark } from "./brand/Mark";
import { isTauri } from "./api";
import {
  activeTab,
  boot,
  cancelActive,
  commitActive,
  connect,
  connectionById,
  formatActive,
  openConnDialog,
  openQuery,
  refreshHistory,
  runActive,
  saveSettings,
  setState,
  state,
  switchDatabase,
} from "./state";

export default function App() {
  onMount(() => void boot());
  const tab = () => activeTab();
  const sqlTab = () => {
    const current = tab();
    return current?.kind === "sql" ? current : undefined;
  };
  const session = () => {
    const connId = tab()?.connId;
    return connId ? state.sessions[connId] : undefined;
  };

  return (
    <div class="app">
      <header class="toolbar">
        <div class="brand"><Mark /><span>Celer</span></div>
        <Show when={connectionById(tab()?.connId)?.production}><span class="pill prod">PROD</span></Show>
        <button type="button" class="btn" title="Nueva conexión" onClick={() => openConnDialog()}>Conexión</button>
        <button type="button" class="btn" title="Nueva consulta" onClick={() => openQuery(session() ? tab()?.connId ?? null : null)}>Consulta</button>
        <span class="sep" />
        <button type="button" class="btn run" title="Ejecutar sentencia (Ctrl+Enter)" onClick={() => void runActive("statement")}>Ejecutar</button>
        <button type="button" class="btn" title="Ejecutar script (Alt+X)" onClick={() => void runActive("script")}>Script</button>
        <button type="button" class="btn" title="Cancelar" onClick={() => void cancelActive()} disabled={!sqlTab()?.running}>Cancelar</button>
        <button type="button" class="btn" title="Formatear SQL" onClick={formatActive}>Formatear</button>
        <span class="sep" />
        <button type="button" class="btn" disabled={!sqlTab()?.inTransaction} onClick={() => void commitActive(false)}>Commit</button>
        <button type="button" class="btn" disabled={!sqlTab()?.inTransaction} onClick={() => void commitActive(true)}>Rollback</button>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => { const open = !state.historyOpen; setState("historyOpen", open); if (open) void refreshHistory(); }}>Historial</button>
        <button type="button" class="btn" onClick={() => void cycleTheme()}>{themeLabel()}</button>
        <button type="button" class="btn" onClick={() => setState("settingsOpen", true)}>Ajustes</button>
      </header>
      <div class="body">
        <Sidebar />
        <div class="splitter" onMouseDown={resizeSidebar} />
        <Workspace />
      </div>
      <footer class="status">
        <span>{isTauri() ? "Escritorio" : "Navegador"}</span>
        <Show when={session()} fallback={<span>Sin conexión</span>}>
          <span>{session()!.serverInfo}</span>
          <label>
            Base
            <select value={session()!.database} onChange={(event) => void switchDatabase(event.currentTarget.value)}>
              <ForDatabases names={session()!.databases} current={session()!.database} />
            </select>
          </label>
        </Show>
        <Show when={sqlTab()?.elapsedMs !== null && sqlTab()?.elapsedMs !== undefined}>
          <span>{sqlTab()?.elapsedMs} ms</span>
        </Show>
        <Show when={sqlTab()?.inTransaction}><span class="pill warn">transacción</span></Show>
        <span class="spacer" />
        <Show when={tab()?.connId && !state.sessions[tab()!.connId!]}>
          <button type="button" class="btn tiny" onClick={() => void connect(tab()!.connId!)}>Conectar</button>
        </Show>
        <span>v{state.appInfo.version || "…"}</span>
        <Companion />
      </footer>
      <Show when={state.toast}><div class="toast" onClick={() => setState("toast", "")}>{state.toast}</div></Show>
      <Modals />
    </div>
  );
}

function ForDatabases(props: { names: string[]; current: string }) {
  const names = () => (props.names.length ? props.names : props.current ? [props.current] : []);
  return names().map((name) => <option value={name}>{name}</option>);
}

function themeLabel() {
  const labels: Record<string, string> = {
    dark: "Oscuro",
    light: "Claro",
    contrast: "Contraste",
    "contrast-light": "Contraste claro",
    fjord: "Fjord",
    sand: "Sand",
    system: "Sistema",
  };
  return labels[state.settings.theme] ?? "Tema";
}

async function cycleTheme() {
  const order = ["dark", "light", "contrast", "contrast-light", "fjord", "sand", "system"] as const;
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  await saveSettings({ theme: next });
}

function resizeSidebar(event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startW = state.settings.sidebarWidth;
  const move = (ev: MouseEvent) => setState("settings", "sidebarWidth", Math.min(560, Math.max(200, startW + ev.clientX - startX)));
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    void saveSettings({ sidebarWidth: state.settings.sidebarWidth });
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
