import { FileUp, LoaderCircle } from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import { cancelImport, hasFile, importer, parsed, pickImportFile, pickSheet, remap, runImport, setImporter } from "../importer";
import { ObjIcon } from "../icons";
import { Dialog } from "./Modals";

const DELIMITERS: [string, string][] = [
  [",", "Coma"],
  [";", "Punto y coma"],
  ["\t", "Tabulador"],
  ["|", "Barra"],
];

export function ImportDialog() {
  const data = createMemo(() => parsed());
  const mappedCount = () => importer.mapping.filter((value) => value >= 0).length;
  const missingRequired = () =>
    importer.columns.filter((col, index) => !col.nullable && !col.identity && !col.default && importer.mapping[index] < 0).map((col) => col.name);

  return (
    <Dialog title={`Importar datos en ${importer.obj?.name ?? ""}`} wide class="import-dialog" onClose={cancelImport}>
      <Show
        when={hasFile()}
        fallback={
          <button type="button" class="drop-zone" onClick={() => void pickImportFile()}>
            <FileUp size={26} />
            <b>Elegir un fichero CSV, JSON o Excel</b>
            <small>CSV / TSV, JSON (lista de objetos o JSON Lines), Excel (.xlsx, .xls) y OpenDocument (.ods). Nada se escribe hasta que pulses «Importar».</small>
          </button>
        }
      >
        <div class="import-file">
          <ObjIcon kind="file" size={16} />
          <b>{importer.fileName}</b>
          <span class="muted">{data().rows.length.toLocaleString()} {data().rows.length === 1 ? "fila" : "filas"} · {data().header.length} {data().header.length === 1 ? "columna" : "columnas"}</span>
          <span class="spacer" />
          <button type="button" class="btn tiny" disabled={importer.running} onClick={() => void pickImportFile()}>Cambiar fichero</button>
        </div>
        <div class="import-opts">
          <Show when={importer.format === "csv"}>
            <div class="field">
              <span>Separador</span>
              <div class="seg">
                <For each={DELIMITERS}>
                  {([value, label]) => (
                    <button type="button" classList={{ on: importer.delimiter === value }} onClick={() => { setImporter("delimiter", value); remap(); }}>
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={importer.sheets.length > 1}>
            <label class="field import-sheet">
              <span>Hoja</span>
              <select value={importer.sheet} disabled={importer.running} onChange={(event) => void pickSheet(event.currentTarget.value)}>
                <For each={importer.sheets}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </label>
          </Show>
          <Show when={!importer.keyedHeader}>
            <label class="check"><input type="checkbox" checked={importer.hasHeader} onChange={(event) => { setImporter("hasHeader", event.currentTarget.checked); remap(); }} /> La primera fila son cabeceras</label>
          </Show>
          <label class="check"><input type="checkbox" checked={importer.emptyAsNull} onChange={(event) => setImporter("emptyAsNull", event.currentTarget.checked)} /> Campos vacíos como NULL</label>
        </div>
        <div class="import-map">
          <div class="import-map-head"><span>Columna de la tabla</span><span>Viene de</span><span>Ejemplo</span></div>
          <For each={importer.columns}>
            {(col, index) => (
              <div class="import-map-row" classList={{ skipped: importer.mapping[index()] < 0 }}>
                <span class="cell-icon">
                  <ObjIcon kind={col.primaryKey ? "pkcolumn" : "column"} size={13} />
                  <b>{col.name}</b>
                  <small>{col.typeName}{col.identity ? " · auto" : ""}</small>
                </span>
                <select value={String(importer.mapping[index()])} onChange={(event) => setImporter("mapping", index(), Number(event.currentTarget.value))}>
                  <option value="-1">— no importar —</option>
                  <For each={data().header}>{(name, source) => <option value={source()}>{name || `columna ${source() + 1}`}</option>}</For>
                </select>
                <code>{importer.mapping[index()] >= 0 ? data().rows[0]?.[importer.mapping[index()]] ?? "" : ""}</code>
              </div>
            )}
          </For>
        </div>
        <Show when={missingRequired().length}>
          <p class="import-warn">Sin valor para columnas obligatorias: {missingRequired().join(", ")}. La base de datos rechazará las filas.</p>
        </Show>
        <Show when={importer.running}>
          <div class="export-progress">
            <LoaderCircle size={15} class="spin" />
            <span>Importando… <b>{importer.done.toLocaleString()}</b> de {importer.total.toLocaleString()} filas</span>
            <span class="spacer" />
            <div class="mini-progress"><i style={{ width: `${importer.total ? (importer.done / importer.total) * 100 : 0}%` }} /></div>
          </div>
        </Show>
      </Show>
      <footer>
        <span class="muted small">Todo se importa en una sola transacción: si una fila falla, no se guarda ninguna.</span>
        <span class="spacer" />
        <button type="button" class="btn" onClick={cancelImport}>{importer.running ? "Detener" : "Cancelar"}</button>
        <button type="button" class="btn primary" disabled={importer.running || !data().rows.length || !mappedCount()} onClick={() => void runImport()}>
          Importar {data().rows.length ? data().rows.length.toLocaleString() : ""} filas
        </button>
      </footer>
    </Dialog>
  );
}
