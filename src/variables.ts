// Variables: values defined once and written as ${name} in consoles and library scripts. Pure functions (the file
// format, scopes, finding and substituting them), tested by dev/variables-check.ts; variableStore.ts keeps the state.
//
// Scopes, the first that defines a name wins: the console's own, then the connection's, then the global ones.
// ${name} does not clash with any engine's own syntax (:name, ?, $1, @var, @@var, $$…$$) and was already Celer's
// prompted placeholder: a name no scope defines is still asked for at run time, like before. Inside strings, quoted
// identifiers and comments nothing is replaced. A value goes in as a literal (numbers, NULL, TRUE and FALSE as they
// are, anything else quoted) unless it is marked as SQL, which goes in as typed (a table name, a list for IN…).
import { codeOnly } from "./sql.ts";
import { paramLiteral } from "./snippets.ts";

export interface Variable {
  name: string;
  value: string;
  /** Written into the SQL as typed (not as a quoted literal). */
  raw?: boolean;
  description?: string;
}

export type VarScope = "console" | "connection" | "global";

export const SCOPE_LABELS: Record<VarScope, string> = { console: "Consola", connection: "Conexión", global: "Global" };

/** variables.json: the global variables and those of each connection (by id). The console ones live in each console. */
export interface VariablesData {
  global: Variable[];
  connections: Record<string, Variable[]>;
}

export const VARIABLES_VERSION = 1;

const NAME = /^[A-Za-z_]\w{0,62}$/;

export function validVarName(name: string): boolean {
  return NAME.test(name);
}

/** Valid variables, each name once (the first wins), values kept to a sane length. */
export function normalizeVariables(value: unknown): Variable[] {
  const out: Variable[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const name = typeof v.name === "string" ? v.name.trim().replace(/^\$\{(.*)\}$/, "$1") : "";
    if (!validVarName(name) || seen.has(name)) continue;
    seen.add(name);
    const variable: Variable = { name, value: typeof v.value === "string" ? v.value.slice(0, 20_000) : typeof v.value === "number" ? String(v.value) : "" };
    if (v.raw === true) variable.raw = true;
    if (typeof v.description === "string" && v.description.trim()) variable.description = v.description.trim().slice(0, 400);
    out.push(variable);
  }
  return out;
}

/** Reads variables.json in any shape (null when there is none), keeping unknown top-level fields in `extra`. */
export function migrateVariables(raw: unknown): VariablesData & { extra: Record<string, unknown> } {
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) if (!["version", "global", "connections"].includes(key)) extra[key] = value;
  const connections: Record<string, Variable[]> = {};
  if (file.connections && typeof file.connections === "object" && !Array.isArray(file.connections)) {
    for (const [id, list] of Object.entries(file.connections as Record<string, unknown>)) {
      const vars = normalizeVariables(list);
      if (id && vars.length) connections[id] = vars;
    }
  }
  return { global: normalizeVariables(file.global), connections, extra };
}

export function serializeVariables(data: VariablesData, extra: Record<string, unknown> = {}) {
  const connections = Object.fromEntries(Object.entries(data.connections).filter(([, list]) => list.length));
  return { ...extra, version: VARIABLES_VERSION, global: data.global, connections };
}

/** Adds or replaces `variable` in a list (by name; `previous` is its old name when renamed). */
export function upsertVariable(list: Variable[], variable: Variable, previous?: string): Variable[] {
  const key = previous ?? variable.name;
  // Another variable already called like the new name goes (the edited one takes its place).
  const rest = list.filter((v) => v.name === key || v.name !== variable.name);
  const at = rest.findIndex((v) => v.name === key);
  return at >= 0 ? rest.map((v, i) => (i === at ? variable : v)) : [...rest, variable];
}

// ---------------------------------------------------------------- scopes

export interface ResolvedVar extends Variable {
  scope: VarScope;
}

/** Every name with the value that applies: console > connection > global. */
export function resolveVariables(scopes: { console?: Variable[]; connection?: Variable[]; global?: Variable[] }): Map<string, ResolvedVar> {
  const out = new Map<string, ResolvedVar>();
  const add = (list: Variable[] | undefined, scope: VarScope) => {
    for (const v of list ?? []) if (!out.has(v.name)) out.set(v.name, { ...v, scope });
  };
  add(scopes.console, "console");
  add(scopes.connection, "connection");
  add(scopes.global, "global");
  return out;
}

// ---------------------------------------------------------------- in the SQL

export interface VarRef {
  name: string;
  from: number;
  to: number;
}

/** Every ${name} in the code (not in strings, quoted identifiers or comments), in order. */
export function findVariables(sql: string, dialect?: string): VarRef[] {
  const code = codeOnly(sql, dialect);
  const out: VarRef[] = [];
  const re = /\$\{([A-Za-z_]\w*)\}/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push({ name: m[1], from: m.index, to: m.index + m[0].length });
  return out;
}

/** The ${name} at `pos` (the caret or the mouse), if any. */
export function variableAt(sql: string, pos: number, dialect?: string): VarRef | null {
  return findVariables(sql, dialect).find((ref) => pos >= ref.from && pos <= ref.to) ?? null;
}

/** The text a variable's value becomes in the SQL. */
export function variableLiteral(variable: Variable, dialect?: string): string {
  return paramLiteral(variable.value, Boolean(variable.raw), dialect);
}

export interface Substitution {
  /** The SQL with every defined variable replaced (what is sent, kept in the history and the output log). */
  sql: string;
  /** The variables used, once each, in order of appearance. */
  used: ResolvedVar[];
  /** Names no scope defines: left as ${name}, for the parameters prompt to ask. */
  missing: string[];
}

export function substituteVariables(sql: string, resolved: Map<string, ResolvedVar>, dialect?: string): Substitution {
  const refs = findVariables(sql, dialect);
  const used = new Map<string, ResolvedVar>();
  const missing = new Set<string>();
  let out = sql;
  // From the end, so the offsets stay valid.
  for (const ref of [...refs].reverse()) {
    const variable = resolved.get(ref.name);
    if (!variable) {
      missing.add(ref.name);
      continue;
    }
    out = out.slice(0, ref.from) + variableLiteral(variable, dialect) + out.slice(ref.to);
  }
  for (const ref of refs) {
    const variable = resolved.get(ref.name);
    if (variable && !used.has(ref.name)) used.set(ref.name, variable);
  }
  return { sql: out, used: [...used.values()], missing: refs.map((r) => r.name).filter((name, i, all) => missing.has(name) && all.indexOf(name) === i) };
}
