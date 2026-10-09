import { CircleCheck, Copy, RefreshCw, ShieldCheck, Terminal, Trash2, TriangleAlert } from "lucide-solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { AI_MODELS, refreshAiKeyStatus, saveAiKey } from "../ai";
import { api, errorText, isTauri } from "../api";
import { EngineIcon } from "../icons";
import { refreshMcpStatus } from "../mcpStatus";
import { confirmDialog, copyText, notify, openInspector, saveSettings, serverOf, setState, state } from "../state";
import type { McpConfig, McpLevel, WslDistro, WslInfo } from "../types";

const LEVELS: { id: McpLevel; label: string; hint: string }[] = [
  { id: "none", label: "Sin acceso", hint: "La IA no ve esta conexión" },
  { id: "schema", label: "Solo esquema", hint: "Tablas, columnas y DDL; ninguna fila" },
  { id: "read", label: "Lectura", hint: "Esquema y consultas SELECT con límite de filas" },
  { id: "write", label: "Lectura y escritura", hint: "También INSERT/UPDATE/DELETE; úsalo con cuidado" },
];

export function AiSettings() {
  const [config, { mutate, refetch }] = createResource(() => api().mcpConfigGet().catch(() => null));
  const [client] = createResource(() => api().mcpClientInfo().catch(() => null));
  const [audit, { refetch: refetchAudit }] = createResource(() => api().mcpAudit(60).catch(() => []));
  const [preview, setPreview] = createSignal("");
  void refreshAiKeyStatus();

  async function save(next: McpConfig) {
    mutate(next);
    try {
      await api().mcpConfigSet(next);
    } catch (err) {
      notify(errorText(err), "error");
      void refetch();
    }
    void refreshMcpStatus();
  }

  const levelOf = (id: string) => config()?.connections[id]?.level ?? "none";

  function setLevel(id: string, level: McpLevel) {
    const current = config();
    if (!current) return;
    void save({ ...current, connections: { ...current.connections, [id]: { ...current.connections[id], level } } });
  }

  async function test() {
    try {
      const result = (await api().mcpTestTool("list_connections", {})) as { isError?: boolean; text?: string } | string;
      if (typeof result === "string") setPreview(result);
      else setPreview(`${result.isError ? "Error: " : ""}${result.text ?? JSON.stringify(result, null, 2)}`);
    } catch (err) {
      setPreview(errorText(err));
    }
  }

  async function installDesktop() {
    try {
      const path = await api().mcpInstallClaudeDesktop();
      notify("Claude Desktop configurado. Reinícialo para cargar Celer.", "success", path);
    } catch (err) {
      notify("No se pudo configurar Claude Desktop", "error", errorText(err));
    }
  }

  return (
    <>
      <h4>Asistente integrado</h4>
      <p class="settings-note">El panel de IA (Ctrl+Alt+I) genera, explica y corrige SQL con Claude. Envía el esquema y el SQL del editor, nunca filas de datos.</p>
      <div class="form-row">
        <label class="field">
          <span>Modelo</span>
          <select value={state.settings.aiModel} onChange={(event) => void saveSettings({ aiModel: event.currentTarget.value })}>
            <For each={AI_MODELS}>{(model) => <option value={model.id}>{model.label} · {model.hint}</option>}</For>
          </select>
        </label>
        <div class="field">
          <span>Clave de API</span>
          <div class="input-group">
            <Show when={state.ai.hasKey} fallback={<button type="button" class="btn" onClick={() => { setState({ settingsOpen: false }); setState("ai", "needsKey", true); openInspector("ai"); }}>Añadir clave…</button>}>
              <span class="key-ok"><CircleCheck size={14} /> Guardada en el sistema</span>
              <button type="button" class="btn" onClick={() => void saveAiKey("")}>Quitar</button>
            </Show>
          </div>
        </div>
      </div>

      <h4>Servidor MCP para asistentes externos</h4>
      <p class="settings-note">
        Permite que Claude Desktop, Claude Code u otro cliente MCP consulten tus bases de datos a través de Celer, solo con los permisos que fijes aquí.
        Cada petición queda registrada abajo.
      </p>
      <Show when={isTauri()} fallback={<p class="settings-note">Disponible en la aplicación de escritorio.</p>}>
        <Show when={config()} fallback={<p class="settings-note">Cargando configuración…</p>}>
          {(cfg) => (
            <>
              <label class="check big">
                <input type="checkbox" checked={cfg().enabled} onChange={(event) => void save({ ...cfg(), enabled: event.currentTarget.checked })} />
                <span><b>Permitir acceso por MCP</b><small>Si está desactivado, el servidor rechaza todas las peticiones.</small></span>
              </label>
              <div class="mcp-conns" classList={{ disabled: !cfg().enabled }}>
                <For each={state.connections} fallback={<p class="settings-note">No hay conexiones.</p>}>
                  {(conn) => {
                    const capped = () => conn.production || conn.readOnly;
                    return (
                      <div class="mcp-conn">
                        <EngineIcon kind={conn.kind} size={16} server={serverOf(conn.id)} />
                        <span class="mcp-conn-name">
                          <b>{conn.name}</b>
                          <Show when={capped()}><small>{conn.production ? "Producción: máximo lectura" : "Solo lectura: máximo lectura"}</small></Show>
                        </span>
                        <select value={levelOf(conn.id)} onChange={(event) => setLevel(conn.id, event.currentTarget.value as McpLevel)} title={LEVELS.find((item) => item.id === levelOf(conn.id))?.hint}>
                          <For each={LEVELS}>{(level) => <option value={level.id} disabled={level.id === "write" && capped()}>{level.label}</option>}</For>
                        </select>
                      </div>
                    );
                  }}
                </For>
              </div>
              <div class="form-row">
                <label class="field">
                  <span>Máximo de filas por consulta</span>
                  <select value={String(cfg().maxRows)} onChange={(event) => void save({ ...cfg(), maxRows: Number(event.currentTarget.value) })}>
                    <For each={[50, 100, 200, 500, 1000, 5000]}>{(n) => <option value={n}>{n.toLocaleString()}</option>}</For>
                  </select>
                </label>
                <label class="field">
                  <span>Tiempo máximo (s)</span>
                  <select value={String(cfg().timeoutSecs)} onChange={(event) => void save({ ...cfg(), timeoutSecs: Number(event.currentTarget.value) })}>
                    <For each={[10, 30, 60, 120]}>{(n) => <option value={n}>{n}</option>}</For>
                  </select>
                </label>
              </div>
              <label class="field">
                <span>Columnas sensibles que se ocultan (expresión regular sobre el nombre)</span>
                <input value={cfg().redactPattern} spellcheck={false} onChange={(event) => void save({ ...cfg(), redactPattern: event.currentTarget.value })} />
              </label>
              <div class="mcp-clients">
                <div class="mcp-client">
                  <b>Claude Desktop</b>
                  <small>{client()?.claudeDesktopConfigured ? "Configurado" : "Añade Celer a su configuración (se guarda una copia de seguridad)."}</small>
                  <button type="button" class="btn tiny" onClick={() => void installDesktop()}>{client()?.claudeDesktopConfigured ? "Volver a configurar" : "Configurar"}</button>
                </div>
                <div class="mcp-client">
                  <b>Claude Code{client()?.wslSupported ? " (Windows)" : ""}</b>
                  <Show when={client()?.claudeCodeRegistered === "yes"}><small class="mcp-ok"><CircleCheck size={12} /> Registrado</small></Show>
                  <Show when={client()?.claudeCodeRegistered === "stale"}><small class="mcp-stale"><TriangleAlert size={12} /> Registrado con otra ruta de Celer: vuelve a ejecutar el comando</small></Show>
                  <code>{client()?.claudeCodeCommand}</code>
                  <button type="button" class="btn tiny" onClick={() => void copyText(client()?.claudeCodeCommand ?? "", "Comando copiado")}><Copy size={12} /> Copiar</button>
                </div>
                <div class="mcp-client">
                  <b>Otro cliente MCP</b>
                  <code>{client()?.exePath} {client()?.args.join(" ")}</code>
                  <button type="button" class="btn tiny" onClick={() => void copyText(`${client()?.exePath} ${client()?.args.join(" ")}`, "Comando copiado")}><Copy size={12} /> Copiar</button>
                </div>
              </div>
              <Show when={client()?.wslSupported}><WslClients /></Show>
              <div class="mcp-test">
                <button type="button" class="btn tiny" onClick={() => void test()}><ShieldCheck size={13} /> Ver lo que vería la IA</button>
                <Show when={preview()}><pre>{preview()}</pre></Show>
              </div>
              <div class="mcp-audit-head">
                <h4>Registro de accesos</h4>
                <span class="spacer" />
                <button type="button" class="icon-btn" title="Actualizar" onClick={() => void refetchAudit()}><RefreshCw size={13} /></button>
                <button type="button" class="icon-btn" title="Vaciar registro" onClick={() => void api().mcpClearAudit().then(() => refetchAudit())}><Trash2 size={13} /></button>
              </div>
              <div class="mcp-audit">
                <For each={audit() ?? []} fallback={<p class="settings-note">Sin accesos todavía.</p>}>
                  {(entry) => (
                    <div class="mcp-audit-row" classList={{ bad: !entry.ok }}>
                      <time>{new Date(entry.at).toLocaleString()}</time>
                      <b title={entry.client ? `Desde ${clientText(entry)}` : undefined}>{entry.tool}</b>
                      <span>{entry.connName ?? ""}<Show when={entry.client}><small class="mcp-from">{entry.client}</small></Show></span>
                      <code title={entry.error ?? entry.detail ?? ""}>{entry.error ?? entry.detail ?? ""}</code>
                      <small>{entry.ok ? `${entry.rows ?? 0} filas · ${entry.ms ?? 0} ms` : "rechazado"}</small>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </Show>
    </>
  );
}

/** "claude-code · WSL (Ubuntu)": who called, as the audit log has it. */
export function clientText(entry: { client?: string | null; clientApp?: string | null }): string {
  return [entry.clientApp, entry.client].filter(Boolean).join(" · ");
}

const REGISTERED: Record<WslDistro["registered"], string> = {
  yes: "Registrado",
  stale: "Registrado con otra ruta de Celer: vuelve a registrarlo",
  no: "No registrado",
  unknown: "Sin comprobar",
};

/**
 * Claude Code inside WSL: every installed distro, whether Windows interop is on there, the command with celer.exe as
 * the distro sees it, and «Registrar en WSL», which runs it inside the distro after showing it.
 */
function WslClients() {
  const [info, setInfo] = createSignal<WslInfo | null>(null);
  /** "list" while the distros are read, or the distro being checked or registered. */
  const [busy, setBusy] = createSignal("");

  async function load(check?: string) {
    setBusy(check ?? "list");
    try {
      setInfo(await api().mcpWslInfo(check));
    } catch (err) {
      setInfo({ available: false, distros: [], error: errorText(err), checkedAt: Date.now() });
    } finally {
      setBusy("");
    }
    void refreshMcpStatus();
  }
  void load();

  async function register(distro: WslDistro) {
    const again = distro.registered === "yes" || distro.registered === "stale";
    const ok = await confirmDialog(
      `${again ? "Volver a registrar" : "Registrar"} Celer en WSL (${distro.name})`,
      `Se ejecutará dentro de ${distro.name}:\n\n${distro.command}\n\nAñade Celer a Claude Code de esa distribución, para todos sus proyectos${again ? "; la entrada «celer» que ya tiene se sustituye" : ""}. Tendrá los mismos permisos por conexión, ocultación y registro que desde Windows.`,
      again ? "Volver a registrar" : "Registrar",
    );
    if (!ok) return;
    setBusy(distro.name);
    try {
      const said = await api().mcpWslRegister(distro.name);
      notify(`Celer registrado en Claude Code de ${distro.name}`, "success", said || "Comprueba con «claude mcp list» dentro de la distribución.");
    } catch (err) {
      notify(`No se pudo registrar Celer en ${distro.name}`, "error", errorText(err));
    }
    await load(distro.name);
  }

  return (
    <div class="mcp-wsl">
      <div class="mcp-wsl-head">
        <Terminal size={14} />
        <b>Claude Code en WSL</b>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Volver a buscar distribuciones" disabled={Boolean(busy())} onClick={() => void load()}><RefreshCw size={13} class={busy() === "list" ? "spin" : ""} /></button>
      </div>
      <Show when={info()} fallback={<p class="settings-note">Buscando distribuciones de WSL…</p>}>
        {(wsl) => (
          <Show
            when={wsl().distros.length}
            fallback={<p class="settings-note">{wsl().error ? `No se pudo consultar WSL: ${wsl().error}` : "No hay ninguna distribución de WSL instalada."}</p>}
          >
            <For each={wsl().distros}>
              {(distro) => (
                <div class="mcp-distro" classList={{ stale: distro.registered === "stale" }}>
                  <div class="mcp-distro-head">
                    <b>{distro.name}</b>
                    <Show when={distro.default}><span class="tag tiny">predeterminada</span></Show>
                    <small>{distro.running ? "En ejecución" : "Detenida"}</small>
                    <Show when={distro.interop === false}><small class="mcp-stale"><TriangleAlert size={12} /> Interoperabilidad con Windows desactivada</small></Show>
                    <Show when={distro.checked && distro.interop !== false && !distro.claude}><small class="mcp-stale">Claude Code no está instalado</small></Show>
                    <span class="spacer" />
                    <small classList={{ "mcp-ok": distro.registered === "yes", "mcp-stale": distro.registered === "stale" }}>
                      <Show when={distro.registered === "yes"}><CircleCheck size={12} /> </Show>
                      {REGISTERED[distro.registered]}
                    </small>
                  </div>
                  <Show when={distro.error}><small class="mcp-error">{distro.error}</small></Show>
                  <Show when={distro.registered === "stale" && distro.registeredCommand}><small class="mcp-stale">Ahora ejecuta: {distro.registeredCommand}</small></Show>
                  <Show when={distro.command} fallback={<small class="mcp-error">Celer está en una ruta de red: WSL no la ve por su letra de unidad.</small>}>
                    <code title={`Ruta en WSL (raíz de montaje ${distro.automountRoot}): ${distro.exePath}`}>{distro.command}</code>
                  </Show>
                  <div class="mcp-distro-actions">
                    <button type="button" class="btn tiny" disabled={!distro.command} onClick={() => void copyText(distro.command, "Comando copiado")}><Copy size={12} /> Copiar</button>
                    <Show when={!distro.checked}>
                      <button type="button" class="btn tiny" disabled={Boolean(busy())} title="Arranca la distribución para leer su configuración" onClick={() => void load(distro.name)}>{busy() === distro.name ? "Comprobando…" : "Comprobar"}</button>
                    </Show>
                    <button
                      type="button"
                      class="btn tiny"
                      classList={{ primary: distro.registered === "stale" }}
                      disabled={Boolean(busy()) || !distro.command || distro.interop === false || (distro.checked && !distro.claude)}
                      onClick={() => void register(distro)}
                    >
                      {busy() === distro.name && distro.checked ? "Registrando…" : distro.registered === "yes" || distro.registered === "stale" ? "Volver a registrar" : "Registrar en WSL"}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        )}
      </Show>
    </div>
  );
}
