// Settings › Apariencia › Gib: how he looks (colour, accessories, name, the companion's pose) with a live preview, and
// how present he is (on/off, frequency, reactions, idle activities, tips, eyes, where he appears).
import { createSignal, For, onCleanup, type JSX } from "solid-js";
import { Gib, type GibMood } from "../gib/Gib";
import { COMPANION_POSES, GIB_ACCESSORIES, GIB_NAME_MAX, GIB_PLACES, gibDisplayName, gibTint, type GibAccessory, type GibFrequency, type GibPlace, type GibPose, type GibPrefs } from "../gib/prefs";
import { REACTIONS_PER_HOUR } from "../gib/reactions";
import { saveGib, state } from "../state";
import { ACCENTS } from "../types";

const ACCESSORY_LABEL: Record<GibAccessory, string> = { cap: "Gorra", glasses: "Gafas", headphones: "Cascos", scarf: "Bufanda" };
const POSE_LABEL: Record<GibPose, string> = { poker: "De pie", monday: "Recién levantado", icon: "Solo la cabeza", laptop: "Con el portátil" };
const CLASSIC = "#1B1C21";
const FREQUENCY_LABEL: Record<GibFrequency, string> = { rare: "Poco", normal: "Normal", often: "A menudo" };
const PLACE_LABEL: Record<GibPlace, string> = {
  companion: "En la barra de estado (el compañero)",
  empty: "En los estados vacíos y el asistente de IA",
  splash: "Al arrancar Celer",
  overlays: "En las esperas, la guía y los diálogos",
};

export function GibSettings() {
  const look = () => state.settings.gib;
  const [mood, setMood] = createSignal<GibMood>("idle");
  let moodTimer = 0;
  onCleanup(() => window.clearTimeout(moodTimer));

  /** The preview reacts to every change, so the choice is seen on him at once. */
  const react = (next: GibMood, ms = 1400) => {
    window.clearTimeout(moodTimer);
    setMood(next);
    moodTimer = window.setTimeout(() => setMood("idle"), ms);
  };
  const save = (patch: Partial<GibPrefs>, reaction: GibMood = "happy") => {
    void saveGib(patch);
    react(reaction);
  };
  const toggle = (key: "reactions" | "idle" | "tips" | "eyes", label: string, hint: string): JSX.Element => (
    <label class="check gib-check">
      <input type="checkbox" data-gib-pref={key} checked={look()[key]} onChange={(event) => save({ [key]: event.currentTarget.checked }, event.currentTarget.checked ? "happy" : "ok")} />
      <span>
        {label} <small>{hint}</small>
      </span>
    </label>
  );
  const toggleAccessory = (name: GibAccessory) => {
    const on = look().accessories.includes(name);
    save({ accessories: on ? look().accessories.filter((item) => item !== name) : GIB_ACCESSORIES.filter((item) => item === name || look().accessories.includes(item)) }, on ? "ok" : "love");
  };
  const color = () => look().color;
  const isPreset = () => color() === "classic" || color() === "accent" || ACCENTS.some((item) => item.value.toLowerCase() === color());

  return (
    <div class="gib-settings">
      <div class="gib-preview">
        <Gib
          size={128}
          pose={look().pose}
          mood={mood()}
          accessories={look().accessories}
          tint={gibTint(look().color)}
          label={`${gibDisplayName(look())}: vista previa`}
          onClick={() => react("wave", 1800)}
        />
        <span class="gib-preview-name">{gibDisplayName(look())}</span>
      </div>
      <div class="gib-look">
        <label class="field">
          <span>Nombre en sus mensajes</span>
          <input
            type="text"
            maxLength={GIB_NAME_MAX}
            placeholder="Gib"
            value={look().name}
            onChange={(event) => save({ name: event.currentTarget.value.trim() || "Gib" }, "wave")}
          />
        </label>
        <div class="field">
          <span>Color de la corbata y los accesorios</span>
          <div class="swatches">
            <button type="button" class="swatch big classic" classList={{ on: color() === "classic" }} style={{ background: CLASSIC }} title="Clásico (corbata negra)" aria-label="Clásico" onClick={() => save({ color: "classic" })} />
            <button type="button" class="swatch big follow" classList={{ on: color() === "accent" }} style={{ background: "var(--accent)" }} title="Como el color de acento" aria-label="Como el color de acento" onClick={() => save({ color: "accent" })}>
              <span aria-hidden="true">A</span>
            </button>
            <For each={ACCENTS}>
              {(item) => <button type="button" class="swatch big" classList={{ on: color() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} aria-label={item.name} onClick={() => save({ color: item.value.toLowerCase() })} />}
            </For>
            <label class="swatch big custom" classList={{ on: !isPreset() }} title="Personalizado">
              <input type="color" value={isPreset() ? "#3b82f6" : color()} onChange={(event) => save({ color: event.currentTarget.value.toLowerCase() })} />
            </label>
          </div>
        </div>
        <div class="field">
          <span>Accesorios</span>
          <div class="gib-chips">
            <For each={GIB_ACCESSORIES}>
              {(name) => (
                <button type="button" class="gib-chip" classList={{ on: look().accessories.includes(name) }} aria-pressed={look().accessories.includes(name)} onClick={() => toggleAccessory(name)}>
                  {ACCESSORY_LABEL[name]}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="field">
          <span>Postura en la barra de estado</span>
          <div class="seg">
            <For each={COMPANION_POSES}>
              {(pose) => <button type="button" classList={{ on: look().pose === pose }} onClick={() => save({ pose }, "wave")}>{POSE_LABEL[pose]}</button>}
            </For>
          </div>
        </div>
        <div class="gib-presence">
          <label class="check gib-check strong">
            <input type="checkbox" data-gib-pref="on" checked={look().on} onChange={(event) => save({ on: event.currentTarget.checked }, event.currentTarget.checked ? "wave" : "sad")} />
            <span>
              Mostrar a {gibDisplayName(look())} <small>(apagado no aparece en ningún sitio ni reacciona a nada)</small>
            </span>
          </label>
          <fieldset class="gib-presence-body" disabled={!look().on}>
            <div class="field">
              <span>Cuánto se hace notar</span>
              <div class="seg">
                <For each={["rare", "normal", "often"] as GibFrequency[]}>
                  {(frequency) => (
                    <button type="button" data-gib-frequency={frequency} classList={{ on: look().frequency === frequency }} title={`Como mucho ${REACTIONS_PER_HOUR[frequency]} mensajes por hora`} onClick={() => save({ frequency }, "ok")}>
                      {FREQUENCY_LABEL[frequency]}
                    </button>
                  )}
                </For>
              </div>
              <span class="field-hint">Como mucho {REACTIONS_PER_HOUR[look().frequency]} mensajes suyos por hora, sin sonido y sin quitarte el foco.</span>
            </div>
            {toggle("reactions", "Reacciona a lo que pasa", "(consultas largas, errores, resultados vacíos, exportaciones grandes, la conexión, la hora)")}
            {toggle("idle", "Se entretiene cuando no haces nada", "(nunca mientras escribes, corre una consulta o hay un diálogo abierto)")}
            {toggle("tips", "Da consejos por su cuenta", "(con un clic en él siempre te da uno)")}
            {toggle("eyes", "Sus ojos siguen al cursor", "")}
            <div class="field">
              <span>Dónde aparece</span>
              <For each={GIB_PLACES}>
                {(place) => (
                  <label class="check">
                    <input type="checkbox" data-gib-place={place} checked={look().places[place]} onChange={(event) => save({ places: { ...look().places, [place]: event.currentTarget.checked } }, "ok")} />
                    {PLACE_LABEL[place]}
                  </label>
                )}
              </For>
            </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
