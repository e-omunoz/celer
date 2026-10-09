// «Ejecutar en…» (library): pick one or more targets (a connection, and a database and schema where the engine has
// them), then open the script in a console per target or run all of it in each. The actions live in library.ts.
import { Plus, Trash2 } from "lucide-solid";
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { closeRunOn, defaultTargets, library, runLibraryOn, scriptById, scriptGuess } from "../library";
import { schemaSetupSql, statementCount, targetHasDatabase, type RunTarget } from "../libraryModel";
import { compatibility, kindLabel } from "../engineCompat";
import { EngineBadge } from "./EngineBadge";
import { findVariables, variableLiteral } from "../variables";
import { resolvedFor } from "../variableStore";
import { connect, connectionById, state } from "../state";
import { Dialog } from "./Modals";

export function RunOnDialog() {
  const script = () => scriptById(library.runOn?.scriptId ?? "");
  return (
    <Show when={script()} keyed>
      {(s) => <RunOnForm scriptId={s.id} />}
    </Show>
  );
}

function RunOnForm(props: { scriptId: string }) {
  const script = () => scriptById(props.scriptId)!;
  const [targets, setTargets] = createSignal<RunTarget[]>(defaultTargets(script()));
  const statements = createMemo(() => statementCount(script().sql, connectionById(targets()[0]?.connId)?.kind));
  const [action, setAction] = createSignal<"run" | "open">("run");
  const guess = createMemo(() => scriptGuess(script()));
  /** The ${variables} of the script: each target shows the values its connection gives them. */
  const usedVars = createMemo(() => [...new Set(findVariables(script().sql).map((ref) => ref.name))]);
  const patch = (index: number, change: Partial<RunTarget>) => setTargets((list) => list.map((t, i) => (i === index ? { ...t, ...change } : t)));
  const add = () => {
    const used = new Set(targets().map((t) => t.connId));
    const next = state.connections.find((c) => !used.has(c.id)) ?? state.connections[0];
    if (next) setTargets([...targets(), { connId: next.id, database: "" }]);
  };
  const production = () => targets().map((t) => connectionById(t.connId)).filter((c) => c?.production);
  const submit = () => {
    const list = targets();
    closeRunOn();
    void runLibraryOn(props.scriptId, list, action());
  };
  return (
    <Dialog title={`Ejecutar «${script().name}» en…`} onClose={closeRunOn} class="runon-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Show when={script().description}>
          <p class="dialog-lead runon-desc">{script().description}</p>
        </Show>
        <p class="muted small runon-facts">
          {statements() === 1 ? "1 sentencia" : `${statements()} sentencias`}
          <EngineBadge guess={guess()} showStandard />
          <Show when={script().params?.length}> · {script().params!.length === 1 ? "1 parámetro con valor por defecto" : `${script().params!.length} parámetros con valor por defecto`}</Show>
        </p>
        <div class="runon-targets">
          <Index each={targets()}>
            {(target, index) => {
              const conn = () => connectionById(target().connId);
              const kind = () => conn()?.kind;
              const session = () => state.sessions[target().connId];
              const listId = `runon-db-${index}`;
              return (
                <div class="runon-target">
                  <label class="field">
                    <span>Conexión</span>
                    <select value={target().connId} onChange={(event) => patch(index, { connId: event.currentTarget.value, database: "", schema: undefined })}>
                      <For each={state.connections}>
                        {(c) => (
                          <option value={c.id} selected={c.id === target().connId}>
                            {c.name}
                            {c.production ? " (producción)" : ""}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <Show when={targetHasDatabase(kind())}>
                    <label class="field">
                      <span>{kind() === "mysql" ? "Base de datos (esquema)" : "Base de datos"}</span>
                      <input
                        value={target().database}
                        list={listId}
                        spellcheck={false}
                        placeholder={conn()?.database || session()?.database || "La de la conexión"}
                        onInput={(event) => patch(index, { database: event.currentTarget.value.trim() })}
                      />
                      <datalist id={listId}>
                        <For each={session()?.databases ?? []}>{(db) => <option value={db} />}</For>
                      </datalist>
                    </label>
                  </Show>
                  <Show when={schemaSetupSql(kind(), "x") !== null}>
                    <label class="field runon-schema">
                      <span>Esquema</span>
                      <input value={target().schema ?? ""} spellcheck={false} placeholder="search_path actual" onInput={(event) => patch(index, { schema: event.currentTarget.value.trim() || undefined })} />
                    </label>
                  </Show>
                  <Show when={compatibility(guess(), kind()) === "warn"}>
                    <p class="field-warn runon-engine-warn">
                      El script es para {guess().engines.map(kindLabel).join(", ")} y esta conexión es {kindLabel(kind()!)}
                      {guess().source === "connection" ? " (se guardó con otra conexión)" : ": se pedirá confirmación"}.
                    </p>
                  </Show>
                  <Show when={usedVars().length}>
                    <p class="muted small runon-vars">
                      {usedVars()
                        .map((name) => {
                          const variable = resolvedFor(undefined, target().connId).get(name);
                          return variable ? `\${${name}} = ${variableLiteral(variable, kind())}` : `\${${name}} sin valor: se pedirá`;
                        })
                        .join(" · ")}
                    </p>
                  </Show>
                  <div class="runon-row-actions">
                    <Show when={targetHasDatabase(kind()) && !session()}>
                      <button
                        type="button"
                        class="btn tiny"
                        disabled={Boolean(state.connecting[target().connId])}
                        title="Conectar para ver la lista de bases de datos"
                        onClick={() => void connect(target().connId)}
                      >
                        {state.connecting[target().connId] ? "Conectando…" : "Ver bases"}
                      </button>
                    </Show>
                    <Show when={targets().length > 1}>
                      <button type="button" class="icon-btn" title="Quitar este destino" onClick={() => setTargets(targets().filter((_, i) => i !== index))}>
                        <Trash2 size={13} />
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </Index>
          <Show when={!state.connections.length}>
            <p class="muted small">No hay conexiones guardadas: crea una primero.</p>
          </Show>
        </div>
        <button type="button" class="btn tiny runon-add" disabled={!state.connections.length} onClick={add}>
          <Plus size={13} /> Añadir destino
        </button>
        <fieldset class="runon-action">
          <label class="check">
            <input type="radio" name="runon-action" checked={action() === "run"} onChange={() => setAction("run")} />
            {statements() > 1 ? `Ejecutar el script completo (las ${statements()} sentencias, en orden)` : "Ejecutar"}
            <small>{targets().length > 1 ? "una consola por destino, con sus resultados" : "en una consola con sus resultados"}</small>
          </label>
          <label class="check">
            <input type="radio" name="runon-action" checked={action() === "open"} onChange={() => setAction("open")} />
            Solo abrir en {targets().length > 1 ? "una consola por destino" : "una consola"}
            <small>{statements() > 1 ? "y elegir qué sentencia ejecutar (Ctrl+Intro ejecuta la del cursor)" : "sin ejecutar"}</small>
          </label>
        </fieldset>
        <Show when={action() === "run" && production().length}>
          <p class="field-warn">
            {production().map((c) => `«${c!.name}»`).join(", ")} {production().length === 1 ? "es de producción" : "son de producción"}: las sentencias que modifican datos o la estructura
            piden confirmación en cada destino.
          </p>
        </Show>
        <footer>
          <span class="spacer" />
          <button type="button" class="btn" onClick={closeRunOn}>Cancelar</button>
          <button type="submit" class="btn primary" disabled={!targets().length}>
            {action() === "open" ? "Abrir" : targets().length > 1 ? `Ejecutar en ${targets().length} destinos` : "Ejecutar"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
