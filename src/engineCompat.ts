// Which engines a piece of SQL is written for, and which features each engine supports. Pure functions: the library,
// the templates, the history and the menus use them; dev/engine-compat-check.ts tests them with samples per engine.
//
// The guess comes, in this order, from what the user set («Genérico / SQL estándar» included), from the SQL's
// dialect (TOP / LIMIT / FIRST, ::, backticks and brackets, ILIKE, GETDATE(), NVL…) and from the connection it was
// saved or run with. Generic ODBC can be any engine underneath: nothing is ever flagged against it.
import type { EngineTag } from "./libraryModel";
import type { DbKind } from "./types";

/** Engines in the order badges show them. */
const ORDER: DbKind[] = ["postgres", "mysql", "mssql", "sqlite", "informix", "odbc"];

const KIND_LABELS: Record<DbKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  mssql: "SQL Server",
  sqlite: "SQLite",
  informix: "Informix",
  odbc: "ODBC",
};

export function kindLabel(kind: DbKind): string {
  return KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------- dialect detection

interface Rule {
  re: RegExp;
  engines: DbKind[];
  /** What gave it away, for the badge's tooltip. */
  hint: string;
}

const PG: DbKind = "postgres";
const MY: DbKind = "mysql";
const MS: DbKind = "mssql";
const LITE: DbKind = "sqlite";
const IFX: DbKind = "informix";

/** Markers matched on the SQL without comments and with string contents emptied (quoted identifiers stay). */
const RULES: Rule[] = [
  // SQL Server
  { re: /\bselect\s+(?:distinct\s+)?top\s*\(?\s*\d/i, engines: [MS], hint: "TOP" },
  { re: /\b(?:update|delete)\s+top\s*\(/i, engines: [MS], hint: "TOP" },
  { re: /\bgetdate\s*\(\s*\)/i, engines: [MS], hint: "GETDATE()" },
  { re: /\bsysdatetime\s*\(/i, engines: [MS], hint: "SYSDATETIME()" },
  { re: /\bisnull\s*\([^()]*,/i, engines: [MS], hint: "ISNULL(a, b)" },
  { re: /(?:^|[\s.,(=])\[[A-Za-z_][\w ]*\]/, engines: [MS], hint: "[corchetes]" },
  { re: /\b(?:nvarchar|datetime2|uniqueidentifier|datetimeoffset)\b/i, engines: [MS], hint: "tipos de SQL Server" },
  { re: /@@\w+/, engines: [MS], hint: "@@variable" },
  { re: /\bdeclare\s+@/i, engines: [MS], hint: "DECLARE @" },
  { re: /^\s*go\s*$/im, engines: [MS], hint: "GO" },
  { re: /\bwith\s*\(\s*nolock\s*\)/i, engines: [MS], hint: "NOLOCK" },
  { re: /\b(?:dateadd|charindex|len)\s*\(/i, engines: [MS], hint: "funciones de SQL Server" },
  { re: /\boutput\s+(?:inserted|deleted)\./i, engines: [MS], hint: "OUTPUT inserted" },
  { re: /\bstring_agg\s*\(/i, engines: [PG, MS], hint: "STRING_AGG" },
  // PostgreSQL
  { re: /\bilike\b/i, engines: [PG], hint: "ILIKE" },
  { re: /\$[A-Za-z_]*\$/, engines: [PG], hint: "$$" },
  { re: /\bjsonb\b/i, engines: [PG], hint: "jsonb" },
  { re: /\bgenerate_series\s*\(/i, engines: [PG], hint: "generate_series" },
  { re: /\bpg_[a-z_]+/i, engines: [PG], hint: "pg_catalog" },
  { re: /\bdistinct\s+on\s*\(/i, engines: [PG], hint: "DISTINCT ON" },
  { re: /::\s*[A-Za-z_"]/, engines: [PG, IFX], hint: "::tipo" },
  { re: /\b(?:big)?serial\b/i, engines: [PG, IFX], hint: "SERIAL" },
  { re: /\bon\s+conflict\b/i, engines: [PG, LITE], hint: "ON CONFLICT" },
  { re: /\breturning\b/i, engines: [PG, LITE, MY], hint: "RETURNING" },
  { re: /\bnow\s*\(\s*\)/i, engines: [PG, MY], hint: "NOW()" },
  // MySQL / MariaDB
  { re: /`[^`]*`/, engines: [MY, LITE], hint: "`comillas invertidas`" },
  { re: /\bauto_increment\b/i, engines: [MY], hint: "AUTO_INCREMENT" },
  { re: /\bengine\s*=/i, engines: [MY], hint: "ENGINE=" },
  { re: /\bshow\s+(?:full\s+)?(?:tables|databases|columns|create|processlist|variables|status|index|grants)\b/i, engines: [MY], hint: "SHOW" },
  { re: /\bunsigned\b/i, engines: [MY], hint: "UNSIGNED" },
  { re: /\b(?:date_format|str_to_date|curdate|date_add|date_sub)\s*\(/i, engines: [MY], hint: "funciones de MySQL" },
  { re: /\bon\s+duplicate\s+key\b/i, engines: [MY], hint: "ON DUPLICATE KEY" },
  { re: /\bifnull\s*\(/i, engines: [MY, LITE], hint: "IFNULL" },
  { re: /\bgroup_concat\s*\(/i, engines: [MY, LITE], hint: "GROUP_CONCAT" },
  { re: /\blimit\s+\d+\s*,\s*\d+/i, engines: [MY, LITE], hint: "LIMIT a, b" },
  { re: /(?<!\bselect\s+(?:skip\s+\d+\s+)?)\blimit\s+(?:\d+|:\w+|\?)/i, engines: [PG, MY, LITE], hint: "LIMIT" },
  // Informix
  { re: /\bselect\s+(?:skip\s+\d+\s+)?(?:first|limit)\s+\d+/i, engines: [IFX], hint: "FIRST" },
  { re: /\bskip\s+\d+\b/i, engines: [IFX], hint: "SKIP" },
  { re: /\bnvl\s*\(/i, engines: [IFX], hint: "NVL" },
  { re: /\btoday\b/i, engines: [IFX], hint: "TODAY" },
  { re: /\b(?:year|month|day|hour|minute)\s+to\s+(?:year|month|day|hour|minute|second|fraction)\b/i, engines: [IFX], hint: "DATETIME … TO" },
  { re: /\b(?:systables|syscolumns|sysindexes|sysconstraints)\b/i, engines: [IFX], hint: "catálogo de Informix" },
  { re: /\bmatches\s+'/i, engines: [IFX], hint: "MATCHES" },
  { re: /\blvarchar\b/i, engines: [IFX], hint: "LVARCHAR" },
  { re: /\bmdy\s*\(/i, engines: [IFX], hint: "MDY()" },
  { re: /\binto\s+temp\b/i, engines: [IFX], hint: "INTO TEMP" },
  // SQLite
  { re: /\bpragma\b/i, engines: [LITE], hint: "PRAGMA" },
  { re: /\bsqlite_(?:master|schema|sequence)\b/i, engines: [LITE], hint: "sqlite_master" },
  { re: /\bautoincrement\b/i, engines: [LITE], hint: "AUTOINCREMENT" },
  { re: /\b(?:strftime|julianday|typeof)\s*\(/i, engines: [LITE], hint: "funciones de SQLite" },
  { re: /\bglob\b/i, engines: [LITE], hint: "GLOB" },
];

/**
 * The SQL with comments blanked out and the contents of '…' strings emptied (the quotes stay, so "MATCHES '…'" still
 * reads as one). Double quotes, backticks and brackets are kept: they tell engines apart.
 */
function markers(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface Detection {
  /** The engines the SQL fits, in badge order ([] when nothing in it is engine specific). */
  engines: DbKind[];
  /** What gave it away ("TOP", "ILIKE"…). */
  hints: string[];
}

/** The engines a SQL text is written for, from its dialect only. Contradicting markers: the engines most of them point to. */
export function detectEngines(sql: string): Detection {
  const code = markers(sql);
  const hits = RULES.filter((rule) => rule.re.test(code));
  if (!hits.length) return { engines: [], hints: [] };
  let common = new Set<DbKind>(hits[0].engines);
  for (const rule of hits.slice(1)) common = new Set(rule.engines.filter((kind) => common.has(kind)));
  if (!common.size) {
    const votes = new Map<DbKind, number>();
    for (const rule of hits) for (const kind of rule.engines) votes.set(kind, (votes.get(kind) ?? 0) + 1);
    const best = Math.max(...votes.values());
    common = new Set([...votes].filter(([, count]) => count === best).map(([kind]) => kind));
  }
  return { engines: ORDER.filter((kind) => common.has(kind)), hints: [...new Set(hits.filter((rule) => rule.engines.some((kind) => common.has(kind))).map((rule) => rule.hint))] };
}

export interface EngineGuess {
  /** The engines it is for ([] for generic or unknown). */
  engines: DbKind[];
  /** override: set by the user · sql: from its dialect · connection: from the connection it was saved or run with · none. */
  source: "override" | "sql" | "connection" | "none";
  /** The user marked it «Genérico / SQL estándar». */
  generic: boolean;
  hints: string[];
}

/** The engines of a script, a template or a history entry: the user's choice, else the dialect, else its connection. */
export function guessEngines(sql: string, options: { override?: EngineTag; connKind?: DbKind } = {}): EngineGuess {
  if (options.override === "generic") return { engines: [], source: "override", generic: true, hints: [] };
  if (options.override) return { engines: [options.override], source: "override", generic: false, hints: [] };
  const found = detectEngines(sql);
  if (found.engines.length) return { engines: found.engines, source: "sql", generic: false, hints: found.hints };
  if (options.connKind && options.connKind !== "odbc") return { engines: [options.connKind], source: "connection", generic: false, hints: [] };
  return { engines: [], source: "none", generic: false, hints: [] };
}

export type Compat = "ok" | "warn" | "unknown";

/**
 * Whether something guessed as `guess` fits a connection of `kind`: unknown without a connection or on generic ODBC
 * (any engine underneath), ok for generic SQL and for the engines it is for, warn otherwise.
 */
export function compatibility(guess: EngineGuess, kind: DbKind | undefined): Compat {
  if (!kind || kind === "odbc") return "unknown";
  if (!guess.engines.length) return "ok";
  return guess.engines.includes(kind) || guess.engines.includes("odbc") ? "ok" : "warn";
}

/** A mismatch worth a confirmation before running: what the user set, or what the SQL itself says (not a mere connection). */
export function needsEngineConfirm(guess: EngineGuess, kind: DbKind | undefined): boolean {
  return compatibility(guess, kind) === "warn" && (guess.source === "override" || guess.source === "sql");
}

/** For the «solo compatibles» filters: anything not flagged (unknown counts as compatible). */
export function isCompatible(guess: EngineGuess, kind: DbKind | undefined): boolean {
  return compatibility(guess, kind) !== "warn";
}

/** The badge's tooltip: what it is for, why, and how it compares with `kind`. */
export function guessText(guess: EngineGuess, kind?: DbKind): string {
  const what = guess.generic
    ? "Genérico / SQL estándar (marcado a mano)"
    : !guess.engines.length
      ? "Sin marcas de un motor concreto: SQL estándar"
      : `Para ${guess.engines.map(kindLabel).join(", ")}${
          guess.source === "override" ? " (marcado a mano)" : guess.source === "sql" ? ` (detectado: ${guess.hints.join(", ")})` : " (por la conexión con la que se guardó o ejecutó)"
        }`;
  const compat = compatibility(guess, kind);
  if (compat === "warn") return `${what}. No coincide con ${kindLabel(kind!)}, el motor de la conexión.`;
  return what;
}

// ---------------------------------------------------------------- features per engine

export type Feature = "plan" | "analyze" | "er" | "activity" | "schemaCompare" | "dataCompare" | "mcp";

/**
 * Where each feature works. One table: menus, toolbar buttons and the palette grey out what is not here, with
 * «No disponible en <motor>», instead of failing on click.
 * - plan: EXPLAIN as Celer reads it (Informix and generic ODBC have none it can read).
 * - analyze: the real plan, only PostgreSQL and MariaDB (checked again per server, see canAnalyze in state.ts).
 * - er, schemaCompare: need the catalog's tables and foreign keys in the explorer (generic ODBC lists tables only).
 * - activity: the server's sessions (SQLite has no server; generic ODBC no common view of them).
 */
export const FEATURE_SUPPORT: Record<Feature, { label: string; engines: DbKind[] }> = {
  plan: { label: "Plan de ejecución", engines: ["postgres", "mysql", "mssql", "sqlite"] },
  analyze: { label: "Plan real (EXPLAIN ANALYZE)", engines: ["postgres", "mysql"] },
  er: { label: "Diagrama de relaciones", engines: ["postgres", "mysql", "mssql", "sqlite", "informix"] },
  activity: { label: "Actividad del servidor", engines: ["postgres", "mysql", "mssql", "informix"] },
  schemaCompare: { label: "Comparar esquemas", engines: ["postgres", "mysql", "mssql", "sqlite", "informix"] },
  dataCompare: { label: "Comparar datos", engines: ["postgres", "mysql", "mssql", "sqlite", "informix", "odbc"] },
  mcp: { label: "Herramientas MCP", engines: ["postgres", "mysql", "mssql", "sqlite", "informix", "odbc"] },
};

/** null when `feature` works on `kind` (or there is no connection to judge by), else «No disponible en <motor>». */
export function unsupportedReason(feature: Feature, kind: DbKind | undefined, serverInfo = ""): string | null {
  if (!kind) return null;
  const engines = FEATURE_SUPPORT[feature].engines;
  if (!engines.includes(kind)) return `No disponible en ${kind === "odbc" ? "ODBC genérico" : kindLabel(kind)}`;
  // MySQL proper reads no analyzed plan; MariaDB does (same connection kind).
  if (feature === "analyze" && kind === "mysql" && serverInfo && !/mariadb/i.test(serverInfo)) return "No disponible en MySQL (sí en MariaDB)";
  return null;
}
