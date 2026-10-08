// Comparing the rows of two tables (same or different connections): one table is marked from the explorer, the
// other is compared with it. Both are read whole, up to DATA_LIMIT rows, on side sessions, and matched by the
// source's primary key (or a guessed unique column).
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { compareResults, guessKey, type Comparison } from "./compare";
import { dataSyncScript } from "./dataCompareSql";
import { connectionById, kindOf, notify, openQuery, openSessionFor, patchTab, persistSoon } from "./state";
import type { ObjectRef, ResultSet, TableColumn } from "./types";

export const DATA_LIMIT = 50_000;

export interface TableRef {
  connId: string;
  obj: ObjectRef;
}

export const [dataCompare, setDataCompare] = createStore({
  mark: null as TableRef | null,
  open: false,
  source: null as TableRef | null,
  target: null as TableRef | null,
  loading: false,
  error: "",
  comparison: null as Comparison | null,
  /** A side had more rows than DATA_LIMIT: only the first ones were compared. */
  truncated: false,
  targetColumns: [] as TableColumn[],
  targetQualified: "",
  runId: 0,
});

export function tableTitle(ref: TableRef): string {
  const parts = [ref.obj.database, ref.obj.schema, ref.obj.name].filter((p, i, all) => p && p !== all[i - 1]);
  return [connectionById(ref.connId)?.name ?? "?", ...parts].join(" · ");
}

const same = (a: TableRef | null, b: TableRef | null) =>
  Boolean(a && b && a.connId === b.connId && a.obj.name === b.obj.name && a.obj.schema === b.obj.schema && (a.obj.database ?? "") === (b.obj.database ?? ""));

export function markTableForCompare(ref: TableRef) {
  setDataCompare("mark", ref);
  notify(`«${tableTitle(ref)}» marcada. Para comparar sus datos, abre el menú de otra tabla y elige «Comparar datos con…».`, "info");
}

export const isTableMarked = (ref: TableRef) => same(dataCompare.mark, ref);

let token = 0;

export async function compareDataWithMarked(target: TableRef) {
  const source = dataCompare.mark;
  if (!source || same(source, target)) return;
  await runDataCompare(source, target);
}

async function readTable(ref: TableRef, sessions: string[]): Promise<{ result: ResultSet; columns: TableColumn[]; qualified: string; more: boolean }> {
  const opened = await openSessionFor(ref.connId);
  if (!opened) throw new Error(`No se pudo abrir «${connectionById(ref.connId)?.name ?? "?"}»`);
  sessions.push(opened.sessionId);
  const sid = opened.sessionId;
  if (ref.obj.database) await api().useDatabase(sid, ref.obj.database).catch(() => {});
  const [columns, info] = await Promise.all([api().tableColumns(sid, ref.obj), api().objectSql(sid, ref.obj)]);
  // One row more than the limit says whether there were more.
  const out = await api().execute(sid, info.select, DATA_LIMIT + 1);
  const result = out.results.find((r) => r.columns.length);
  if (!result) throw new Error(`${ref.obj.name} no devolvió filas`);
  const more = result.rows.length > DATA_LIMIT || result.hasMore;
  return { result: { ...result, rows: result.rows.slice(0, DATA_LIMIT) }, columns, qualified: info.qualified, more };
}

export async function runDataCompare(source: TableRef, target: TableRef) {
  const run = ++token;
  setDataCompare({ open: true, source, target, loading: true, error: "", comparison: null, truncated: false, targetColumns: [], targetQualified: "" });
  const live = () => run === token && dataCompare.open;
  const sessions: string[] = [];
  try {
    const read = await Promise.allSettled([readTable(source, sessions), readTable(target, sessions)]);
    const failed = read.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const [s, t] = read.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof readTable>>>).value);
    if (!live()) return;
    // Rows matched by the source's primary key when the target has those columns; else a unique column.
    const pk = s.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const key = pk.length && pk.every((name) => t.result.columns.some((c) => c.name === name)) ? pk : guessKey(t.result, s.result);
    // Target first: the comparison shows the source's values and keeps the target's old ones.
    const comparison = compareResults(t.result, s.result, key);
    setDataCompare({ loading: false, comparison, truncated: s.more || t.more, targetColumns: t.columns, targetQualified: t.qualified, runId: dataCompare.runId + 1 });
  } catch (err) {
    if (live()) setDataCompare({ loading: false, error: errorText(err) });
  } finally {
    for (const sid of sessions) void api().closeSession(sid).catch(() => {});
  }
}

export function swapDataCompare() {
  const { source, target } = dataCompare;
  if (source && target && !dataCompare.loading) void runDataCompare(target, source);
}

export function closeDataCompare() {
  token++;
  setDataCompare({ open: false, loading: false, comparison: null });
}

/** INSERT / UPDATE (and DELETE commented) to make the target's rows like the source's, in a console of the target. */
export function openDataSyncScript() {
  const { source, target, comparison } = dataCompare;
  if (!source || !target || !comparison) return;
  const header = `-- Cambios para que ${tableTitle(target)}\n-- tenga los datos de ${tableTitle(source)}${dataCompare.truncated ? ` (solo las primeras ${DATA_LIMIT.toLocaleString()} filas de cada una)` : ""}.\n-- Revísalo antes de ejecutarlo (Ctrl+Mayús+Intro ejecuta el script entero).\n\n`;
  const script = header + dataSyncScript(comparison, { dialect: kindOf(target.connId), table: dataCompare.targetQualified, targetColumns: dataCompare.targetColumns });
  const id = openQuery(target.connId, script, `Sincronizar ${target.obj.name}`);
  if (target.obj.database) patchTab(id, { database: target.obj.database });
  persistSoon();
  closeDataCompare();
}
