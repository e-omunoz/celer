import { ClipboardPaste, FileUp, LoaderCircle } from "lucide-solid";
import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import {
  cancelImport,
  hasFile,
  headerChoices,
  importArea,
  importer,
  importRowCount,
  isSheetLike,
  parsed,
  pasteImport,
  pickImportFile,
  pickSheet,
  remap,
  runImport,
  setHeaderRow,
  setImporter,
  setImportRange,
} from "../importer";
import { columnLetters } from "../importFormats";
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
  const count = createMemo(() => importRowCount());
  const mappedCount = () => importer.mapping.filter((value) => value >= 0).length;
  const missingRequired = () =>
    importer.columns.filter((col, index) => !col.nullable && !col.identity && !col.default && importer.mapping[index] < 0).map((col) => col.name);
  const usedRange = () => {
    const a = importer.area;
    return a.r2 >= 0 ? `${columnLetters(a.c1)}${a.r1 + 1}:${columnLetters(a.c2)}${a.r2 + 1}` : "";
  };
  const rangeBad = () => Boolean(importer.range.trim()) && !importArea();
  /** Ctrl+V anywhere in the wizard (outside its fields): the cells copied from Excel are the data to import. */
  const onPaste = (event: ClipboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (importer.running || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) return;
    event.preventDefault();
    void pasteImport(text);
  };
  // On the window: the focus may be on the dialog itself, outside any field.
  onMount(() => window.addEventListener("paste", onPaste));
  onCleanup(() => window.removeEventListener("paste", onPaste));
  const pasteButton = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) await pasteImport(text);
    } catch {
      /* no access to the clipboard: Ctrl+V still works */
    }
  };

  return (
    <Dialog title={`Importar datos en ${importer.obj?.name ?? ""}`} wide class="import-dialog" onClose={cancelImport}>
      <div class="import-body">
        <Show when={importer.reading}>
          {(reading) => (
            <div class="export-progress">
              <LoaderCircle size={15} class="spin" />
              <span>
                Leyendo la hoja…{" "}
                <Show when={reading().total}>
                  <b>{reading().rows.toLocaleString()}</b> de {reading().total.toLocaleString()} filas
                </Show>
              </span>
              <span class="spacer" />
              <div class="mini-progress"><i style={{ width: `${reading().total ? Math.min(100, (reading().rows / reading().total) * 100) : 0}%` }} /></div>
            </div>
          )}
        </Show>
        <Show
          when={hasFile()}
          fallback={
            <Show when={!importer.reading}>
              <button type="button" class="drop-zone" onClick={() => void pickImportFile()}>
                <FileUp size={26} />
                <b>Elegir un fichero CSV, JSON o Excel</b>
                <small>CSV / TSV, JSON (lista de objetos o JSON Lines), Excel (.xlsx, .xls) y OpenDocument (.ods). Nada se escribe hasta que pulses «Importar».</small>
              </button>
              <button type="button" class="btn import-paste" onClick={() => void pasteButton()}>
                <ClipboardPaste size={14} /> Pegar celdas copiadas de Excel <kbd>Ctrl+V</kbd>
              </button>
            </Show>
          }
        >
          <div class="import-file">
            <ObjIcon kind="file" size={16} />
            <b>{importer.fileName}</b>
            <span class="muted">{count().toLocaleString()} {count() === 1 ? "fila" : "filas"} · {data().header.length} {data().header.length === 1 ? "columna" : "columnas"}</span>
            <span class="spacer" />
            <button type="button" class="btn tiny" disabled={importer.running || Boolean(importer.reading)} onClick={() => void pickImportFile()}>Cambiar fichero</button>
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
                <select value={importer.sheet} disabled={importer.running || Boolean(importer.reading)} onChange={(event) => void pickSheet(event.currentTarget.value)}>
                  <For each={importer.sheets}>{(name) => <option value={name}>{name}</option>}</For>
                </select>
              </label>
            </Show>
            <Show when={isSheetLike()}>
              <label class="field import-range" title="Celdas a importar, como en Excel: B3:F200, B3:F (hasta la última fila), B:F o vacío para todo">
                <span>Rango</span>
                <input
                  value={importer.range}
                  placeholder={usedRange() ? `${usedRange()} (todo)` : "todo"}
                  spellcheck={false}
                  disabled={importer.running}
                  classList={{ invalid: rangeBad() }}
                  onBlur={(event) => event.currentTarget.value.trim().toUpperCase() !== importer.range && void setImportRange(event.currentTarget.value)}
                  onKeyDown={(event) => event.key === "Enter" && void setImportRange(event.currentTarget.value)}
                />
              </label>
              <label class="field import-header">
                <span>Cabeceras</span>
                <select value={String(importer.headerRow)} disabled={importer.running} onChange={(event) => void setHeaderRow(Number(event.currentTarget.value))}>
                  <option value="-1">Sin cabeceras (columnas por letra)</option>
                  <For each={headerChoices()}>
                    {(choice) => <option value={String(choice.row)}>{choice.label}{choice.row === importer.detectedHeader ? " · detectada" : ""}</option>}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={!importer.keyedHeader && !isSheetLike()}>
              <label class="check"><input type="checkbox" checked={importer.hasHeader} onChange={(event) => { setImporter("hasHeader", event.currentTarget.checked); remap(); }} /> La primera fila son cabeceras</label>
            </Show>
            <label class="check"><input type="checkbox" checked={importer.emptyAsNull} onChange={(event) => setImporter("emptyAsNull", event.currentTarget.checked)} /> Campos vacíos como NULL</label>
          </div>
          <Show when={rangeBad()}>
            <p class="import-warn">El rango «{importer.range}» no es válido: escríbelo como B3:F200, B3:F, B:F o B3.</p>
          </Show>
          <Show when={isSheetLike()}>
            <p class="muted small import-typed">Fechas, números y booleanos se importan con su tipo, convertidos al de cada columna.</p>
          </Show>
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
      </div>
      <footer>
        <span class="muted small">Todo se importa en una sola transacción: si una fila falla, no se guarda ninguna.</span>
        <span class="spacer" />
        <button type="button" class="btn" onClick={cancelImport}>{importer.running ? "Detener" : "Cancelar"}</button>
        <button type="button" class="btn primary" disabled={importer.running || Boolean(importer.reading) || !count() || !mappedCount() || rangeBad()} onClick={() => void runImport()}>
          Importar {count() ? count().toLocaleString() : ""} filas
        </button>
      </footer>
    </Dialog>
  );
}
