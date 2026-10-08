import { Plus, RotateCcw, Search, X } from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { commands, type Command } from "../commands";
import { chordOf, chordParts, chordsFor, DEFAULT_KEYS, EDITOR_COMMANDS, EDITOR_RESERVED } from "../keymap";
import { saveSettings, state } from "../state";

const EDITOR_SET = new Set<string>(EDITOR_COMMANDS);

/** Keys alone that are fine as a shortcut (anything else needs Ctrl or Alt, or it would type text). */
const STANDALONE = /^(F([1-9]|1[0-9]|2[0-4]))$/;

/** Settings › Atajos de teclado: every command with its shortcuts, to add, remove or reset. */
export function KeymapSettings() {
  const [query, setQuery] = createSignal("");
  /** The command waiting for a key combination. */
  const [recording, setRecording] = createSignal<string | null>(null);
  /** A combination that needs a decision (taken by another command) or a note. */
  const [pending, setPending] = createSignal<{ id: string; chord: string; owner?: string; note?: string } | null>(null);

  const list = createMemo(() => commands().filter((c) => !c.id.startsWith("theme-")));
  const keysOf = (id: string) => chordsFor(id, state.settings.keymap);
  const changed = (id: string) => state.settings.keymap[id] !== undefined;
  const labelOf = (id: string) => list().find((c) => c.id === id)?.label ?? id;

  const groups = createMemo(() => {
    const q = query().trim().toLowerCase();
    const out = new Map<string, Command[]>();
    for (const command of list()) {
      const keys = keysOf(command.id).map((k) => chordParts(k).join("+").toLowerCase());
      if (q && !command.label.toLowerCase().includes(q) && !keys.some((k) => k.includes(q))) continue;
      const group = out.get(command.group) ?? [];
      group.push(command);
      out.set(command.group, group);
    }
    return [...out.entries()];
  });

  const write = (patch: Record<string, string[] | undefined>) => {
    const next = { ...state.settings.keymap };
    for (const [id, keys] of Object.entries(patch)) {
      // Back to the defaults: no entry at all.
      if (keys === undefined || sameKeys(keys, DEFAULT_KEYS[id] ?? [])) delete next[id];
      else next[id] = keys;
    }
    void saveSettings({ keymap: next });
  };

  const assign = (id: string, chord: string, takeFrom?: string) => {
    const patch: Record<string, string[] | undefined> = { [id]: [...keysOf(id).filter((k) => k !== chord), chord] };
    if (takeFrom) patch[takeFrom] = keysOf(takeFrom).filter((k) => k !== chord);
    write(patch);
    setPending(null);
  };

  const onKey = (event: KeyboardEvent) => {
    const id = recording();
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      setRecording(null);
      return;
    }
    const chord = chordOf(event);
    if (!chord) return;
    setRecording(null);
    const plain = !chord.includes("Ctrl+") && !chord.startsWith("Alt+");
    const key = chord.split("+").pop() ?? "";
    if (plain && !STANDALONE.test(key)) {
      setPending({ id, chord, note: "Sola (o con Mayús) esa tecla escribe texto: combínala con Ctrl o Alt." });
      return;
    }
    if (keysOf(id).includes(chord)) return;
    const owner = list().find((c) => c.id !== id && keysOf(c.id).includes(chord));
    if (owner) {
      setPending({ id, chord, owner: owner.id });
      return;
    }
    const reserved = EDITOR_RESERVED[chord];
    assign(id, chord);
    if (reserved && !EDITOR_SET.has(id)) setPending({ id, chord, note: `Dentro del editor SQL, ${chordParts(chord).join("+")} es «${reserved}»: allí seguirá haciendo eso.` });
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="keymap">
      <div class="keymap-head">
        <div class="mini-search grow">
          <Search size={12} />
          <input placeholder="Buscar una acción o un atajo" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        </div>
        <button type="button" class="btn tiny" disabled={!Object.keys(state.settings.keymap).length} onClick={() => void saveSettings({ keymap: {} })}>
          <RotateCcw size={13} /> Restablecer todos
        </button>
      </div>
      <p class="settings-note">Pulsa <b>+</b> y después la combinación. Las de la consulta (ejecutar, plan, formatear) funcionan dentro del editor SQL; el resto, en toda la ventana.</p>
      <Show when={pending()}>
        {(p) => (
          <div class="keymap-pending" role="status">
            <Show
              when={p().owner}
              fallback={
                <>
                  <span>{p().note}</span>
                  <button type="button" class="icon-btn" title="Cerrar" onClick={() => setPending(null)}><X size={13} /></button>
                </>
              }
            >
              <span>
                <Keys chord={p().chord} /> ya es «{labelOf(p().owner!)}».
              </span>
              <button type="button" class="btn tiny primary" onClick={() => assign(p().id, p().chord, p().owner)}>Usarlo para «{labelOf(p().id)}»</button>
              <button type="button" class="btn tiny" onClick={() => setPending(null)}>Cancelar</button>
            </Show>
          </div>
        )}
      </Show>
      <div class="keymap-list">
        <For each={groups()} fallback={<p class="inspector-empty">Ninguna acción coincide.</p>}>
          {([group, items]) => (
            <section>
              <h5>{group}</h5>
              <For each={items}>
                {(command) => (
                  <div class="keymap-row" classList={{ changed: changed(command.id), recording: recording() === command.id }}>
                    <span class="keymap-label">{command.label}</span>
                    <span class="keymap-keys">
                      <For each={keysOf(command.id)}>
                        {(chord) => (
                          <span class="keymap-chip">
                            <Keys chord={chord} />
                            <button type="button" title="Quitar este atajo" onClick={() => write({ [command.id]: keysOf(command.id).filter((k) => k !== chord) })}><X size={11} /></button>
                          </span>
                        )}
                      </For>
                      <Show when={recording() === command.id}>
                        <span class="keymap-chip listening">Pulsa la combinación… <small>(Esc cancela)</small></span>
                      </Show>
                    </span>
                    <span class="keymap-actions">
                      <button
                        type="button"
                        class="icon-btn"
                        title="Añadir un atajo"
                        onClick={() => {
                          setPending(null);
                          setRecording(recording() === command.id ? null : command.id);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                      <button type="button" class="icon-btn" title="Volver al atajo de serie" disabled={!changed(command.id)} onClick={() => write({ [command.id]: undefined })}>
                        <RotateCcw size={13} />
                      </button>
                    </span>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

function Keys(props: { chord: string }) {
  return (
    <span class="keys">
      <For each={chordParts(props.chord)}>{(part) => <kbd>{part}</kbd>}</For>
    </span>
  );
}

function sameKeys(a: string[], b: string[]) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
