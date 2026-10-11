import { saveSettings, state } from "../../state";
import { editorFontFamily } from "../Editor";
import { Choice, Field, NumberSetting, NumberStepper, TextSetting, Toggle } from "./controls";

/** Ajustes › Editor: how the SQL editor looks and writes. Every change applies to the open consoles at once. */
export function EditorSection() {
  const s = () => state.settings;
  return (
    <>
      <div class="form-row">
        <Field label="Tamaño del editor">
          <NumberStepper value={s().editorFontSize} min={10} max={24} onChange={(value) => void saveSettings({ editorFontSize: value })} />
        </Field>
        <TextSetting setting="editorFont" label="Tipo de letra del editor" placeholder="Por defecto (monoespaciada de Celer)" hint="Una fuente instalada: «Cascadia Code», «JetBrains Mono»…" />
      </div>
      <p class="editor-font-sample" style={{ "font-family": editorFontFamily(s().editorFont), "font-size": `${s().editorFontSize}px` }}>
        SELECT id, nombre FROM clientes WHERE alta &gt;= '2026-01-01';
      </p>
      <div class="form-row">
        <Choice setting="keywordCase" label="Mayúsculas en palabras clave" options={[["upper", "MAYÚSCULAS (SELECT)"], ["lower", "minúsculas (select)"]]} hint="Sugerencias del autocompletado y «Formatear SQL»." />
        <Field label="Tamaño del tabulador">
          <select value={String(s().tabSize)} onChange={(event) => void saveSettings({ tabSize: Number(event.currentTarget.value) })}>
            <option value="2">2</option>
            <option value="4">4</option>
            <option value="8">8</option>
          </select>
        </Field>
      </div>
      <Toggle setting="indentSpaces" label="Sangrar con espacios">Sangrar con espacios (si no, con tabuladores)</Toggle>
      <Toggle setting="wordWrap" label="Ajuste de línea">Ajuste de línea: las líneas largas siguen debajo en vez de desplazarse</Toggle>
      <Toggle setting="lineNumbers" label="Números de línea" />
      <Toggle setting="autocomplete" label="Autocompletar al escribir">Autocompletar al escribir (Ctrl+Espacio abre la lista siempre)</Toggle>
      <NumberSetting setting="autocompleteDelay" label="Retardo del autocompletado" unit="ms" step={50} hint="Tiempo desde la última tecla hasta que aparece la lista." />
      <Toggle setting="askParams" label="Pedir el valor de los parámetros">
        Pedir el valor de los parámetros (<code>:nombre</code>, <code>?</code>, <code>{"${nombre}"}</code>) antes de ejecutar
      </Toggle>
    </>
  );
}
