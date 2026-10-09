import { ArrowUp, Bug, Copy, Gauge, KeyRound, Lightbulb, Play, Replace, Shield, Square, Trash2, TextCursorInput } from "lucide-solid";
import { createSignal, For, onMount, Show } from "solid-js";
import { AI_MODELS, aiContextSummary, askAi, clearAi, refreshAiKeyStatus, saveAiKey, stopAi } from "../ai";
import { activeSql, copyText, gibShows, insertIntoActive, kindOf, replaceActiveSql, runText, saveSettings, setState, state } from "../state";
import { Gib } from "../gib/Gib";
import { CodeView } from "./Editor";
import { Markdown } from "./Markdown";

export function AiPanel() {
  let input: HTMLTextAreaElement | undefined;
  let list: HTMLDivElement | undefined;
  const [draft, setDraft] = createSignal("");
  onMount(() => void refreshAiKeyStatus());

  const ctx = () => aiContextSummary();
  const showKeySetup = () => state.ai.needsKey || !state.ai.hasKey;

  function send() {
    const text = draft().trim();
    if (!text || state.ai.running) return;
    setDraft("");
    void askAi("ask", text).then(scrollEnd);
    queueMicrotask(scrollEnd);
  }

  function scrollEnd() {
    if (list) list.scrollTop = list.scrollHeight;
  }

  return (
    <div class="ai-panel">
      <Show when={!showKeySetup()} fallback={<KeySetup />}>
        <div class="ai-context" title="Lo que se envía al modelo junto a tu pregunta">
          <Shield size={12} />
          <span>
            {ctx().engine || "Sin conexión"}
            {ctx().database ? ` · ${ctx().database}` : ""}
            {` · esquema de ${ctx().tables} tablas`}
            {ctx().hasSql ? " · SQL del editor" : ""}
          </span>
          <span class="spacer" />
          <select class="ai-model" value={state.settings.aiModel} onChange={(event) => void saveSettings({ aiModel: event.currentTarget.value })} title="Modelo">
            <For each={AI_MODELS}>{(model) => <option value={model.id}>{model.label}</option>}</For>
          </select>
        </div>
        <div class="ai-actions">
          <button type="button" class="ai-chip" disabled={state.ai.running || !ctx().hasSql} onClick={() => void askAi("explain").then(scrollEnd)}><Lightbulb size={13} /> Explicar</button>
          <button type="button" class="ai-chip" disabled={state.ai.running || !ctx().hasError} onClick={() => void askAi("fix").then(scrollEnd)}><Bug size={13} /> Corregir error</button>
          <button type="button" class="ai-chip" disabled={state.ai.running || !ctx().hasSql} onClick={() => void askAi("optimize").then(scrollEnd)}><Gauge size={13} /> Optimizar</button>
          <span class="spacer" />
          <Show when={state.ai.messages.length}>
            <button type="button" class="icon-btn" title="Nueva conversación" onClick={clearAi}><Trash2 size={13} /></button>
          </Show>
        </div>
        <div class="ai-messages" ref={list}>
          <Show when={!state.ai.messages.length}>
            <div class="ai-empty">
              <Show when={gibShows("empty")}><Gib size={72} mood="idea" /></Show>
              <p class="ai-empty-title">¿Qué necesitas consultar?</p>
              <p>Describe lo que buscas en lenguaje natural y te propongo el SQL para {ctx().engine || "tu base de datos"}, usando las tablas reales de tu esquema.</p>
              <For each={["Clientes con más pedidos el último mes", "¿Qué tablas guardan direcciones de email?", "Ventas por mes y país en 2025"]}>
                {(example) => <button type="button" class="ai-example" onClick={() => { setDraft(example); input?.focus(); }}>{example}</button>}
              </For>
            </div>
          </Show>
          <For each={state.ai.messages}>
            {(message) => (
              <div class={`ai-msg ${message.role}`} classList={{ error: message.error, streaming: message.streaming }}>
                <Show when={message.role === "user"} fallback={
                  <Show when={message.text} fallback={
                    // Gib thinks along until the first words arrive.
                    <span class="ai-wait">
                      <Show when={gibShows("empty")}><Gib size={34} mood="think" plain still /></Show>
                      <span class="ai-thinking"><i /><i /><i /></span>
                    </span>
                  }>
                    <Markdown text={message.text} code={(block) => <AiCode lang={block.lang} text={block.text} done={!message.streaming} />} />
                  </Show>
                }>
                  <p>{message.label ?? message.text}</p>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class="ai-input">
          <textarea
            ref={input}
            rows="2"
            value={draft()}
            placeholder="Pregunta o describe la consulta que necesitas…"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <Show when={state.ai.running} fallback={<button type="button" class="ai-send" title="Enviar (Intro)" disabled={!draft().trim()} onClick={send}><ArrowUp size={15} /></button>}>
            <button type="button" class="ai-send stop" title="Detener" onClick={stopAi}><Square size={12} fill="currentColor" /></button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function AiCode(props: { lang: string; text: string; done: boolean }) {
  const isSql = () => !props.lang || /sql/.test(props.lang);
  return (
    <div class="ai-code">
      <CodeView doc={props.text} kind={kindOf(activeSql()?.connId)} />
      <Show when={props.done && isSql()}>
        <div class="ai-code-actions">
          <button type="button" title="Insertar en el cursor" onClick={() => insertIntoActive(`\n${props.text}\n`)}><TextCursorInput size={13} /> Insertar</button>
          <button type="button" title="Reemplazar el contenido de la consola" onClick={() => replaceActiveSql(props.text)}><Replace size={13} /> Reemplazar</button>
          <button type="button" title="Ejecutar en la consola activa" disabled={!activeSql()?.connId} onClick={() => void runText(props.text)}><Play size={13} /> Ejecutar</button>
          <button type="button" title="Copiar" onClick={() => void copyText(props.text, "SQL copiado")}><Copy size={13} /></button>
        </div>
      </Show>
    </div>
  );
}

function KeySetup() {
  const [key, setKey] = createSignal("");
  return (
    <div class="ai-setup">
      <div class="ai-setup-icon"><KeyRound size={20} /></div>
      <h4>Asistente SQL con Claude</h4>
      <p>Genera, explica, corrige y optimiza consultas usando el esquema real de tu conexión.</p>
      <label class="field">
        <span>Clave de API de Anthropic</span>
        <input type="password" placeholder="sk-ant-…" value={key()} onInput={(event) => setKey(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && key().trim() && void saveAiKey(key())} />
      </label>
      <button type="button" class="btn primary" disabled={!key().trim()} onClick={() => void saveAiKey(key())}>Guardar clave</button>
      <ul class="ai-privacy">
        <li>La clave se guarda en el almacén de credenciales del sistema, no en ficheros.</li>
        <li>Se envía el <b>esquema</b> (nombres de tablas y columnas), el SQL del editor y el último error. <b>Nunca filas de datos.</b></li>
        <li>Para que una IA externa lea datos, usa el servidor MCP en Ajustes › IA, con permisos por conexión.</li>
      </ul>
      <Show when={state.ai.hasKey}>
        <button type="button" class="link small" onClick={() => setState("ai", "needsKey", false)}>Volver</button>
      </Show>
    </div>
  );
}
