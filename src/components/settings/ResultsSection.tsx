import { For } from "solid-js";
import { cellLabel } from "../../cellFormat";
import { saveSettings, state } from "../../state";
import { Choice, Field, NumberSetting, Toggle } from "./controls";

/** Ajustes › Resultados: paging, and how the grid shows and copies values (display only: the data is not changed). */
export function ResultsSection() {
  const s = () => state.settings;
  const prefs = () => ({ nullText: s().nullText, dateFormat: s().dateFormat, numberFormat: s().numberFormat, maxCellChars: s().maxCellChars });
  return (
    <>
      <div class="form-row">
        <Field label="Filas por página">
          <select value={String(s().pageSize)} onChange={(event) => void saveSettings({ pageSize: Number(event.currentTarget.value) })}>
            <For each={[100, 200, 500, 1000, 2000, 5000, 10000]}>{(n) => <option value={n}>{n.toLocaleString()}</option>}</For>
          </select>
        </Field>
        <Field label="Texto de NULL">
          <input value={s().nullText} placeholder="(vacío)" spellcheck={false} maxLength={20} onChange={(event) => void saveSettings({ nullText: event.currentTarget.value })} />
        </Field>
      </div>
      <div class="form-row">
        <Choice setting="dateFormat" label="Formato de fecha" options={[["iso", "Como llega (2026-03-15 10:20)"], ["dmy", "Día/mes/año (15/03/2026 10:20)"]]} />
        <Choice setting="numberFormat" label="Formato de número" options={[["plain", "Como llega (1234567.5)"], ["grouped", "Con separador de miles (1.234.567,5)"]]} />
      </div>
      <div class="form-row">
        <NumberSetting setting="maxCellChars" label="Caracteres por celda" unit="caracteres" step={50} hint="El valor completo está en el panel de valor y en lo que copias." />
        <Choice
          setting="copyFormat"
          label="Formato al copiar (Ctrl+C)"
          options={[["tsv", "Texto con tabuladores"], ["tsv-head", "Tabuladores con cabeceras"], ["csv", "CSV con cabeceras"], ["markdown", "Tabla Markdown"], ["json", "JSON"]]}
          hint="Ctrl+Mayús+C copia siempre con cabeceras; el menú de la celda tiene los demás formatos."
        />
      </div>
      <Toggle setting="zebra" label="Filas alternas">Filas alternas en la tabla de resultados</Toggle>
      <div class="results-sample" aria-label="Ejemplo">
        <span>{cellLabel(null, "text", prefs()) || "(vacío)"}</span>
        <span>{cellLabel("2026-03-15 10:20:00", "date", prefs())}</span>
        <span class="num">{cellLabel("1234567.5", "number", prefs())}</span>
      </div>
      <p class="settings-note">
        Los formatos solo cambian cómo se ven los valores: al copiar, exportar o editar se usa el valor tal como lo da el servidor. Los resultados se leen por
        páginas con un cursor abierto: aunque la consulta devuelva millones de filas, solo se traen las que ves.
      </p>
    </>
  );
}
