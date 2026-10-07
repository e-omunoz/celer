import { CircleCheck, Copy, RefreshCw, ShieldCheck, Trash2 } from "lucide-solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { AI_MODELS, refreshAiKeyStatus, saveAiKey } from "../ai";
import { api, errorText, isTauri } from "../api";
import { EngineIcon } from "../icons";
import { copyText, notify, openInspector, saveSettings, serverOf, setState, state } from "../state";
import type { McpConfig, McpLevel } from "../types";

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
                  <b>Claude Code</b>
                  <code>{client()?.claudeCodeCommand}</code>
                  <button type="button" class="btn tiny" onClick={() => void copyText(client()?.claudeCodeCommand ?? "", "Comando copiado")}><Copy size={12} /> Copiar</button>
                </div>
                <div class="mcp-client">
                  <b>Otro cliente MCP</b>
                  <code>{client()?.exePath} {client()?.args.join(" ")}</code>
                  <button type="button" class="btn tiny" onClick={() => void copyText(`${client()?.exePath} ${client()?.args.join(" ")}`, "Comando copiado")}><Copy size={12} /> Copiar</button>
                </div>
              </div>
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
                      <b>{entry.tool}</b>
                      <span>{entry.connName ?? ""}</span>
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
