import { Pencil, Plus } from "lucide-solid";
import { For } from "solid-js";
import { themeChoices } from "../../commands";
import { applyTheme, saveSettings, state } from "../../state";
import { themeVars, type CustomTheme } from "../../themes";
import { activeCustomTheme, choiceOf, openThemeEditor, setAccent } from "../../themeStore";
import { ACCENTS, type ThemeChoice } from "../../types";
import { GibSettings } from "../GibSettings";
import { Field, NumberStepper } from "./controls";

/** Ajustes › Apariencia: theme (built-in and custom), accent, density, interface size, Gib and animations. */
export function AppearanceSection() {
  const s = () => state.settings;
  /** The accent in use: the custom theme's own when it has one (setAccent changes that one), else Ajustes'. */
  const accent = () => activeCustomTheme()?.colors["--accent"] ?? s().accent;
  /** The colour picker takes only #rrggbb: a theme's rgb()/hsl() accent shows the global one there. */
  const accentHex = () => (/^#[0-9a-f]{6}$/i.test(accent()) ? accent() : s().accent);
  /** What «Seguir al sistema» may pick for each mode: every theme but "system" itself, custom ones included. */
  const choices = () => [
    ...themeChoices.filter((theme) => theme.id !== "system").map((theme) => ({ id: theme.id as string, label: theme.label })),
    ...s().customThemes.map((theme) => ({ id: choiceOf(theme) as string, label: theme.name })),
  ];
  return (
    <>
      <div class="settings-title-row">
        <h4 data-setting="Tema">Tema</h4>
        <span class="spacer" />
        <button type="button" class="btn tiny" onClick={() => openThemeEditor("")}><Pencil size={12} /> Editor de tema</button>
      </div>
      <div class="theme-grid">
        <For each={themeChoices}>
          {(theme) => (
            <button
              type="button"
              class="theme-card"
              classList={{ on: s().theme === theme.id }}
              onMouseEnter={() => applyTheme(state.settings, theme.id)}
              onMouseLeave={() => applyTheme()}
              onClick={() => void saveSettings({ theme: theme.id as ThemeChoice })}
            >
              <ThemePreview theme={theme.id} />
              <span>{theme.label}</span>
            </button>
          )}
        </For>
        <For each={s().customThemes}>
          {(theme) => (
            <div class="theme-card custom" classList={{ on: s().theme === choiceOf(theme) }}>
              <button
                type="button"
                class="theme-card-pick"
                onMouseEnter={() => applyTheme(state.settings, choiceOf(theme))}
                onMouseLeave={() => applyTheme()}
                onClick={() => void saveSettings({ theme: choiceOf(theme) })}
              >
                <ThemePreview theme={theme.base} custom={theme} />
                <span>{theme.name}</span>
              </button>
              <button
                type="button"
                class="icon-btn tiny theme-card-edit"
                title={`Editar «${theme.name}»`}
                aria-label={`Editar «${theme.name}»`}
                onClick={() => openThemeEditor(theme.id)}
              >
                <Pencil size={11} />
              </button>
            </div>
          )}
        </For>
        <button type="button" class="theme-card new" onClick={() => openThemeEditor("new")}>
          <span class="theme-new-icon"><Plus size={18} /></span>
          <span>Nuevo tema…</span>
        </button>
      </div>
      <div class="form-row system-themes">
        <Field label="Con el sistema en modo claro">
          <select value={s().systemLight} onChange={(event) => void saveSettings({ systemLight: event.currentTarget.value as ThemeChoice })}>
            <For each={choices()}>{(item) => <option value={item.id}>{item.label}</option>}</For>
          </select>
        </Field>
        <Field label="Con el sistema en modo oscuro">
          <select value={s().systemDark} onChange={(event) => void saveSettings({ systemDark: event.currentTarget.value as ThemeChoice })}>
            <For each={choices()}>{(item) => <option value={item.id}>{item.label}</option>}</For>
          </select>
        </Field>
      </div>
      <p class="settings-note">«Seguir al sistema» usa estos dos; también pueden ser temas propios.</p>
      <h4 data-setting="Color de acento">Color de acento</h4>
      <div class="swatches">
        <For each={ACCENTS}>
          {(item) => <button type="button" class="swatch big" classList={{ on: accent().toLowerCase() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} onClick={() => void setAccent(item.value)} />}
        </For>
        <label class="swatch big custom" title="Personalizado">
          <input type="color" value={accentHex()} onChange={(event) => void setAccent(event.currentTarget.value)} />
        </label>
      </div>
      <div class="form-row">
        <Field label="Densidad">
          <div class="seg">
            <button type="button" classList={{ on: s().density === "compact" }} onClick={() => void saveSettings({ density: "compact" })}>Compacta</button>
            <button type="button" classList={{ on: s().density === "comfortable" }} onClick={() => void saveSettings({ density: "comfortable" })}>Cómoda</button>
          </div>
        </Field>
        <Field label="Tamaño de la interfaz">
          <NumberStepper value={s().fontSize} min={11} max={18} onChange={(value) => void saveSettings({ fontSize: value })} />
        </Field>
        <Field label="Animaciones">
          <select value={s().motion} onChange={(event) => void saveSettings({ motion: event.currentTarget.value as "system" | "reduce" | "full" })}>
            <option value="system">Como el sistema</option>
            <option value="reduce">Reducidas</option>
            <option value="full">Todas</option>
          </select>
        </Field>
      </div>
      <h4 data-setting="Gib">Gib</h4>
      <GibSettings />
    </>
  );
}

/**
 * A miniature of the real workspace rendered with a theme's tokens (and a custom theme's own on top). The dark
 * tokens go first, as every theme starts from them, so a theme that redefines only some never borrows the others
 * from the theme in use.
 */
export function ThemePreview(props: { theme: string; custom?: CustomTheme }) {
  const theme = () => (props.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : props.theme);
  return (
    <div class="theme-preview-base" data-theme-preview="dark">
      <div class="theme-preview" data-theme-preview={theme()} style={props.custom ? themeVars(props.custom) : undefined}>
        <div class="tp-side">
          <i /><i /><i class="t" /><i class="t" /><i />
        </div>
        <div class="tp-main">
          <div class="tp-code">
            <span class="k">SELECT</span> <span class="n">id</span>, <span class="f">count</span>(*)<br />
            <span class="k">FROM</span> <span class="t">orders</span> <span class="k">WHERE</span> <span class="s">'ok'</span>
          </div>
          <div class="tp-grid"><i /><i /><i /></div>
        </div>
      </div>
    </div>
  );
}
