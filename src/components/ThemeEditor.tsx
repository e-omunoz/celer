// Ajustes › Apariencia › Editor de tema: a custom theme from any built-in one, every token grouped, fonts, radius,
// row height, shadows and animation speed, a contrast checker, and the themes saved, duplicated, renamed, deleted,
// exported and imported. The whole interface shows the theme being edited live (state.ts, themeDraft).

import { Copy, Download, Plus, RotateCcw, Trash2, TriangleAlert, Upload } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { contrastOf, parseColor, toHex, wcagLevel } from "../contrast";
import { applyTheme, confirmDialog, currentTheme, setThemeDraft, state } from "../state";
import { activeCustomTheme, choiceOf, customThemeById, deleteCustomTheme, endThemePreview, exportCustomTheme, importCustomTheme, saveCustomTheme } from "../themeStore";
import {
  BUILTIN_THEMES,
  CONTRAST_PAIRS,
  EDITOR_FONTS,
  MOTION_SPEEDS,
  RADIUS_RANGE,
  ROW_RANGE,
  SHADOWS,
  TOKEN_GROUPS,
  UI_FONTS,
  blankTheme,
  duplicateTheme,
  isSafeColor,
  newThemeId,
  uniqueThemeName,
  type BuiltinTheme,
  type CustomTheme,
  type ShadowLevel,
} from "../themes";
import { Gib } from "../gib/Gib";
import { ObjIcon } from "../icons";

const ALL_NAMES = TOKEN_GROUPS.flatMap((group) => group.tokens.map((token) => token.name));

/** What every token comes to now, as the browser computed it (rgb()/color()), read through a hidden probe. */
function readTokens(): Record<string, string> {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const out: Record<string, string> = {};
  try {
    for (const name of ALL_NAMES) {
      probe.style.color = "";
      probe.style.color = `var(${name})`;
      out[name] = getComputedStyle(probe).color;
    }
  } finally {
    probe.remove();
  }
  return out;
}

/** A colour the browser understands (and the theme may hold: no url(), nothing that loads). */
function validColor(value: string): boolean {
  return isSafeColor(value) && (typeof CSS === "undefined" || CSS.supports("color", value));
}

const same = (a: CustomTheme | null, b: CustomTheme | null) => JSON.stringify(a) === JSON.stringify(b);

export function ThemeEditor(props: { onBack: () => void; edit?: string }) {
  const names = (except = "") => state.settings.customThemes.filter((theme) => theme.id !== except).map((theme) => theme.name);
  const fresh = (base: BuiltinTheme): CustomTheme => ({
    ...blankTheme(newThemeId(), uniqueThemeName("Mi tema", names()), base),
    // The accent goes with the theme: exported, it looks the same on a machine with another accent.
    colors: { "--accent": state.settings.accent },
  });
  // "new": a new theme from the one in use; an id: that theme; nothing: the custom theme in use, or a new one.
  const first = (props.edit !== "new" && ((props.edit && customThemeById(props.edit)) || activeCustomTheme())) || fresh(currentTheme().base);
  /** The theme as last saved (null: new, not saved yet). */
  const [saved, setSaved] = createSignal<CustomTheme | null>(customThemeById(first.id) ?? null);
  const [draft, setDraft] = createSignal<CustomTheme>(structuredClone(first));
  const [group, setGroup] = createSignal("general");
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [bad, setBad] = createSignal<Record<string, string>>({});
  const dirty = () => !same(saved(), draft());

  // Live: the whole interface shows the draft, and the colours it comes to are read back for the fields.
  createEffect(() => {
    const next = structuredClone(draft());
    untrack(() => {
      setThemeDraft(next);
      applyTheme();
      setValues(readTokens());
    });
  });
  onCleanup(endThemePreview);

  const update = (patch: Partial<CustomTheme>) => setDraft({ ...draft(), ...patch });
  const setColor = (name: string, value: string | null) => {
    const colors = { ...draft().colors };
    if (value === null) delete colors[name];
    else colors[name] = value;
    // A new accent brings its own readable label unless the label was chosen too.
    if (name === "--accent" && value !== null && !saved()?.colors["--accent-fg"]) delete colors["--accent-fg"];
    setBad({ ...bad(), [name]: "" });
    update({ colors });
  };

  async function leaveChanges(): Promise<boolean> {
    if (!dirty()) return true;
    return confirmDialog("¿Descartar los cambios del tema?", `«${draft().name}» tiene cambios sin guardar.`, "Descartar", true);
  }

  async function switchTo(theme: CustomTheme, isSaved: boolean) {
    if (!(await leaveChanges())) return;
    setSaved(isSaved ? theme : null);
    setDraft(structuredClone(theme));
    setBad({});
  }

  async function save(use: boolean) {
    const theme = { ...draft(), name: uniqueThemeName(draft().name, names(draft().id)) };
    await saveCustomTheme(theme, use);
    setDraft(theme);
    setSaved(structuredClone(theme));
  }

  async function remove() {
    const current = saved();
    if (!current) {
      // Never saved: there is nothing to delete, only the draft to drop.
      const other = state.settings.customThemes[0];
      setSaved(other ?? null);
      setDraft(other ? structuredClone(other) : fresh(draft().base));
      return;
    }
    if (!(await deleteCustomTheme(current))) return;
    const other = state.settings.customThemes[0];
    setSaved(other ?? null);
    setDraft(other ? structuredClone(other) : fresh(current.base));
  }

  async function back() {
    if (!(await leaveChanges())) return;
    endThemePreview();
    props.onBack();
  }

  const lowContrast = createMemo(() => CONTRAST_PAIRS.filter((pair) => {
    const ratio = pairRatio(pair, values());
    return ratio !== null && ratio < pair.min;
  }).length);

  return (
    <div class="theme-editor">
      <div class="te-head">
        <button type="button" class="btn tiny" onClick={() => void back()}>← Apariencia</button>
        <select
          class="te-pick"
          title="Tema que se edita"
          value={draft().id}
          onChange={(event) => {
            const id = event.currentTarget.value;
            const theme = customThemeById(id);
            if (theme) void switchTo(theme, true);
            event.currentTarget.value = draft().id;
          }}
        >
          <Show when={!saved()}><option value={draft().id}>{draft().name} (sin guardar)</option></Show>
          <For each={state.settings.customThemes}>{(theme) => <option value={theme.id}>{theme.name}</option>}</For>
        </select>
        <input class="te-name" aria-label="Nombre del tema" value={draft().name} maxLength={60} onInput={(event) => update({ name: event.currentTarget.value })} />
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Tema nuevo" onClick={() => void switchTo(fresh(draft().base), false)}><Plus size={15} /></button>
        <button type="button" class="icon-btn" title="Duplicar" onClick={() => void switchTo(duplicateTheme(draft(), newThemeId(), state.settings.customThemes.map((t) => t.name)), false)}><Copy size={15} /></button>
        <button type="button" class="icon-btn" title="Importar un tema (JSON)" onClick={() => void (async () => {
          if (!(await leaveChanges())) return;
          const theme = await importCustomTheme();
          if (theme) {
            setSaved(theme);
            setDraft(structuredClone(theme));
          }
        })()}><Upload size={15} /></button>
        <button type="button" class="icon-btn" title="Exportar a un fichero (JSON)" onClick={() => void exportCustomTheme(draft())}><Download size={15} /></button>
        <button type="button" class="icon-btn danger" title="Borrar el tema" onClick={() => void remove()}><Trash2 size={15} /></button>
      </div>

      <div class="te-layout">
        <div class="te-controls">
          <div class="te-groups" role="tablist">
            <button type="button" role="tab" classList={{ on: group() === "general" }} onClick={() => setGroup("general")}>General</button>
            <For each={TOKEN_GROUPS}>
              {(item) => (
                <button type="button" role="tab" classList={{ on: group() === item.id }} onClick={() => setGroup(item.id)}>
                  {item.label}
                  <Show when={item.tokens.some((token) => draft().colors[token.name])}><i class="te-changed" title="Con cambios" /></Show>
                </button>
              )}
            </For>
          </div>
          <div class="te-fields">
            <Show when={group() === "general"}>
              <label class="field">
                <span>Tema base</span>
                <select value={draft().base} onChange={(event) => update({ base: event.currentTarget.value as BuiltinTheme })}>
                  <For each={BUILTIN_THEMES}>{(theme) => <option value={theme.id}>{theme.label}</option>}</For>
                </select>
                <small class="field-hint">Lo que no cambies se toma de él; también decide si el tema es claro u oscuro.</small>
              </label>
              <label class="field">
                <span>Fuente de la interfaz</span>
                <input list="te-ui-fonts" placeholder="Inter (la de serie)" value={draft().uiFont} onChange={(event) => update({ uiFont: event.currentTarget.value.trim() })} />
                <datalist id="te-ui-fonts"><For each={UI_FONTS}>{(font) => <option value={font} />}</For></datalist>
              </label>
              <label class="field">
                <span>Fuente del editor y de las tablas</span>
                <input list="te-mono-fonts" placeholder="JetBrains Mono (la de serie)" value={draft().editorFont} onChange={(event) => update({ editorFont: event.currentTarget.value.trim() })} />
                <datalist id="te-mono-fonts"><For each={EDITOR_FONTS}>{(font) => <option value={font} />}</For></datalist>
              </label>
              <Range
                label="Radio de las esquinas"
                value={draft().radius}
                fallback={8}
                range={RADIUS_RANGE}
                onChange={(radius) => update({ radius })}
              />
              <Range
                label="Altura de las filas de resultados"
                value={draft().rowHeight}
                fallback={state.settings.density === "comfortable" ? 28 : 24}
                range={ROW_RANGE}
                hint="Sin fijar, la da Densidad."
                onChange={(rowHeight) => update({ rowHeight })}
              />
              <label class="field">
                <span>Sombras</span>
                <select value={draft().shadow} onChange={(event) => update({ shadow: event.currentTarget.value as ShadowLevel })}>
                  <For each={SHADOWS}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                </select>
              </label>
              <label class="field">
                <span>Velocidad de las animaciones</span>
                <select value={String(draft().motionScale)} onChange={(event) => update({ motionScale: Number(event.currentTarget.value) })}>
                  <For each={MOTION_SPEEDS}>{(item) => <option value={String(item.value)}>{item.label}</option>}</For>
                </select>
                <small class="field-hint">Con Animaciones en «Reducidas» casi no hay movimiento, sea cual sea la velocidad.</small>
              </label>
            </Show>
            <For each={TOKEN_GROUPS}>
              {(item) => (
                <Show when={group() === item.id}>
                  <For each={item.tokens}>
                    {(token) => {
                      const own = () => draft().colors[token.name];
                      const shown = () => own() ?? values()[token.name] ?? "";
                      const hex = () => {
                        const parsed = parseColor(values()[token.name] ?? "");
                        return parsed ? toHex(parsed) : "#000000";
                      };
                      return (
                        <div class="te-token" classList={{ changed: Boolean(own()), invalid: Boolean(bad()[token.name]) }}>
                          <label class="te-swatch" title="Elegir el color" style={{ background: values()[token.name] }}>
                            <input
                              type="color"
                              value={hex()}
                              onInput={(event) => {
                                // A translucent token keeps its transparency.
                                const alpha = parseColor(values()[token.name] ?? "")?.a ?? 1;
                                const picked = event.currentTarget.value;
                                const c = parseColor(picked)!;
                                setColor(token.name, alpha < 1 ? `rgb(${c.r} ${c.g} ${c.b} / ${+alpha.toFixed(3)})` : picked);
                              }}
                            />
                          </label>
                          <span class="te-label">
                            {token.label}
                            <code>{token.name}</code>
                          </span>
                          <input
                            class="te-value"
                            spellcheck={false}
                            value={own() ?? ""}
                            placeholder={shown()}
                            aria-label={`${token.label}: color`}
                            onChange={(event) => {
                              const value = event.currentTarget.value.trim();
                              if (!value) setColor(token.name, null);
                              else if (validColor(value)) setColor(token.name, value);
                              else setBad({ ...bad(), [token.name]: value });
                            }}
                          />
                          <button type="button" class="icon-btn tiny" title="Volver al color del tema base" disabled={!own()} onClick={() => setColor(token.name, null)}>
                            <RotateCcw size={12} />
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              )}
            </For>
          </div>
        </div>

        <div class="te-side">
          <ThemeSample />
          <div class="te-contrast">
            <div class="te-contrast-head">
              <b>Contraste</b>
              <Show when={lowContrast()} fallback={<span class="te-ok">Todo cumple AA</span>}>
                <span class="te-warn"><TriangleAlert size={13} /> {lowContrast() === 1 ? "1 par por debajo de AA" : `${lowContrast()} pares por debajo de AA`}</span>
              </Show>
            </div>
            <ul>
              <For each={CONTRAST_PAIRS}>
                {(pair) => {
                  const ratio = () => pairRatio(pair, values());
                  const low = () => ratio() !== null && ratio()! < pair.min;
                  return (
                    <li classList={{ low: low() }} title={`${pair.fg} sobre ${pair.bg} · mínimo ${pair.min}:1`}>
                      <span class="te-aa" style={{ color: values()[pair.fg], background: values()[pair.bg] }}>Aa</span>
                      <span class="te-pair">{pair.label}</span>
                      <span class="te-ratio">{ratio() === null ? "—" : `${ratio()!.toFixed(1)}:1`}</span>
                      <span class="te-level" classList={{ low: low() }}>{ratio() === null ? "" : low() ? "Bajo" : wcagLevel(ratio()!) || "OK"}</span>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </div>
      </div>

      <footer class="te-foot">
        <span class="muted small">{dirty() ? "Cambios sin guardar: lo que ves es una vista previa." : saved() ? "Guardado." : ""}</span>
        <span class="spacer" />
        <button type="button" class="btn" disabled={!dirty() || !saved()} onClick={() => saved() && setDraft(structuredClone(saved()!))}>Descartar cambios</button>
        <button type="button" class="btn" disabled={!dirty()} onClick={() => void save(false)}>Guardar</button>
        <button type="button" class="btn primary" disabled={!dirty() && state.settings.theme === choiceOf(draft())} onClick={() => void save(true)}>Guardar y usar</button>
      </footer>
    </div>
  );
}

function pairRatio(pair: (typeof CONTRAST_PAIRS)[number], values: Record<string, string>): number | null {
  const fg = values[pair.fg];
  const bg = values[pair.bg];
  if (!fg || !bg) return null;
  return contrastOf(fg, bg, values[pair.under ?? "--bg"] || "#ffffff");
}

function Range(props: { label: string; value: number | null; fallback: number; range: { min: number; max: number }; hint?: string; onChange: (value: number | null) => void }) {
  return (
    <div class="field te-range">
      <span>{props.label}</span>
      <div class="te-range-row">
        <input
          type="range"
          min={props.range.min}
          max={props.range.max}
          value={props.value ?? props.fallback}
          aria-label={props.label}
          onInput={(event) => props.onChange(Number(event.currentTarget.value))}
        />
        <span class="te-range-value">{props.value ?? props.fallback} px</span>
        <button type="button" class="icon-btn tiny" title="La del tema base" disabled={props.value === null} onClick={() => props.onChange(null)}>
          <RotateCcw size={12} />
        </button>
      </div>
      <Show when={props.hint}><small class="field-hint">{props.hint}</small></Show>
    </div>
  );
}

/** The real interface in small: explorer, tabs, toolbar, editor, results, a dialog and Gib, with the live tokens. */
function ThemeSample() {
  return (
    <div class="te-sample" aria-label="Vista previa">
      <div class="te-s-side">
        <div class="tree-row conn"><ObjIcon kind="database" size={14} /><span class="tree-name">ventas</span></div>
        <div class="tree-row selected"><ObjIcon kind="table" size={14} /><span class="tree-name">clientes</span></div>
        <div class="tree-row"><ObjIcon kind="view" size={14} /><span class="tree-name">pedidos_abiertos</span></div>
        <div class="tree-row"><ObjIcon kind="routine" size={14} /><span class="tree-name">total_mes</span></div>
        <div class="te-s-gib"><Gib size={40} plain /></div>
      </div>
      <div class="te-s-main">
        <div class="tabbar">
          <div class="tab on"><span class="tab-strip" style={{ background: "var(--accent)" }} /><span class="tab-title">consulta.sql</span></div>
          <div class="tab"><span class="tab-title">clientes</span><span class="tab-dirty" /></div>
        </div>
        <div class="pane-toolbar">
          <button type="button" class="tb-btn run" tabIndex={-1}>▶ Ejecutar</button>
          <button type="button" class="tb-icon on" tabIndex={-1}><ObjIcon kind="table" size={14} /></button>
          <span class="tag warn">Transacción</span>
        </div>
        <pre class="te-s-code">
          <span class="te-k">SELECT</span> c.<span class="te-n">id</span>, <span class="te-f">count</span>(*) <span class="te-c">-- pedidos</span>{"\n"}
          <span class="te-k">FROM</span> <span class="te-t">clientes</span> c <span class="te-k">WHERE</span> c.pais = <span class="te-s">'ES'</span>{"\n"}
          <span class="te-k">AND</span> c.alta {">"} <span class="te-p">:desde</span> <span class="te-k">LIMIT</span> <span class="te-num">100</span>;
        </pre>
        <div class="te-s-grid">
          <div class="te-s-row head"><span>id</span><span>nombre</span><span>saldo</span></div>
          <div class="te-s-row"><span class="num">1</span><span>Ana</span><span class="num">1.250,00</span></div>
          <div class="te-s-row alt"><span class="num">2</span><span class="sel">Luis</span><span class="num">310,40</span></div>
          <div class="te-s-row"><span class="num">3</span><span class="mod">Marta</span><span class="num">0,00</span></div>
        </div>
        <div class="te-s-dialog">
          <div class="field"><span>Nombre</span><input tabIndex={-1} value="Producción" readOnly /></div>
          <div class="te-s-buttons">
            <span class="te-s-state ok">Conectado</span>
            <span class="te-s-state err">Error</span>
            <span class="spacer" />
            <button type="button" class="btn tiny" tabIndex={-1}>Cancelar</button>
            <button type="button" class="btn tiny primary" tabIndex={-1}>Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
