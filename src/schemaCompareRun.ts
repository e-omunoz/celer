// Running a schema comparison: one schema is marked from the explorer, the other one is compared with it. Each
// side is read through its own session (tables and their columns); the source's DDL is read for the tables the
// target lacks, for the synchronization script.
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { compareSchemas, syncScript, type SchemaTable, type TableDiff } from "./schemaCompare";
import { connectionById, kindOf, notify, openQuery, openSessionFor, patchTab, persistSoon } from "./state";
import type { DbKind, MetaNode, ObjectRef } from "./types";

export interface SchemaRef {
  connId: string;
  /** Explorer path of the schema node (or of the database, on engines without schemas). */
  path: string[];
}

export const [schemaCompare, setSchemaCompare] = createStore({
  /** The schema marked to be compared with another one. */
  mark: null as SchemaRef | null,
  open: false,
  source: null as SchemaRef | null,
  target: null as SchemaRef | null,
  loading: false,
  /** Progress: tables read of both sides. */
  done: 0,
  total: 0,
  error: "",
  diffs: [] as TableDiff[],
  sourceDdl: {} as Record<string, string>,
  /** Table whose columns are shown. */
  selected: null as string | null,
});

/** "Postgres local · celer · public" (repeated parts once: SQLite's main · main). */
export function schemaTitle(ref: SchemaRef): string {
  const parts = ref.path.filter((part, i) => part !== ref.path[i - 1]);
  return [connectionById(ref.connId)?.name ?? "?", ...parts].join(" · ");
}

const sameRef = (a: SchemaRef | null, b: SchemaRef | null) => Boolean(a && b && a.connId === b.connId && a.path.join("\u0000") === b.path.join("\u0000"));

export function markForCompare(ref: SchemaRef) {
  setSchemaCompare("mark", ref);
  notify(`«${schemaTitle(ref)}» marcado. Para compararlo, abre el menú de otro esquema y elige «Comparar con…».`, "info");
}

export function isMarked(ref: SchemaRef) {
  return sameRef(schemaCompare.mark, ref);
}

let token = 0;

/** Compares the marked schema (source) with `target`. */
export async function compareWithMarked(target: SchemaRef) {
  const source = schemaCompare.mark;
  if (!source || sameRef(source, target)) return;
  await runCompare(source, target);
}

export async function runCompare(source: SchemaRef, target: SchemaRef) {
  const run = ++token;
  setSchemaCompare({ open: true, source, target, loading: true, done: 0, total: 0, error: "", diffs: [], sourceDdl: {}, selected: null });
  const live = () => run === token && schemaCompare.open;
  const sessions: string[] = [];
  try {
    const open = async (ref: SchemaRef) => {
      const opened = await openSessionFor(ref.connId);
      if (!opened) throw new Error(`No se pudo abrir «${connectionById(ref.connId)?.name ?? "?"}»`);
      sessions.push(opened.sessionId);
      if (ref.path[0]) await api().useDatabase(opened.sessionId, ref.path[0]).catch(() => {});
      return opened.sessionId;
    };
    // Both opened before going on (allSettled: a side that fails must not leave the other one's session open).
    const opened = await Promise.allSettled([open(source), open(target)]);
    const failed = opened.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const [sourceSid, targetSid] = opened.map((r) => (r as PromiseFulfilledResult<string>).value);
    const [sourceTables, targetTables] = await Promise.all([listTables(sourceSid, source), listTables(targetSid, target)]);
    if (!live()) return;
    setSchemaCompare("total", sourceTables.length + targetTables.length);
    const tick = () => live() && setSchemaCompare("done", (n) => n + 1);
    const [sourceSide, targetSide] = await Promise.all([readColumns(sourceSid, sourceTables, tick, live), readColumns(targetSid, targetTables, tick, live)]);
    if (!live()) return;
    const diffs = compareSchemas(sourceSide, targetSide);
    // The source's DDL of the tables to create (for the script).
    const sourceDdl: Record<string, string> = {};
    const byName = new Map(sourceTables.map((t) => [t.name, t]));
    for (const d of diffs.filter((x) => x.status === "only-source").slice(0, 300)) {
      const obj = byName.get(d.name);
      if (obj) sourceDdl[d.name] = await api().objectDdl(sourceSid, obj).catch(() => "");
      if (!live()) return;
    }
    setSchemaCompare({ loading: false, diffs, sourceDdl, selected: diffs.find((d) => d.status === "different")?.name ?? null });
  } catch (err) {
    if (live()) setSchemaCompare({ loading: false, error: errorText(err) });
  } finally {
    for (const sid of sessions) void api().closeSession(sid).catch(() => {});
  }
}

/** The tables of a schema node (its "tables" folder). */
async function listTables(sid: string, ref: SchemaRef): Promise<ObjectRef[]> {
  const folders = await api().metaChildren(sid, ref.path);
  const folder = folders.find((node: MetaNode) => node.kind === "folder" && (node.path[node.path.length - 1] === "tables" || /^(tablas|tables)$/i.test(node.name)));
  if (!folder) throw new Error(`«${schemaTitle(ref)}» no tiene una carpeta de tablas`);
  return (await api().metaChildren(sid, folder.path)).filter((node) => node.obj?.kind === "table").map((node) => node.obj!);
}

/**
 * Every table's columns, stopping when the comparison is closed or replaced. A table whose columns cannot be
 * read fails the comparison: shown as empty it would look like a table to rebuild.
 */
async function readColumns(sid: string, tables: ObjectRef[], tick: () => void, live: () => boolean): Promise<SchemaTable[]> {
  const out: SchemaTable[] = [];
  for (const obj of tables) {
    if (!live()) break;
    const columns = await api().tableColumns(sid, obj).catch((err) => {
      throw new Error(`No se pudieron leer las columnas de ${obj.name}: ${errorText(err)}`);
    });
    out.push({ name: obj.name, columns });
    tick();
  }
  return out;
}

export function swapCompare() {
  const { source, target } = schemaCompare;
  if (source && target && !schemaCompare.loading) void runCompare(target, source);
}

export function closeSchemaCompare() {
  token++;
  setSchemaCompare({ open: false, loading: false });
}

/** The script that makes the target like the source, in a new console on the target. */
export function openSyncScript() {
  const { source, target } = schemaCompare;
  if (!source || !target) return;
  const dialect: DbKind = kindOf(target.connId);
  const schemaOf = (ref: SchemaRef) => (ref.path.length >= 2 ? ref.path[ref.path.length - 1] : "");
  const schema = schemaOf(target);
  const header = `-- Cambios para que ${schemaTitle(target)}\n-- tenga la estructura de ${schemaTitle(source)}.\n-- Revísalo antes de ejecutarlo (Ctrl+Mayús+Intro ejecuta el script entero).\n`;
  const script = header + "\n" + syncScript(schemaCompare.diffs, { dialect, schema, sourceDialect: kindOf(source.connId), sourceSchema: schemaOf(source), sourceDdl: schemaCompare.sourceDdl });
  const id = openQuery(target.connId, script, `Sincronizar ${target.path[target.path.length - 1] ?? ""}`.trim());
  if (target.path[0]) patchTab(id, { database: target.path[0] });
  persistSoon();
  closeSchemaCompare();
}
