import { Plus, Trash2 } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { guessEngines, isCompatible, kindLabel } from "../engineCompat";
import { ENGINE_TAGS, engineLabel, normalizeEngine } from "../libraryModel";
import { builtinSnippets } from "../snippets";
import { kindOf, activeTab, connectionById, saveSettings, state } from "../state";
import type { Snippet } from "../types";
import { EngineBadge } from "./EngineBadge";

/**
 * Settings › Plantillas: the user's live templates (name, description, engine, body) and the built-in ones for
 * reference. A user template with the name of a built-in one replaces it.
 */
export function SnippetSettings() {
  const own = () => state.settings.snippets;
  const [showBuiltin, setShowBuiltin] = createSignal(false);
  /** «Solo las compatibles con esta conexión»: the active tab's engine. */
  const [onlyCompat, setOnlyCompat] = createSignal(false);
  const activeKind = () => connectionById(activeTab()?.connId)?.kind;
  const save = (next: Snippet[]) => void saveSettings({ snippets: next });
  const patch = (index: number, change: Partial<Snippet>) => save(own().map((s, i) => (i === index ? { ...s, ...change } : s)));
  const add = () => save([...own(), { name: "", description: "", body: "SELECT ${columnas}\nFROM ${tabla};" }]);
  const duplicate = (name: string) => own().filter((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase()).length > 1;
  const guessOf = (snippet: Snippet) => guessEngines(snippet.body, { override: snippet.engine });
  const visible = (snippet: Snippet) => !onlyCompat() || isCompatible(guessOf(snippet), activeKind());
  return (
    <div class="snippet-settings">
      <p class="settings-note">
        Escribe el nombre de una plantilla en el editor (por ejemplo <code>sel</code>) y pulsa Tab o Intro en la lista de sugerencias. En el cuerpo,{" "}
        <code>{"${nombre}"}</code> es un campo (Tab salta al siguiente; los campos con el mismo nombre se editan a la vez), <code>{"${}"}</code> un campo vacío y{" "}
        <code>{"${0}"}</code> donde acaba el cursor. Las que son de otro motor que el de la consola salen marcadas en las sugerencias.
      </p>
      <Show when={own().length}>
        <label class="check snippet-filter" title={activeKind() ? undefined : "Abre una consola con conexión para filtrar por su motor"}>
          <input type="checkbox" checked={onlyCompat()} disabled={!activeKind()} onChange={(event) => setOnlyCompat(event.currentTarget.checked)} />
          Solo las compatibles con esta conexión{activeKind() ? ` (${kindLabel(activeKind()!)})` : ""}
        </label>
      </Show>
      <For each={own()} fallback={<p class="muted small">Aún no tienes plantillas propias.</p>}>
        {(snippet, index) => (
          <Show when={visible(snippet)}>
            <div class="snippet-card">
              <div class="form-row">
                <label class="field snippet-name">
                  <span>Nombre</span>
                  <input value={snippet.name} placeholder="miplantilla" spellcheck={false} onChange={(event) => patch(index(), { name: event.currentTarget.value.trim() })} />
                </label>
                <label class="field">
                  <span>Descripción</span>
                  <input value={snippet.description} placeholder="Qué hace" onChange={(event) => patch(index(), { description: event.currentTarget.value })} />
                </label>
                <label class="field snippet-engine">
                  <span>Motor</span>
                  <select value={snippet.engine ?? ""} onChange={(event) => patch(index(), { engine: normalizeEngine(event.currentTarget.value) })}>
                    <option value="">Detectar</option>
                    <For each={ENGINE_TAGS}>{(tag) => <option value={tag} selected={tag === snippet.engine}>{engineLabel(tag)}</option>}</For>
                  </select>
                </label>
                <button type="button" class="icon-btn" title="Eliminar plantilla" onClick={() => save(own().filter((_, i) => i !== index()))}>
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea class="snippet-body" rows={4} spellcheck={false} value={snippet.body} onChange={(event) => patch(index(), { body: event.currentTarget.value })} />
              <div class="snippet-meta">
                <EngineBadge guess={guessOf(snippet)} kind={activeKind()} showStandard />
              </div>
              <Show when={snippet.name && duplicate(snippet.name)}>
                <p class="field-warn">Hay otra plantilla con este nombre: se usará la primera.</p>
              </Show>
              <Show when={snippet.name && builtinSnippets(undefined).some((b) => b.name === snippet.name.toLowerCase())}>
                <p class="muted small">Sustituye a la plantilla incluida «{snippet.name}».</p>
              </Show>
            </div>
          </Show>
        )}
      </For>
      <button type="button" class="btn" onClick={add}>
        <Plus size={14} /> Nueva plantilla
      </button>
      <button type="button" class="link small snippet-toggle" onClick={() => setShowBuiltin(!showBuiltin())}>
        {showBuiltin() ? "Ocultar las plantillas incluidas" : "Ver las plantillas incluidas"}
      </button>
      <Show when={showBuiltin()}>
        <p class="muted small">Las incluidas se escriben en el dialecto de la consola (TOP, FIRST o LIMIT): valen para cualquier motor.</p>
        <table class="snippet-builtin">
          <tbody>
            <For each={builtinSnippets(kindOf(activeTab()?.connId))}>
              {(s) => (
                <tr>
                  <td><code>{s.name}</code></td>
                  <td>{s.description}</td>
                  <td><pre>{s.body.replace(/\$\{([^{}]*)\}/g, (_, name: string) => name || "…").replace(/\t/g, "  ")}</pre></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
