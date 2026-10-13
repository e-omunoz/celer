// The test data dialog's state and what it does with the database (#172): reading the table (columns, keys,
// CHECKs, enums, parent keys) on a side session, and the three outputs: inserting through the import's pipeline (one
// transaction on a session of its own, with progress and Cancelar), a script in a new console (or a file when it is
// big) and a CSV / JSON file. The generator itself is testData.ts.
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { insertInTransaction, reloadTableTabs, SessionOpenError } from "./importer";
import { confirmDialog, connectionById, erSchemaPath, gib, kindOf, notify, openQuery, openSessionFor } from "./state";
import {
  buildModel,
  createGenerator,
  existingToRead,
  EXISTING_SAMPLE,
  exportText,
  inferOne,
  inferSettings,
  insertStatements,
  PARENT_SAMPLE,
  problems,
  randomSeed,
  scriptText,
  statsColumns,
  type GenKind,
  type GenSettings,
  type Locale,
  type ParentKeys,
  type TableModel,
} from "./testData";
import { splitSql } from "./sql";
import { catalogQueries, effectiveDialect, existingValuesSql, parentKeysSql, readCatalog, statsSql } from "./testDataSql";
import type { Cell, ObjectRef } from "./types";
import type { SheetCell } from "./importFormats";

export type TestDataOutput = "insert" | "script" | "csv" | "json";

/** Rows a script may have to open in a console; more go to a .sql file. */
export const SCRIPT_CONSOLE_ROWS = 10_000;
/** Rows generated between two looks at the interface (progress, Cancelar). */
const CHUNK = 5_000;

export interface TestDataState {
  open: boolean;
  loading: boolean;
  /** Why the table could not be read. */
  error: string;
  connId: string;
  obj: ObjectRef | null;
  model: TableModel | null;
  settings: GenSettings[];
  count: number;
  seed: number;
  locale: Locale;
  output: TestDataOutput;
  view: "columns" | "preview";
  running: boolean;
  /** What a run is doing: generating rows, inserting them, writing the file. */
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  /** The table whose dialog sent the user to fill its referenced table first: reopened afterwards. */
  returnTo: { connId: string; obj: ObjectRef } | null;
}

export const [testData, setTestData] = createStore<TestDataState>({
  open: false,
  loading: false,
  error: "",
  connId: "",
  obj: null,
  model: null,
  settings: [],
  count: 100,
  seed: 1,
  locale: "es",
  output: "insert",
  view: "columns",
  running: false,
  phase: "",
  done: 0,
  total: 0,
  startedAt: 0,
  returnTo: null,
});

let cancelRequested = false;
let runningSession: string | null = null;
let openSeq = 0;

/** Every row of a query's first result. */
async function rowsOf(sessionId: string, sql: string): Promise<Cell[][]> {
  const out = await api().execute(sessionId, sql, 5000);
  const first = out.results.find((r) => r.columns.length);
  if (!first) return [];
  const rows = [...first.rows];
  let more = first.hasMore;
  while (more) {
    const next = await api().fetch(sessionId, 5000);
    rows.push(...next.rows);
    more = next.hasMore;
  }
  return rows;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Opens the dialog for a table: reads it on a side session (its columns, unique keys, CHECKs, enums, foreign keys
 * with a sample of the keys they may take, the row count and the largest numbers) and proposes a generator per column.
 */
export async function openTestData(connId: string, obj: ObjectRef, returnTo: TestDataState["returnTo"] = null) {
  const seq = ++openSeq;
  const keep = testData.open && testData.connId === connId ? { locale: testData.locale, output: testData.output } : {};
  setTestData({ open: true, loading: true, error: "", connId, obj, model: null, settings: [], count: 100, seed: randomSeed(), view: "columns", running: false, phase: "", done: 0, total: 0, returnTo, ...keep });
  let opened: Awaited<ReturnType<typeof openSessionFor>> = null;
  try {
    opened = await openSessionFor(connId, obj.database || undefined);
    if (!opened) {
      if (seq === openSeq) setTestData({ loading: false, error: "No hay conexión" });
      return;
    }
    const session = opened.sessionId;
    if (obj.database) await api().useDatabase(session, obj.database).catch(() => {});
    const [columns, info] = await Promise.all([api().tableColumns(session, obj), api().objectSql(session, obj)]);
    if (!columns.length) throw new Error(`No se pudieron leer las columnas de ${obj.name}`);
    const quoted = await api().quoteIdents(session, columns.map((c) => c.name));
    const dialect = effectiveDialect(kindOf(connId), opened.serverInfo);
    const ref = { database: obj.database || opened.database, schema: obj.schema, name: obj.name, qualified: info.qualified };
    // Each catalog part on its own: one an old server refuses leaves only that part unknown. Each is one SELECT; one
    // the splitter reads as several (a name the quoting got wrong) is not sent at all.
    const parts = [];
    for (const q of catalogQueries(dialect, ref, opened.serverInfo)) {
      const single = splitSql(q.sql, dialect).length === 1;
      parts.push({ part: q.part, rows: single ? await rowsOf(session, q.sql).catch(() => null) : null });
    }
    const catalog = readCatalog(parts, dialect);
    const keys = await api().schemaForeignKeys(session, erSchemaPath(connId, obj, opened.database)).catch(() => []);
    const fks: ParentKeys[] = [];
    for (const fk of keys) {
      if (!sameName(fk.table.name, obj.name) || (fk.table.schema && obj.schema && !sameName(fk.table.schema, obj.schema)) || !fk.columns.length) continue;
      const target = { ...fk.target, database: fk.target.database || fk.table.database };
      const targetSql = await api().objectSql(session, target).catch(() => null);
      const targetQuoted = await api().quoteIdents(session, fk.targetColumns);
      const rows = targetSql ? await rowsOf(session, parentKeysSql(dialect, targetSql.qualified, targetQuoted, PARENT_SAMPLE)).catch(() => [] as Cell[][]) : [];
      fks.push({ name: fk.name, columns: fk.columns, target, targetColumns: fk.targetColumns, rows });
    }
    const numeric = statsColumns(columns, dialect);
    const stats = (await rowsOf(session, statsSql(info.qualified, numeric.map((i) => quoted[i]))).catch(() => [] as Cell[][]))[0] ?? null;
    const input = { dialect, qualified: info.qualified, table: obj.name, columns, quoted, catalog, stats, fks };
    let model = buildModel(input);
    // A small table: the values its unique columns already have, so new ones do not repeat them.
    const toRead = existingToRead(model);
    if (toRead.length) {
      const existingValues: Record<string, Cell[]> = {};
      for (const c of toRead) existingValues[c.name] = (await rowsOf(session, existingValuesSql(dialect, info.qualified, c.quoted, EXISTING_SAMPLE)).catch(() => [] as Cell[][])).map((r) => r[0]);
      model = buildModel({ ...input, existingValues });
    }
    if (seq !== openSeq) return;
    setTestData({ loading: false, model, settings: inferSettings(model, testData.locale) });
  } catch (err) {
    if (seq === openSeq) setTestData({ loading: false, error: errorText(err) });
  } finally {
    if (opened) void api().closeSession(opened.sessionId).catch(() => {});
  }
}

/** Another generator for a column: its parameters start from what Celer would propose for that generator. */
export function setGenerator(index: number, kind: GenKind) {
  const model = testData.model;
  if (!model) return;
  const proposed = inferOne(model, index, testData.locale);
  const current = testData.settings[index];
  const base: GenSettings = proposed.kind === kind ? proposed : { ...proposed, kind, min: "", max: "", scale: "", start: "", step: "", value: "", values: "", pattern: "", template: "" };
  if (kind === "sequence" && !base.start) base.start = "1";
  if (kind === "pattern" && !base.pattern) base.pattern = "[A-Z]{3}-\\d{4}";
  if (kind === "list" && !base.values) base.values = model.columns[index].values?.join("\n") ?? "";
  if (kind === "expression" && !base.template) base.template = "{#}";
  setTestData("settings", index, { ...base, nullPct: kind === "skip" || kind === "null" ? 0 : current.nullPct });
}

export function setSetting<K extends keyof GenSettings>(index: number, key: K, value: GenSettings[K]) {
  setTestData("settings", index, key, value);
}

/** Another locale: the generators are proposed again (names, phones and statuses change with it). */
export function setLocale(locale: Locale) {
  setTestData("locale", locale);
  if (testData.model) setTestData("settings", inferSettings(testData.model, locale));
}

/** Every generator as Celer proposes it again. */
export function resetSettings() {
  if (testData.model) setTestData("settings", inferSettings(testData.model, testData.locale));
}

/** The generator's rows a chunk at a time (with a pause between chunks so the window stays responsive). */
async function* chunks(model: TableModel, settings: GenSettings[], count: number, seed: number, locale: Locale) {
  const generator = createGenerator(model, settings, seed, locale);
  for (let start = 0; start < count; start += CHUNK) {
    if (cancelRequested) throw new Error("Cancelado");
    const rows: SheetCell[][] = [];
    for (let i = start; i < Math.min(count, start + CHUNK); i++) rows.push(generator.next());
    yield { generator, rows, start };
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Runs the chosen output. Nothing reaches the database except «Insertar», which is one transaction. */
export async function runTestData() {
  const { model, obj, connId, count, seed, locale, output } = testData;
  if (!model || !obj || testData.running) return;
  const settings = testData.settings.map((s) => ({ ...s }));
  const blocking = problems(model, settings, count, locale).filter((p) => p.error);
  if (blocking.length) {
    notify(blocking[0].text, "error", blocking.length > 1 ? `Y ${blocking.length - 1} problema(s) más en la lista de columnas.` : undefined);
    return;
  }
  cancelRequested = false;
  if (output === "insert") await insertRows(model, obj, connId, settings, count, seed, locale);
  else if (output === "script") await writeScript(model, obj, connId, settings, count, seed, locale);
  else await writeExport(model, obj, settings, count, seed, locale, output);
}

async function insertRows(model: TableModel, obj: ObjectRef, connId: string, settings: GenSettings[], count: number, seed: number, locale: Locale) {
  const conn = connectionById(connId);
  if (conn?.readOnly) {
    notify("La conexión es de solo lectura: no se inserta nada", "error", "Genera el script o exporta a CSV / JSON, o quita «Solo lectura» en la conexión.");
    return;
  }
  if (conn?.production) {
    const ok = await confirmDialog(
      `Insertar en ${conn.name} (producción)`,
      `Se insertarán ${count.toLocaleString("es-ES")} filas de datos de prueba en ${obj.name}, en una sola transacción. Revisa que es lo que quieres antes de continuar.`,
      "Insertar de todos modos",
      true,
    );
    if (!ok) return;
  }
  setTestData({ running: true, phase: "Insertando", done: 0, total: count, startedAt: Date.now() });
  let done = 0;
  try {
    await insertInTransaction(
      connId,
      obj.database || undefined,
      async (exec) => {
        for await (const { generator, rows, start } of chunks(model, settings, count, seed, locale)) {
          const statements = insertStatements(model, generator, rows);
          const per = Math.ceil(rows.length / Math.max(1, statements.length));
          for (let i = 0; i < statements.length; i++) {
            if (cancelRequested) throw new Error("Cancelado");
            try {
              await exec(statements[i]);
            } catch (err) {
              if (cancelRequested) throw new Error("Cancelado");
              throw new Error(`Filas ${(start + i * per + 1).toLocaleString("es-ES")}–${(start + Math.min(rows.length, (i + 1) * per)).toLocaleString("es-ES")}: ${errorText(err)}`);
            }
            done = Math.min(count, start + (i + 1) * per);
            setTestData("done", done);
          }
        }
      },
      (session) => {
        runningSession = session;
      },
    );
    notify(`Insertadas ${count.toLocaleString("es-ES")} filas de prueba en ${obj.name}`, "success");
    gib("saved");
    reloadTableTabs(connId, obj.name);
    finishRun(true);
  } catch (err) {
    setTestData({ running: false, phase: "" });
    if (err instanceof SessionOpenError) notify(err.message, "error");
    else if (cancelRequested) notify("Cancelado: no se insertó nada", "info", "La transacción se deshizo entera.");
    else notify("No se insertó nada: la operación se deshizo", "error", errorText(err));
  }
}

async function writeScript(model: TableModel, obj: ObjectRef, connId: string, settings: GenSettings[], count: number, seed: number, locale: Locale) {
  // A big script goes to a file: a console with hundreds of thousands of INSERTs would be slow to edit.
  let path = "";
  const name = `datos_${obj.name}.sql`;
  if (count > SCRIPT_CONSOLE_ROWS) {
    path = isTauri() ? ((await api().pickSavePath([{ name: "SQL", extensions: ["sql"] }], name)) ?? "") : name;
    if (!path) return;
  }
  setTestData({ running: true, phase: "Generando el script", done: 0, total: count, startedAt: Date.now() });
  try {
    const statements: string[] = [];
    for await (const { generator, rows, start } of chunks(model, settings, count, seed, locale)) {
      statements.push(...insertStatements(model, generator, rows));
      setTestData("done", Math.min(count, start + rows.length));
    }
    const script = scriptText(model, statements, { rows: count, seed, locale });
    if (path) {
      setTestData("phase", "Guardando");
      await api().writeTextFile(path, script);
      notify(`Script de ${count.toLocaleString("es-ES")} filas guardado`, "success", path);
    } else {
      openQuery(connId, script, name, { database: obj.database || undefined });
      notify("Script en una consola nueva: no se ha ejecutado nada", "success");
    }
    finishRun(false);
  } catch (err) {
    setTestData({ running: false, phase: "" });
    if (!cancelRequested) notify(errorText(err), "error");
  }
}

async function writeExport(model: TableModel, obj: ObjectRef, settings: GenSettings[], count: number, seed: number, locale: Locale, format: "csv" | "json") {
  const name = `datos_${obj.name}.${format}`;
  const path = isTauri() ? ((await api().pickSavePath([{ name: format.toUpperCase(), extensions: [format] }], name)) ?? "") : name;
  if (!path) return;
  setTestData({ running: true, phase: "Generando", done: 0, total: count, startedAt: Date.now() });
  try {
    const parts: string[] = [];
    for await (const { generator, rows, start } of chunks(model, settings, count, seed, locale)) {
      const text = exportText(model, generator, rows, format);
      // One header (CSV) and one array (JSON) for every chunk together.
      if (format === "csv") parts.push(start === 0 ? text : text.slice(text.indexOf("\n") + 1));
      else parts.push(text.replace(/^\[\n?/, "").replace(/\n?\]$/, ""));
      setTestData("done", Math.min(count, start + rows.length));
    }
    setTestData("phase", "Guardando");
    const body = format === "csv" ? parts.join("\n") + "\n" : `[\n${parts.filter(Boolean).join(",\n")}\n]\n`;
    await api().writeTextFile(path, body);
    notify(`Exportadas ${count.toLocaleString("es-ES")} filas de prueba a ${format.toUpperCase()}`, "success", path);
    finishRun(false);
  } catch (err) {
    setTestData({ running: false, phase: "" });
    if (!cancelRequested) notify(errorText(err), "error");
  }
}

/** A run that ended well: the dialog closes; a referenced table filled first sends the user back to its child. */
function finishRun(inserted: boolean) {
  const back = inserted ? testData.returnTo : null;
  setTestData({ running: false, phase: "", open: false });
  if (back) void openTestData(back.connId, back.obj);
}

/** «Cancelar» while it runs (the transaction is rolled back), else closes the dialog. */
export function cancelTestData() {
  if (testData.running) {
    cancelRequested = true;
    setTestData("phase", "Cancelando");
    // A statement that is running stops now, not when it ends.
    if (runningSession) void api().cancel(runningSession).catch(() => {});
    return;
  }
  openSeq++;
  setTestData({ open: false, loading: false });
}

/** Fills the referenced table first (it is empty), then comes back here. */
export function fillParentFirst(parent: ObjectRef) {
  const { connId, obj } = testData;
  if (!obj) return;
  void openTestData(connId, parent, { connId, obj });
}

/** The problems of the current settings (memoised by the dialog). */
export function currentProblems() {
  return testData.model ? problems(testData.model, testData.settings, testData.count, testData.locale) : [];
}

/** Rows per second so far. */
export function rowsPerSecond(): number {
  const secs = (Date.now() - testData.startedAt) / 1000;
  return secs > 0.2 ? Math.round(testData.done / secs) : 0;
}
