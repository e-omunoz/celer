// The building blocks of every settings section. Each control carries `data-setting` with its label, which the
// search box of the dialog scrolls to (the labels are listed in src/settingsSections.ts).
import { For, type JSX } from "solid-js";
import { saveSettings, state } from "../../state";
import { clampSetting, RANGES } from "../../settingsSections";
import type { Settings } from "../../types";

/** A labelled field: the label above, the control below. */
export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="field" data-setting={props.label}>
      <span>{props.label}</span>
      {props.children}
      {props.hint ? <small class="field-hint">{props.hint}</small> : null}
    </label>
  );
}

/** A boolean setting as a check box. */
export function Toggle(props: { setting: BooleanKey; label: string; children?: JSX.Element }) {
  return (
    <label class="check" data-setting={props.label}>
      <input type="checkbox" checked={state.settings[props.setting]} onChange={(event) => void saveSettings({ [props.setting]: event.currentTarget.checked } as Partial<Settings>)} />
      {props.children ?? props.label}
    </label>
  );
}

type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type StringKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

/** − value + with the setting's range (src/settingsSections.ts RANGES). */
export function NumberStepper(props: { value: number; min: number; max: number; unit?: string; onChange: (value: number) => void }) {
  return (
    <div class="stepper">
      <button type="button" disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)}>−</button>
      <span>{props.value}{props.unit ?? "px"}</span>
      <button type="button" disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)}>+</button>
    </div>
  );
}

/** A number typed in, kept inside its range; the unit after it. */
export function NumberSetting(props: { setting: NumberKey; label: string; unit?: string; step?: number; hint?: string }) {
  const range = () => RANGES[props.setting] ?? [0, Number.MAX_SAFE_INTEGER];
  return (
    <Field label={props.label} hint={props.hint}>
      <span class="number-setting">
        <input
          type="number"
          min={range()[0]}
          max={range()[1]}
          step={props.step ?? 1}
          value={state.settings[props.setting]}
          onChange={(event) => {
            const value = clampSetting(props.setting, event.currentTarget.valueAsNumber);
            event.currentTarget.value = String(value);
            void saveSettings({ [props.setting]: value } as Partial<Settings>);
          }}
        />
        {props.unit ? <span class="muted small">{props.unit}</span> : null}
      </span>
    </Field>
  );
}

/** A choice among a few values, as a select. */
export function Choice<K extends StringKey>(props: { setting: K; label: string; options: [Settings[K], string][]; hint?: string }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <select value={state.settings[props.setting] as string} onChange={(event) => void saveSettings({ [props.setting]: event.currentTarget.value } as Partial<Settings>)}>
        <For each={props.options}>{([value, label]) => <option value={value as string}>{label}</option>}</For>
      </select>
    </Field>
  );
}

/** A text setting saved when the field is left (or Enter). */
export function TextSetting(props: { setting: StringKey; label: string; placeholder?: string; hint?: string; mono?: boolean }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <input
        value={state.settings[props.setting] as string}
        placeholder={props.placeholder}
        spellcheck={false}
        classList={{ mono: props.mono }}
        onChange={(event) => void saveSettings({ [props.setting]: event.currentTarget.value } as Partial<Settings>)}
      />
    </Field>
  );
}
