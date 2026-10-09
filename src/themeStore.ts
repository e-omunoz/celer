// Custom themes kept in settings.json (`customThemes`): save, delete, use, export and import them. The themes
// themselves (tokens, checks, the file format) are in themes.ts; the editor is src/components/ThemeEditor.tsx.

import { api, errorText, isTauri } from "./api";
import { applyTheme, confirmDialog, currentTheme, notify, saveSettings, setThemeDraft, state } from "./state";
import { CUSTOM_PREFIX, exportThemeJson, importThemeJson, newThemeId, type CustomTheme } from "./themes";
import type { ThemeChoice } from "./types";

export const choiceOf = (theme: CustomTheme): ThemeChoice => `${CUSTOM_PREFIX}${theme.id}` as ThemeChoice;

export function customThemeById(id: string): CustomTheme | undefined {
  return state.settings.customThemes.find((theme) => theme.id === id);
}

/** Saves `theme` (a new one is added after the others); `use` makes it the theme in use. */
export async function saveCustomTheme(theme: CustomTheme, use = false) {
  const list = state.settings.customThemes;
  const at = list.findIndex((item) => item.id === theme.id);
  const next = at >= 0 ? list.map((item, i) => (i === at ? theme : item)) : [...list, theme];
  await saveSettings(use ? { customThemes: next, theme: choiceOf(theme) } : { customThemes: next });
}

/** Asks, then deletes a theme; whatever used it (the theme, the system light/dark choice) goes back to its base. */
export async function deleteCustomTheme(theme: CustomTheme): Promise<boolean> {
  const ok = await confirmDialog(`¿Borrar el tema «${theme.name}»?`, "No se puede deshacer. Si quieres conservarlo, expórtalo antes a un fichero.", "Borrar", true);
  if (!ok) return false;
  const choice = choiceOf(theme);
  const s = state.settings;
  await saveSettings({
    customThemes: s.customThemes.filter((item) => item.id !== theme.id),
    ...(s.theme === choice ? { theme: theme.base } : {}),
    ...(s.systemLight === choice ? { systemLight: "light" } : {}),
    ...(s.systemDark === choice ? { systemDark: "dark" } : {}),
  });
  notify(`Tema «${theme.name}» borrado`, "success");
  return true;
}

/** Writes a theme to a JSON file to share it (in the browser preview it is downloaded). */
export async function exportCustomTheme(theme: CustomTheme) {
  const fileName = `${theme.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "tema"}.celer-theme.json`;
  try {
    const picked = await api().pickSavePath([{ name: "Tema de Celer (JSON)", extensions: ["json"] }], fileName);
    const path = picked ?? (isTauri() ? null : fileName);
    if (!path) return;
    await api().writeTextFile(path.toLowerCase().endsWith(".json") ? path : `${path}.json`, exportThemeJson(theme));
    notify(`Tema «${theme.name}» exportado`, "success", path);
  } catch (err) {
    notify("No se pudo exportar el tema", "error", errorText(err));
  }
}

/** Reads a theme exported by Celer and adds it (new id, a name no other theme has). The theme, or null. */
export async function importCustomTheme(): Promise<CustomTheme | null> {
  try {
    const path = await api().pickOpenPath([{ name: "Tema de Celer (JSON)", extensions: ["json"] }]);
    if (!path) return null;
    const { text } = await api().readTextFile(path);
    const theme = importThemeJson(text, newThemeId(), state.settings.customThemes.map((item) => item.name));
    await saveCustomTheme(theme);
    notify(`Tema «${theme.name}» importado`, "success", "Está junto a los demás temas en Ajustes › Apariencia.");
    return theme;
  } catch (err) {
    notify("No se pudo importar el tema", "error", errorText(err));
    return null;
  }
}

/** Stops showing the theme being edited: the chosen one comes back. */
export function endThemePreview() {
  setThemeDraft(null);
  applyTheme();
}

/** The custom theme in use now (following the system's light/dark mode when that is the choice), if any. */
export function activeCustomTheme(): CustomTheme | null {
  return currentTheme().custom;
}

/**
 * A new accent from Ajustes › Apariencia. With a custom theme in use, the theme takes it too (it would otherwise
 * keep its own accent and the click would do nothing).
 */
export async function setAccent(value: string) {
  const custom = activeCustomTheme();
  if (!custom || !custom.colors["--accent"]) {
    await saveSettings({ accent: value });
    return;
  }
  const colors: Record<string, string> = { ...custom.colors, "--accent": value };
  delete colors["--accent-fg"];
  const next = state.settings.customThemes.map((item) => (item.id === custom.id ? { ...item, colors } : item));
  await saveSettings({ accent: value, customThemes: next });
}
