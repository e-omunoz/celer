// Inspector › Variables: the values written as ${name} in consoles and library scripts, per scope (the console's own,
// its connection's, the global ones), and which of them the active console's SQL uses. The data is in variableStore.ts.
import { CornerDownLeft, Plus, Trash2 } from "lucide-solid";
import { createMemo, For, Index, onMount, Show } from "solid-js";
import { activeSql, connectionById, insertIntoActive, notify } from "../state";
import { deleteVariable, loadVariables, resolvedFor, saveVariable, scopeList, scopeText } from "../variableStore";
import { findVariables, validVarName, variableLiteral, type Variable, type VarScope } from "../variables";

export function VariablesPanel() {
  onMount(() => void loadVariables());
  const tab = () => activeSql();
  const conn = () => connectionById(tab()?.connId);
  const resolved = createMemo(() => resolvedFor(tab()));
  /** The ${names} of the active console's SQL, each with the value that applies (or none: it will be asked). */
  const inUse = createMemo(() => {
    const t = tab();
    if (!t) return [];
    const names = [...new Set(findVariables(t.sql, conn()?.kind).map((ref) => ref.name))];
    return names.map((name) => ({ name, variable: resolved().get(name) }));
  });
  return (
    <div class="vars-panel">
      <p class="vars-intro muted small">
        Escribe <code>{"${nombre}"}</code> en una consola o un script: al ejecutar se pone el valor de la consola, si no el de su conexión y si no el
        global. Una variable sin valor se pide como un parámetro.
      </p>
      <Show when={inUse().length}>
        <section class="vars-section">
          <h4>En el SQL de esta consola</h4>
          <For each={inUse()}>
            {(item) => (
              <div class="vars-use" classList={{ missing: !item.variable }}>
                <code>{"${" + item.name + "}"}</code>
                <Show when={item.variable} fallback={<span class="muted">sin valor: se pedirá al ejecutar</span>}>
                  <span class="vars-use-value" title={variableLiteral(item.variable!, conn()?.kind)}>{variableLiteral(item.variable!, conn()?.kind)}</span>
                  <small class="muted">{scopeText(item.variable!, tab()?.connId)}</small>
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>
      <ScopeSection scope="console" owner={tab()?.id} title={tab() ? `Esta consola (${tab()!.title})` : "Esta consola"} empty={tab() ? "" : "Abre una consola para darle variables propias."} />
      <ScopeSection scope="connection" owner={conn()?.id} title={conn() ? `Conexión «${conn()!.name}»` : "Conexión"} empty={conn() ? "" : "La consola activa no tiene conexión."} />
      <ScopeSection scope="global" owner={null} title="Globales" empty="" />
      <p class="vars-intro muted small">
        El historial guarda el SQL con los valores puestos. Al asistente de IA solo se le envían los nombres, salvo que la conexión le permita leer datos
        (Ajustes › IA).
      </p>
    </div>
  );
}

function ScopeSection(props: { scope: VarScope; owner: string | null | undefined; title: string; empty: string }) {
  const list = () => scopeList(props.scope, props.owner);
  const usable = () => props.scope === "global" || Boolean(props.owner);
  /** A name that applies here but is taken by a narrower scope in the active console. */
  const shadowed = (name: string) => {
    const winner = resolvedFor(activeSql()).get(name);
    return winner && winner.scope !== props.scope ? winner.scope : null;
  };
  const add = () => {
    const taken = new Set(list().map((v) => v.name));
    let name = "variable";
    for (let n = 2; taken.has(name); n++) name = `variable${n}`;
    void saveVariable(props.scope, props.owner, { name, value: "" });
  };
  return (
    <section class="vars-section">
      <h4>
        {props.title}
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Nueva variable" disabled={!usable()} onClick={add}><Plus size={13} /></button>
      </h4>
      <Show when={usable()} fallback={<p class="muted small">{props.empty}</p>}>
        <Show when={list().length} fallback={<p class="muted small">Ninguna.</p>}>
          <Index each={list()}>
            {(variable) => <VariableRow scope={props.scope} owner={props.owner} variable={variable()} shadowed={shadowed(variable().name)} />}
          </Index>
        </Show>
      </Show>
    </section>
  );
}

function VariableRow(props: { scope: VarScope; owner: string | null | undefined; variable: Variable; shadowed: VarScope | null }) {
  const save = (change: Partial<Variable>, previous?: string) => void saveVariable(props.scope, props.owner, { ...props.variable, ...change }, previous);
  return (
    <div class="vars-row" classList={{ shadowed: Boolean(props.shadowed) }} title={props.shadowed ? `En la consola activa vale el de ${props.shadowed === "console" ? "la consola" : "la conexión"}` : undefined}>
      <input
        class="vars-name"
        value={props.variable.name}
        spellcheck={false}
        aria-label="Nombre"
        onChange={(event) => {
          const name = event.currentTarget.value.trim().replace(/^\$\{(.*)\}$/, "$1");
          if (name === props.variable.name) return;
          if (!validVarName(name)) {
            notify("Nombre de variable no válido", "warning", "Letras, números y _, sin empezar por un número.");
            event.currentTarget.value = props.variable.name;
            return;
          }
          save({ name }, props.variable.name);
        }}
      />
      <input class="vars-value" value={props.variable.value} spellcheck={false} placeholder="Valor" aria-label={`Valor de ${props.variable.name}`} onChange={(event) => save({ value: event.currentTarget.value })} />
      <label class="check vars-raw" title="Escribir el valor tal cual, sin comillas (un nombre de tabla, una lista para IN…)">
        <input type="checkbox" checked={props.variable.raw ?? false} onChange={(event) => save({ raw: event.currentTarget.checked || undefined })} /> SQL
      </label>
      <button type="button" class="icon-btn" title={`Insertar \${${props.variable.name}} en la consola`} disabled={!activeSql()} onClick={() => insertIntoActive(`\${${props.variable.name}}`)}>
        <CornerDownLeft size={12} />
      </button>
      <button type="button" class="icon-btn" title="Borrar la variable" onClick={() => void deleteVariable(props.scope, props.owner, props.variable.name)}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}
