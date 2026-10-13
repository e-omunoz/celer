import { Dices, LoaderCircle, RotateCcw } from "lucide-solid";
import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { connectionById } from "../state";
import { GENERATORS, MAX_ROWS, previewRows, randomSeed, type GenKind } from "../testData";
import { cancelTestData, currentProblems, fillParentFirst, resetSettings, rowsPerSecond, runTestData, SCRIPT_CONSOLE_ROWS, setGenerator, setLocale, setSetting, setTestData, testData, type TestDataOutput } from "../testDataRun";
import type { SheetCell } from "../importFormats";
import { ObjIcon } from "../icons";
import { Dialog } from "./Modals";

const OUTPUTS: [TestDataOutput, string][] = [
  ["insert", "Insertar en la tabla"],
  ["script", "Script SQL"],
  ["csv", "CSV"],
  ["json", "JSON"],
];

const GROUPS = [...new Set(GENERATORS.map((g) => g.group))];

/** A cell as the preview shows it. */
function shown(cell: SheetCell | undefined): string {
  if (cell === null || cell === undefined) return "NULL";
  if (typeof cell === "object") return "d" in cell ? cell.d : cell.t;
  return String(cell);
}

/** Inputs for a generator's parameters. */
function Params(props: { index: number }) {
  const s = () => testData.settings[props.index];
  const c = () => testData.model!.columns[props.index];
  const input = (key: "min" | "max" | "scale" | "start" | "step" | "value" | "pattern" | "template", placeholder: string, title: string, wide = false) => (
    <input
      class="td-param"
      classList={{ wide }}
      value={s()[key]}
      placeholder={placeholder}
      title={title}
      spellcheck={false}
      disabled={testData.running}
      onInput={(event) => setSetting(props.index, key, event.currentTarget.value)}
    />
  );
  const kind = () => s().kind;
  const fk = () => {
    const ref = c().fk;
    return ref ? testData.model!.fks[ref.key] : undefined;
  };
  return (
    <div class="td-params">
      <Show when={["integer", "quantity", "decimal", "price"].includes(kind())}>
        {input("min", "desde", "Valor mínimo")}
        {input("max", "hasta", "Valor máximo")}
        <Show when={kind() === "decimal" || kind() === "price"}>{input("scale", "decimales", "Dígitos tras la coma")}</Show>
      </Show>
      <Show when={kind() === "date" || kind() === "datetime"}>
        {input("min", "aaaa-mm-dd", "Desde (aaaa-mm-dd)")}
        {input("max", "aaaa-mm-dd", "Hasta (aaaa-mm-dd)")}
      </Show>
      <Show when={kind() === "time"}>
        {input("min", "hh:mm:ss", "Desde")}
        {input("max", "hh:mm:ss", "Hasta")}
      </Show>
      <Show when={kind() === "sequence"}>
        {input("start", "empieza en", "Primer valor")}
        {input("step", "incremento", "Incremento (1 por defecto)")}
      </Show>
      <Show when={kind() === "constant"}>{input("value", "valor", "El mismo valor en todas las filas", true)}</Show>
      <Show when={kind() === "pattern"}>{input("pattern", "[A-Z]{3}-\\d{4}", "Patrón: [A-Z] clases, \\d dígito, \\l minúscula, \\u mayúscula, {n} {n,m} ? repeticiones, (a|b) alternativas", true)}</Show>
      <Show when={kind() === "expression"}>{input("template", "{nombre|slug}.{apellidos|slug}@example.com", "Texto con {columna}, {columna|lower|upper|slug|initial} y {#} (número de fila)", true)}</Show>
      <Show when={kind() === "list"}>
        <textarea
          class="td-param wide"
          rows={2}
          value={s().values}
          placeholder={"un valor por línea\nactivo *3 (pesa el triple)"}
          title="Un valor por línea; «valor *3» sale el triple de veces"
          spellcheck={false}
          disabled={testData.running}
          onInput={(event) => setSetting(props.index, "values", event.currentTarget.value)}
        />
      </Show>
      <Show when={kind() === "fk" && fk()}>
        {(key) => (
          <span class="td-note" title={`Clave ${key().name}`}>
            → {key().target.name} ({key().targetColumns.join(", ")}) · {key().rows.length.toLocaleString("es-ES")} {key().rows.length === 1 ? "clave" : "claves"}
          </span>
        )}
      </Show>
    </div>
  );
}

export function TestDataDialog() {
  const problems = createMemo(() => currentProblems());
  const errors = createMemo(() => problems().filter((p) => p.error));
  const preview = createMemo(() => (testData.model ? previewRows(testData.model, testData.settings, testData.seed, testData.locale, 20) : null));
  const conn = () => connectionById(testData.connId);
  const readOnlyInsert = () => testData.output === "insert" && Boolean(conn()?.readOnly);
  const [tick, setTick] = createSignal(0);
  // The rate while it runs (rows per second), refreshed twice a second.
  onMount(() => {
    const timer = window.setInterval(() => testData.running && setTick((n) => n + 1), 500);
    onCleanup(() => window.clearInterval(timer));
  });
  const rate = () => (tick(), rowsPerSecond());
  const actionLabel = () => {
    const n = testData.count > 0 ? testData.count.toLocaleString("es-ES") : "";
    if (testData.output === "insert") return `Insertar ${n} filas`;
    if (testData.output === "script") return testData.count > SCRIPT_CONSOLE_ROWS ? "Guardar script .sql…" : "Abrir script en consola";
    return `Exportar ${testData.output.toUpperCase()}…`;
  };
  const columnProblems = (index: number) => problems().filter((p) => p.column === index);
  const example = (index: number) => {
    const p = preview();
    if (!p || p.error || !p.rows.length || !p.written.includes(index)) return "";
    return shown(p.rows[0][index]);
  };
  const badges = (index: number) => {
    const c = testData.model!.columns[index];
    const out: { text: string; title: string }[] = [];
    if (c.col.primaryKey) out.push({ text: "PK", title: "Clave primaria" });
    if (c.auto) out.push({ text: "AUTO", title: "La rellena el servidor (identidad, serial, calculada)" });
    if (c.fk) out.push({ text: "FK", title: `Clave foránea a ${testData.model!.fks[c.fk.key].target.name}` });
    if (c.unique && !c.col.primaryKey) out.push({ text: "ÚNICA", title: "Valores sin repetir" });
    if (c.values) out.push({ text: "LISTA", title: `Valores permitidos (enum o CHECK): ${c.values.join(", ")}` });
    if (c.rule) out.push({ text: "CHECK", title: `Rango: ${c.rule.min ?? "…"} a ${c.rule.max ?? "…"}` });
    if (c.col.nullable) out.push({ text: "NULL", title: "Admite NULL" });
    return out;
  };

  return (
    <Dialog title={`Generar datos de prueba en ${testData.obj?.name ?? ""}`} wide class="testdata-dialog" onClose={cancelTestData}>
      <div class="testdata-body">
        <Show when={testData.loading}>
          <div class="export-progress">
            <LoaderCircle size={15} class="spin" />
            <span>Leyendo la tabla: columnas, claves, restricciones y claves de las tablas referenciadas…</span>
          </div>
        </Show>
        <Show when={testData.error}>
          <p class="import-warn">{testData.error}</p>
        </Show>
        <Show when={testData.model}>
          {(model) => (
            <>
              <div class="import-opts td-opts">
                <label class="field td-count">
                  <span>Filas</span>
                  <input
                    type="number"
                    min="1"
                    max={MAX_ROWS}
                    value={testData.count}
                    disabled={testData.running}
                    onInput={(event) => setTestData("count", Math.floor(Number(event.currentTarget.value) || 0))}
                  />
                </label>
                <label class="field td-seed" title="La misma semilla con los mismos ajustes da siempre las mismas filas">
                  <span>Semilla</span>
                  <div class="td-seed-row">
                    <input type="number" min="1" value={testData.seed} disabled={testData.running} onInput={(event) => setTestData("seed", Math.floor(Number(event.currentTarget.value) || 0))} />
                    <button type="button" class="icon-btn" title="Otra semilla" disabled={testData.running} onClick={() => setTestData("seed", randomSeed())}>
                      <Dices size={15} />
                    </button>
                  </div>
                </label>
                <div class="field">
                  <span>Datos</span>
                  <div class="seg">
                    <button type="button" classList={{ on: testData.locale === "es" }} disabled={testData.running} onClick={() => setLocale("es")}>Español</button>
                    <button type="button" classList={{ on: testData.locale === "en" }} disabled={testData.running} onClick={() => setLocale("en")}>English</button>
                  </div>
                </div>
                <div class="field">
                  <span>Resultado</span>
                  <div class="seg">
                    <For each={OUTPUTS}>
                      {([value, label]) => (
                        <button type="button" classList={{ on: testData.output === value }} disabled={testData.running} onClick={() => setTestData("output", value)}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
              <Show when={readOnlyInsert()}>
                <p class="import-warn">La conexión es de solo lectura: no se puede insertar. Genera el script o exporta a CSV / JSON.</p>
              </Show>
              <Show when={testData.output === "insert" && conn()?.production}>
                <p class="import-warn">Conexión de producción: se pedirá confirmación antes de insertar.</p>
              </Show>
              <div class="td-tabs">
                <div class="seg small">
                  <button type="button" classList={{ on: testData.view === "columns" }} onClick={() => setTestData("view", "columns")}>Columnas</button>
                  <button type="button" classList={{ on: testData.view === "preview" }} onClick={() => setTestData("view", "preview")}>Vista previa (20 filas)</button>
                </div>
                <span class="spacer" />
                <Show when={testData.view === "columns"}>
                  <button type="button" class="btn tiny" disabled={testData.running} title="Vuelve a proponer el generador de cada columna" onClick={resetSettings}>
                    <RotateCcw size={12} /> Proponer de nuevo
                  </button>
                </Show>
                <Show when={testData.view === "preview"}>
                  <button type="button" class="btn tiny" disabled={testData.running} onClick={() => setTestData("seed", randomSeed())}>
                    <Dices size={12} /> Otra semilla
                  </button>
                </Show>
              </div>
              <Show when={testData.view === "columns"}>
                <div class="import-map td-map">
                  <div class="td-row td-head">
                    <span>Columna</span>
                    <span>Generador</span>
                    <span>Parámetros</span>
                    <span title="Porcentaje de filas con NULL">NULL %</span>
                    <span>Ejemplo</span>
                  </div>
                  <Index each={model().columns}>
                    {(col, index) => (
                      <div class="td-item" classList={{ skipped: testData.settings[index]?.kind === "skip" }}>
                        <div class="td-row">
                          <span class="cell-icon td-col" title={`${col().col.name} · ${col().col.typeName}`}>
                            <ObjIcon kind={col().col.primaryKey ? "pkcolumn" : "column"} size={13} />
                            <b>{col().col.name}</b>
                            <small>{col().col.typeName}</small>
                            <span class="td-badges">
                              <For each={badges(index)}>{(badge) => <span class="tag tiny" title={badge.title}>{badge.text}</span>}</For>
                            </span>
                          </span>
                          <select
                            value={testData.settings[index]?.kind}
                            title={GENERATORS.find((g) => g.kind === testData.settings[index]?.kind)?.label}
                            disabled={testData.running}
                            onChange={(event) => setGenerator(index, event.currentTarget.value as GenKind)}
                          >
                            <For each={GROUPS}>
                              {(group) => (
                                <optgroup label={group}>
                                  <For each={GENERATORS.filter((g) => g.group === group && (g.kind !== "fk" || col().fk))}>{(g) => <option value={g.kind}>{g.label}</option>}</For>
                                </optgroup>
                              )}
                            </For>
                          </select>
                          <Params index={index} />
                          <Show when={col().col.nullable && !["skip", "null"].includes(testData.settings[index]?.kind)} fallback={<span />}>
                            <input
                              class="td-null"
                              type="number"
                              min="0"
                              max="100"
                              value={testData.settings[index]?.nullPct}
                              disabled={testData.running}
                              onInput={(event) => setSetting(index, "nullPct", Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)))}
                            />
                          </Show>
                          <code title={example(index)}>{example(index)}</code>
                        </div>
                        <For each={columnProblems(index)}>
                          {(p) => (
                            <p class="td-problem" classList={{ error: p.error }}>
                              {p.text}
                              <Show when={p.parent}>
                                {(parent) => (
                                  <button type="button" class="btn tiny" disabled={testData.running} onClick={() => fillParentFirst(parent())}>
                                    Generar antes datos de {parent().name}
                                  </button>
                                )}
                              </Show>
                            </p>
                          )}
                        </For>
                      </div>
                    )}
                  </Index>
                </div>
              </Show>
              <Show when={testData.view === "preview"}>
                <div class="td-preview">
                  <Show when={preview()?.error} fallback={
                    <table>
                      <thead>
                        <tr>
                          <For each={preview()?.written ?? []}>{(i) => <th>{model().columns[i].col.name}</th>}</For>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={preview()?.rows ?? []}>
                          {(row) => (
                            <tr>
                              <For each={preview()?.written ?? []}>{(i) => <td classList={{ null: row[i] === null, num: model().columns[i].col.kind === "number" }} title={shown(row[i])}>{shown(row[i])}</td>}</For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  }>
                    <p class="import-warn">{preview()?.error}</p>
                  </Show>
                </div>
              </Show>
              <For each={problems().filter((p) => p.column < 0)}>{(p) => <p class="td-problem" classList={{ error: p.error }}>{p.text}</p>}</For>
              <Show when={testData.running}>
                <div class="export-progress">
                  <LoaderCircle size={15} class="spin" />
                  <span>
                    {testData.phase}… <b>{testData.done.toLocaleString("es-ES")}</b> de {testData.total.toLocaleString("es-ES")} filas
                    <Show when={rate()}> · {rate().toLocaleString("es-ES")} filas/s</Show>
                  </span>
                  <span class="spacer" />
                  <div class="mini-progress"><i style={{ width: `${testData.total ? (testData.done / testData.total) * 100 : 0}%` }} /></div>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
      <footer>
        <span class="muted small">
          {testData.output === "insert" ? "Todo en una sola transacción: si una fila falla, o cancelas, no se guarda ninguna." : "No se toca la base de datos."}
        </span>
        <span class="spacer" />
        <button type="button" class="btn" onClick={cancelTestData}>{testData.running ? "Cancelar" : "Cerrar"}</button>
        <button
          type="button"
          class="btn primary"
          disabled={!testData.model || testData.running || errors().length > 0 || readOnlyInsert() || testData.count < 1 || testData.count > MAX_ROWS}
          title={errors()[0]?.text ?? ""}
          onClick={() => void runTestData()}
        >
          {actionLabel()}
        </button>
      </footer>
    </Dialog>
  );
}
