// Settings › Apariencia › Gib: how he looks (colour, accessories, name, the companion's pose) with a live preview.
import { createSignal, For, onCleanup } from "solid-js";
import { Gib, type GibMood } from "../gib/Gib";
import { COMPANION_POSES, GIB_ACCESSORIES, GIB_NAME_MAX, gibDisplayName, gibTint, type GibAccessory, type GibLook, type GibPose } from "../gib/prefs";
import { saveSettings, state } from "../state";
import { ACCENTS } from "../types";

const ACCESSORY_LABEL: Record<GibAccessory, string> = { cap: "Gorra", glasses: "Gafas", headphones: "Cascos", scarf: "Bufanda" };
const POSE_LABEL: Record<GibPose, string> = { poker: "De pie", monday: "Recién levantado", icon: "Solo la cabeza", laptop: "Con el portátil" };
const CLASSIC = "#1B1C21";

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
  const save = (patch: Partial<GibLook>, reaction: GibMood = "happy") => {
    void saveSettings({ gib: { ...look(), ...patch } });
    react(reaction);
  };
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
      </div>
    </div>
  );
}
