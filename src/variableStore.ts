// The variables of every scope (variables.ts): the global ones and those of each connection in variables.json, shared
// by every window (only the core writes it, see windows.ts); the console ones in each console (kept with the workspace).
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { activeSql, connectionById, notify, patchTab, persistSoon, state, type SqlTab } from "./state";
import { migrateVariables, resolveVariables, serializeVariables, upsertVariable, type ResolvedVar, type Variable, type VarScope } from "./variables";

export const [variables, setVariables] = createStore({
  loaded: false,
  global: [] as Variable[],
  connections: {} as Record<string, Variable[]>,
});

/** Top-level fields of variables.json this version does not know: written back as they were. */
let extra: Record<string, unknown> = {};
let loading: Promise<void> | null = null;
/** The last load failed: saving would replace values that may still be in the file. */
let loadFailed = false;

export function loadVariables(): Promise<void> {
  loading ??= api()
    .loadJson("variables")
    .then((file) => {
      const data = migrateVariables(file);
      extra = data.extra;
      loadFailed = false;
      setVariables({ loaded: true, global: data.global, connections: data.connections });
    })
    .catch((err) => {
      const message = errorText(err);
      loadFailed = !message.includes(".unreadable-");
      if (loadFailed) loading = null;
      setVariables({ loaded: true, global: [], connections: {} });
      notify("No se pudieron leer las variables", "error", message);
    });
  return loading;
}

/** variables.json changed in another window. */
export function applySharedVariables(file: unknown) {
  const data = migrateVariables(file);
  extra = data.extra;
  loadFailed = false;
  loading ??= Promise.resolve();
  setVariables({ loaded: true, global: data.global, connections: data.connections });
}

async function persist() {
  if (loadFailed) {
    notify("Las variables no se guardaron: no se pudo leer el fichero que ya había", "error");
    return;
  }
  try {
    await api().saveJson("variables", serializeVariables({ global: variables.global, connections: variables.connections }, extra));
  } catch (err) {
    notify("No se pudieron guardar las variables", "error", errorText(err));
  }
}

/** The list of a scope: the console's (`owner` its tab id), a connection's (its id) or the global one. */
export function scopeList(scope: VarScope, owner: string | null | undefined): Variable[] {
  if (scope === "global") return variables.global;
  if (!owner) return [];
  if (scope === "connection") return variables.connections[owner] ?? [];
  const tab = state.tabs.find((t): t is SqlTab => t.kind === "sql" && t.id === owner);
  return tab?.vars ?? [];
}

/** Adds or changes a variable (`previous`: its name before a rename). */
export async function saveVariable(scope: VarScope, owner: string | null | undefined, variable: Variable, previous?: string) {
  await writeScope(scope, owner, (list) => upsertVariable(list, variable, previous));
}

export async function deleteVariable(scope: VarScope, owner: string | null | undefined, name: string) {
  await writeScope(scope, owner, (list) => list.filter((v) => v.name !== name));
}

async function writeScope(scope: VarScope, owner: string | null | undefined, change: (list: Variable[]) => Variable[]) {
  if (scope === "console") {
    if (!owner) return;
    setConsoleVariables(owner, change(scopeList("console", owner)));
    return;
  }
  await loadVariables();
  if (scope === "global") setVariables("global", change(variables.global));
  else if (owner) setVariables("connections", owner, change(variables.connections[owner] ?? []));
  await persist();
}

/** A console's own variables (kept with the console in the workspace). */
export function setConsoleVariables(tabId: string, list: Variable[]) {
  patchTab(tabId, { vars: list.length ? list : undefined });
  persistSoon();
}

/** What applies in a console: its own variables, then its connection's (or `connId`'s), then the global ones. */
export function resolvedFor(tab: Pick<SqlTab, "vars" | "connId"> | undefined, connId = tab?.connId): Map<string, ResolvedVar> {
  return resolveVariables({ console: tab?.vars, connection: connId ? variables.connections[connId] : undefined, global: variables.global });
}

/** The active console's variables, as the editor's completion and hover show them. */
export function activeResolved(): Map<string, ResolvedVar> {
  return resolvedFor(activeSql());
}

/** "Conexión «Producción»", "Consola", "Global": where a value comes from. */
export function scopeText(variable: ResolvedVar, connId?: string | null): string {
  if (variable.scope === "connection") return `conexión «${connectionById(connId)?.name ?? "?"}»`;
  return variable.scope === "console" ? "esta consola" : "global";
}
