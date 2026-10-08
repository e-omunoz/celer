// Comparing the rows of two tables (same or different connections): one table is marked from the explorer, the
// other is compared with it. Both are read whole, up to DATA_LIMIT rows, on side sessions, and matched by the
// source's primary key (or a guessed unique column).
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { columnIndex, compareResults, guessKey, keyIsUnique, type Comparison } from "./compare";
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
  /** Why no synchronization script is offered ("": it is). */
  blocked: "",
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

interface Side {
  sid: string;
  columns: TableColumn[];
  select: string;
  qualified: string;
}

async function openSide(ref: TableRef, sessions: string[]): Promise<Side> {
  const opened = await openSessionFor(ref.connId);
  if (!opened) throw new Error(`No se pudo abrir «${connectionById(ref.connId)?.name ?? "?"}»`);
  sessions.push(opened.sessionId);
  const sid = opened.sessionId;
  if (ref.obj.database) await api().useDatabase(sid, ref.obj.database).catch(() => {});
  const [columns, info] = await Promise.all([api().tableColumns(sid, ref.obj), api().objectSql(sid, ref.obj)]);
  return { sid, columns, select: info.select, qualified: info.qualified };
}

/** The rows, ordered by `order` (column names) so that capped reads of both tables cover the same keys. */
async function readRows(side: Side, ref: TableRef, order: string[]): Promise<{ result: ResultSet; more: boolean }> {
  const quoted = order.length ? await api().quoteIdents(side.sid, order) : [];
  const sql = quoted.length ? `${side.select} ORDER BY ${quoted.join(", ")}` : side.select;
  // One row more than the limit says whether there were more.
  const out = await api().execute(side.sid, sql, DATA_LIMIT + 1);
  const result = out.results.find((r) => r.columns.length);
  if (!result) throw new Error(`${ref.obj.name} no devolvió filas`);
  return { result: { ...result, rows: result.rows.slice(0, DATA_LIMIT) }, more: result.rows.length > DATA_LIMIT || result.hasMore };
}

export async function runDataCompare(source: TableRef, target: TableRef) {
  const run = ++token;
  setDataCompare({ open: true, source, target, loading: true, error: "", comparison: null, truncated: false, blocked: "", targetColumns: [], targetQualified: "" });
  const live = () => run === token && dataCompare.open;
  const sessions: string[] = [];
  try {
    const sides = await Promise.allSettled([openSide(source, sessions), openSide(target, sessions)]);
    const failed = sides.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const [s, t] = sides.map((r) => (r as PromiseFulfilledResult<Side>).value);
    if (!live()) return;
    if (!s.columns.some((c) => columnIndex(t.columns, c.name) >= 0)) throw new Error("Las dos tablas no tienen ninguna columna en común");
    // Rows matched by the source's primary key when the target has those columns (in its own spelling).
    const pk = s.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const pkInTarget = pk.map((name) => t.columns[columnIndex(t.columns, name)]?.name).filter((name): name is string => Boolean(name));
    const ordered = pk.length > 0 && pkInTarget.length === pk.length;
    const [sr, tr] = await Promise.all([readRows(s, source, ordered ? pk : []), readRows(t, target, ordered ? pkInTarget : [])]);
    if (!live()) return;
    const key = ordered ? pk : guessKey(tr.result, sr.result);
    // Target first: the comparison shows the source's values and keeps the target's old ones.
    const comparison = compareResults(tr.result, sr.result, key);
    const truncated = sr.more || tr.more;
    // A script only from complete data and rows that a key identifies one by one.
    const blocked = truncated
      ? `Una de las tablas tiene más de ${DATA_LIMIT.toLocaleString()} filas: la comparación es parcial y no se genera script.`
      : !comparison.key.length
        ? "Sin una clave que identifique cada fila (clave primaria o columna única) no se genera script."
        : !keyIsUnique(tr.result, comparison.key) || !keyIsUnique(sr.result, comparison.key)
          ? `La clave (${comparison.key.join(", ")}) se repite en alguna de las tablas: no se genera script.`
          : "";
    setDataCompare({ loading: false, comparison, truncated, blocked, targetColumns: t.columns, targetQualified: t.qualified, runId: dataCompare.runId + 1 });
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
  if (!source || !target || !comparison || dataCompare.blocked) return;
  const header = `-- Cambios para que ${tableTitle(target)}\n-- tenga los datos de ${tableTitle(source)}${dataCompare.truncated ? ` (solo las primeras ${DATA_LIMIT.toLocaleString()} filas de cada una)` : ""}.\n-- Revísalo antes de ejecutarlo (Ctrl+Mayús+Intro ejecuta el script entero).\n\n`;
  const script = header + dataSyncScript(comparison, { dialect: kindOf(target.connId), table: dataCompare.targetQualified, targetColumns: dataCompare.targetColumns });
  const id = openQuery(target.connId, script, `Sincronizar ${target.obj.name}`);
  if (target.obj.database) patchTab(id, { database: target.obj.database });
  persistSoon();
  closeDataCompare();
}
