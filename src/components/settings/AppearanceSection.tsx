import { For } from "solid-js";
import { themeChoices } from "../../commands";
import { applyTheme, saveSettings, state } from "../../state";
import { ACCENTS, type ThemeName } from "../../types";
import { Field, NumberStepper } from "./controls";

/** Ajustes › Apariencia: theme, accent, density, interface size, Gib and animations. */
export function AppearanceSection() {
  const s = () => state.settings;
  return (
    <>
      <h4 data-setting="Tema">Tema</h4>
      <div class="theme-grid">
        <For each={themeChoices}>
          {(theme) => (
            <button
              type="button"
              class="theme-card"
              classList={{ on: s().theme === theme.id }}
              onMouseEnter={() => applyTheme(state.settings, theme.id)}
              onMouseLeave={() => applyTheme()}
              onClick={() => void saveSettings({ theme: theme.id as ThemeName })}
            >
              <ThemePreview theme={theme.id} />
              <span>{theme.label}</span>
            </button>
          )}
        </For>
      </div>
      <h4 data-setting="Color de acento">Color de acento</h4>
      <div class="swatches">
        <For each={ACCENTS}>
          {(item) => <button type="button" class="swatch big" classList={{ on: s().accent.toLowerCase() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} onClick={() => void saveSettings({ accent: item.value })} />}
        </For>
        <label class="swatch big custom" title="Personalizado">
          <input type="color" value={s().accent} onChange={(event) => void saveSettings({ accent: event.currentTarget.value })} />
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
        <Field label="Compañero (Gib)">
          <select value={s().companion} onChange={(event) => void saveSettings({ companion: event.currentTarget.value as "off" | "quiet" | "normal" })}>
            <option value="normal">Normal</option>
            <option value="quiet">Silencioso</option>
            <option value="off">Apagado</option>
          </select>
        </Field>
        <Field label="Animaciones">
          <select value={s().motion} onChange={(event) => void saveSettings({ motion: event.currentTarget.value as "system" | "reduce" | "full" })}>
            <option value="system">Como el sistema</option>
            <option value="reduce">Reducidas</option>
            <option value="full">Todas</option>
          </select>
        </Field>
      </div>
    </>
  );
}

/** A miniature of the real workspace rendered with a theme's tokens. */
export function ThemePreview(props: { theme: string }) {
  const theme = () => (props.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : props.theme);
  return (
    <div class="theme-preview" data-theme-preview={theme()}>
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
  );
}
