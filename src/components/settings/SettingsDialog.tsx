import { Download, RotateCcw, Search, Upload } from "lucide-solid";
import { createSignal, For, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { api, errorText, isTauri } from "../../api";
import { applyTheme, notify, saveSettings, setState, state } from "../../state";
import { exportSettings, parseSettingsFile, resetPatch, searchSettings, SETTINGS_SECTIONS, type SettingsSectionInfo } from "../../settingsSections";
import type { Settings } from "../../types";
import { Dialog } from "../Modals";
import { AiSettings } from "../AiSettings";
import { DriversSettings } from "../InformixDrivers";
import { KeymapSettings } from "../KeymapSettings";
import { SnippetSettings } from "../SnippetSettings";
import { AppearanceSection } from "./AppearanceSection";
import { EditorSection } from "./EditorSection";
import { ExecutionSection } from "./ExecutionSection";
import { HistorySection } from "./HistorySection";
import { NotificationsSection } from "./NotificationsSection";
import { ResultsSection } from "./ResultsSection";
import { SafetySection } from "./SafetySection";
import { WindowSection } from "./WindowSection";

/**
 * The component of each section of src/settingsSections.ts, by id. A new section (Tema, Gib, transacciones…) is an
 * entry there and its component here; the dialog, the search box and «Restablecer sección» pick it up.
 */
export const SECTION_VIEWS: Record<string, () => JSX.Element> = {
  appearance: AppearanceSection,
  editor: EditorSection,
  results: ResultsSection,
  execution: ExecutionSection,
  window: WindowSection,
  history: HistorySection,
  notifications: NotificationsSection,
  templates: SnippetSettings,
  keys: KeymapSettings,
  safety: SafetySection,
  ai: AiSettings,
  drivers: DriversSettings,
};

const sections = () => SETTINGS_SECTIONS.filter((section) => SECTION_VIEWS[section.id]);

/** A copy detached from the Solid store proxies (structuredClone cannot clone them). */
const plainClone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function SettingsDialog() {
  const [query, setQuery] = createSignal("");
  const section = () => sections().find((item) => item.id === state.settingsSection) ?? sections()[0];
  const matches = () => searchSettings(query(), sections());
  const close = () => {
    applyTheme();
    setState({ settingsOpen: false, settingsSection: "appearance" });
  };
  let body: HTMLDivElement | undefined;

  /** A search result: its section, scrolled to the setting, which lights up for a moment. */
  const jump = (id: string, label: string) => {
    setQuery("");
    setState("settingsSection", id);
    requestAnimationFrame(() => {
      const target = [...(body?.querySelectorAll<HTMLElement>("[data-setting]") ?? [])].find((el) => el.dataset.setting === label);
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.classList.remove("setting-flash");
      void target.offsetWidth;
      target.classList.add("setting-flash");
      target.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
    });
  };

  const reset = (info: SettingsSectionInfo) => {
    const before: Partial<Settings> = {};
    for (const key of info.keys) (before as Record<string, unknown>)[key] = plainClone(state.settings[key]);
    void saveSettings(resetPatch(info)).then(() =>
      notify(`«${info.label}» vuelve a los valores de serie`, "success", info.resetNote, { label: "Deshacer", run: () => void saveSettings(before) }),
    );
  };

  return (
    <Dialog title="Ajustes" wide class="settings" onClose={close}>
      <div class="settings-layout">
        <nav class="settings-nav">
          <label class="settings-search">
            <Search size={13} />
            <input
              type="search"
              placeholder="Buscar un ajuste"
              aria-label="Buscar un ajuste"
              value={query()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                const first = matches()[0];
                if (event.key === "Enter" && first) jump(first.section, first.label);
              }}
            />
          </label>
          <For each={sections()}>
            {(item) => (
              <button type="button" classList={{ on: !query() && section().id === item.id }} onClick={() => { setQuery(""); setState("settingsSection", item.id); }}>
                {item.label}
              </button>
            )}
          </For>
          <span class="spacer" />
          <button type="button" class="settings-io" title="Guardar todos los ajustes en un fichero JSON" onClick={() => void exportToFile()}>
            <Download size={13} /> Exportar ajustes…
          </button>
          <button type="button" class="settings-io" title="Tomar los ajustes de un fichero JSON exportado" onClick={() => void importFromFile()}>
            <Upload size={13} /> Importar ajustes…
          </button>
        </nav>
        <div class="settings-body" ref={body}>
          <Show
            when={!query()}
            fallback={
              <div class="settings-results">
                <For each={matches()} fallback={<p class="settings-note">Ningún ajuste coincide con «{query()}».</p>}>
                  {(match) => (
                    <button type="button" class="settings-result" onClick={() => jump(match.section, match.label)}>
                      <span>{match.label}</span>
                      <small>{match.sectionLabel}</small>
                    </button>
                  )}
                </For>
              </div>
            }
          >
            <header class="settings-head">
              <h3>{section().label}</h3>
              <Show when={section().keys.length}>
                <button type="button" class="btn tiny" title={section().resetNote ?? "Los ajustes de esta sección vuelven a sus valores de serie"} onClick={() => reset(section())}>
                  <RotateCcw size={12} /> Restablecer sección
                </button>
              </Show>
            </header>
            {/* Each section mounts fresh when shown (its own signals start from the current settings). */}
            <Dynamic component={SECTION_VIEWS[section().id]} />
          </Show>
          <p class="settings-foot">{isTauri() ? "Aplicación de escritorio" : "Modo navegador: SQLite en memoria (demo)."} · Celer {state.appInfo.version} · {state.appInfo.dataDir}</p>
        </div>
      </div>
    </Dialog>
  );
}

/** «Exportar ajustes…»: every setting that travels to another machine, as JSON. */
async function exportToFile() {
  try {
    const text = exportSettings(state.settings, state.appInfo.version || "dev");
    const path = isTauri() ? await api().pickSavePath([{ name: "Ajustes de Celer", extensions: ["json"] }], "celer-ajustes.json") : "celer-ajustes.json";
    if (!path) return;
    await api().writeTextFile(path, text);
    notify("Ajustes exportados", "success", isTauri() ? path : undefined);
  } catch (err) {
    notify("No se pudieron exportar los ajustes", "error", errorText(err));
  }
}

/** «Importar ajustes…»: the settings of an exported file replace these (what the file lacks stays as it is). */
async function importFromFile() {
  try {
    const path = await api().pickOpenPath([{ name: "Ajustes de Celer", extensions: ["json"] }]);
    if (!path) return;
    const { text } = await api().readTextFile(path);
    const { patch, ignored } = parseSettingsFile(text);
    const count = Object.keys(patch).length;
    if (!count) {
      notify("El fichero no tiene ajustes que Celer entienda", "warning", ignored.length ? `Sin usar: ${ignored.join(", ")}` : undefined);
      return;
    }
    const before: Partial<Settings> = {};
    for (const key of Object.keys(patch) as (keyof Settings)[]) (before as Record<string, unknown>)[key] = plainClone(state.settings[key]);
    await saveSettings(patch);
    notify(
      `${count} ${count === 1 ? "ajuste importado" : "ajustes importados"}`,
      "success",
      ignored.length ? `Sin usar (desconocidos o con un valor no válido): ${ignored.join(", ")}` : undefined,
      { label: "Deshacer", run: () => void saveSettings(before) },
    );
  } catch (err) {
    notify("No se pudieron importar los ajustes", "error", errorText(err));
  }
}
