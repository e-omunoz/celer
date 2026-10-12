// What Gib says: the tips he shares (on a click, from the palette, or now and then while you are idle) and the
// advice about the statement that just ran. Pure functions, so dev/gib-advice-check.ts can test them without the
// app; the companion (Companion.tsx) decides when to speak.
import { codeOnly } from "../sql.ts";

/** The shortcut of a command as the user has it ("Ctrl+Intro"), or "" when it has none. */
export type KeysOf = (commandId: string) => string;

export interface Tip {
  id: string;
  text: (keys: KeysOf) => string;
}

/** "con Ctrl+Alt+B" / "desde la paleta (Mayús dos veces)" when the user removed the shortcut. */
function via(keys: KeysOf, id: string, fallback = "desde la paleta (Mayús dos veces)") {
  const k = keys(id);
  return k ? `con ${k}` : fallback;
}

export const TIPS: Tip[] = [
  { id: "run", text: (k) => `${k("run") || "El botón Ejecutar"} ejecuta la sentencia bajo el cursor, o la selección si la hay.` },
  { id: "palette", text: () => "Pulsa Mayús dos veces para buscar tablas, pestañas, scripts de la biblioteca y acciones." },
  { id: "go-table", text: (k) => `Salta a cualquier tabla de las conexiones abiertas ${via(k, "go-table")}.` },
  { id: "stats", text: () => "Selecciona varias celdas: la barra de estado muestra suma, media, mínimo y máximo." },
  { id: "filter", text: () => "En una tabla, «+ Filtro» crea filtros por columna sin escribir SQL." },
  { id: "filter-value", text: () => "Clic derecho en una celda: «Filtrar por este valor» añade el filtro por ti." },
  { id: "find", text: () => "Ctrl+F busca dentro de los resultados; F3 salta a la siguiente coincidencia." },
  { id: "explain", text: (k) => `Mira el plan de ejecución de la sentencia ${via(k, "explain")}.` },
  { id: "drag-table", text: () => "Arrastra una tabla del explorador al editor para escribir su nombre." },
  { id: "production", text: () => "Pon una conexión en el entorno Producción: se verá en rojo y pedirá confirmación antes de un UPDATE o DELETE sin WHERE." },
  { id: "save-table", text: () => "Al guardar cambios en una tabla verás el SQL; se aplica en una sola transacción." },
  { id: "inspector", text: (k) => `El panel de valor muestra el JSON formateado y la fila como formulario: ábrelo ${via(k, "toggle-inspector")}.` },
  { id: "autofit", text: () => "Doble clic en el borde de una cabecera ajusta el ancho de la columna." },
  { id: "copy-as", text: () => "Copia una selección como JSON, Markdown, INSERT o lista IN desde el clic derecho." },
  { id: "ctrl-click", text: () => "Ctrl+clic en el nombre de una tabla dentro del SQL la abre; en una clave foránea, va a la fila." },
  { id: "library", text: (k) => `Guarda las consultas que repites en la biblioteca ${via(k, "save-library")}; la abres ${via(k, "library")}.` },
  { id: "library-folders", text: () => "En la biblioteca puedes crear carpetas, poner etiquetas y arrastrar los scripts de una a otra." },
  { id: "library-drag", text: () => "Arrastra un script de la biblioteca al editor para pegar su SQL donde lo sueltes." },
  { id: "library-run", text: () => "En la biblioteca, Ctrl+Intro sobre un script lo abre y lo ejecuta; F2 lo renombra y Supr lo borra (con deshacer)." },
  { id: "params", text: () => "Escribe :nombre en una consulta y Celer te pedirá su valor al ejecutarla." },
  { id: "pin", text: () => "Fija un resultado con la chincheta y compáralo después con el de la siguiente ejecución." },
];

/**
 * The next tip to show: the first one not seen yet from `start` on (in a circle). When every tip has been seen,
 * `unseenOnly` gives null (Gib stops volunteering them); otherwise the one at `start`.
 */
export function nextTip(start: number, seen: ReadonlySet<string>, unseenOnly: boolean): { tip: Tip; index: number } | null {
  const n = TIPS.length;
  for (let i = 0; i < n; i++) {
    const index = (((start + i) % n) + n) % n;
    if (!seen.has(TIPS[index].id)) return { tip: TIPS[index], index };
  }
  if (unseenOnly) return null;
  const index = ((start % n) + n) % n;
  return { tip: TIPS[index], index };
}

export interface RunInfo {
  sql: string;
  /** The engine (dialect for comments and strings, and the right words: LIMIT, TOP, FIRST). */
  kind?: string;
  ms: number;
  /** Columns of the first result with a grid (0 when there is none). */
  columns: number;
  /** The server has more rows than the first page. */
  hasMore: boolean;
}

export interface Advice {
  id: string;
  text: string;
  /** "warn": probably not what you meant; "tip": it works, but it could be faster or simpler. */
  kind: "warn" | "tip";
  /** Offer the execution plan. */
  plan?: boolean;
}

/** A query is "slow" from here on (ms): performance advice only makes sense then. */
export const SLOW_MS = 1500;

/**
 * Advice about the statement that just ran, or null. The first match wins: likely mistakes first (they change the
 * result), then performance (only when it was slow), then habits.
 */
export function queryAdvice(run: RunInfo): Advice | null {
  const raw = run.sql;
  const code = codeOnly(raw, run.kind).toLowerCase();
  if (!code.trim()) return null;
  const slow = run.ms >= SLOW_MS;

  // = NULL is never true (nor <> NULL): the query returns nothing, or not what was meant. Only in conditions:
  // "SET x = NULL" is an assignment.
  if (/(?:^|[^<>!=:])(?:=|<>|!=)\s*null\b/.test(conditions(code))) {
    return { id: "eq-null", kind: "warn", text: "«= NULL» nunca es cierto, ni «<> NULL»: para buscar valores nulos usa IS NULL o IS NOT NULL." };
  }
  // NOT IN (SELECT …): a single NULL in the subquery and no row matches.
  if (/\bnot\s+in\s*\(\s*select\b/.test(code)) {
    return { id: "not-in-null", kind: "warn", text: "Ojo con NOT IN (SELECT …): si la subconsulta devuelve algún NULL, no sale ninguna fila. NOT EXISTS no tiene ese problema." };
  }
  // FROM a, b without WHERE: every row of a with every row of b.
  if (/^\s*select\b/.test(code) && !/\bwhere\b|\bjoin\b/.test(code) && /\bfrom\s+[^\s,()]+(?:\s+(?:as\s+)?[a-z_][\w$]*)?\s*,\s*[^\s,()]+/.test(code)) {
    return { id: "cartesian", kind: "warn", text: "Varias tablas separadas por comas sin WHERE: es un producto cartesiano (cada fila con todas las demás). ¿Falta un JOIN … ON?" };
  }

  if (slow) {
    if (likeLeadingWildcard(raw, code)) {
      return { id: "like-leading", kind: "tip", plan: true, text: "LIKE '%…' (comodín al principio) no puede usar índices y recorre toda la tabla. Si puedes, busca por el principio del texto." };
    }
    if (/\bwhere\b[\s\S]*\b(?:upper|lower|trim|year|month|date|trunc|substr|substring|to_char|convert|cast|coalesce|isnull|nvl)\s*\(\s*[a-z_"`[][\w."`\]]*\s*[),]/.test(code)) {
      return { id: "function-where", kind: "tip", plan: true, text: "Una función sobre una columna en el WHERE impide usar su índice. Compara la columna tal cual (por ejemplo, con un rango de fechas)." };
    }
    if (/\bunion\b(?!\s+all\b)/.test(code)) {
      return { id: "union-all", kind: "tip", text: "UNION quita los duplicados, y para eso ordena todo. Si no puede haberlos, UNION ALL es más rápido." };
    }
    if (run.hasMore && /\border\s+by\b/.test(code) && !limited(code)) {
      return { id: "order-limit", kind: "tip", text: `Con ORDER BY el servidor ordena todas las filas aunque solo veas la primera página. Si te bastan las primeras, añade ${limitWord(run.kind)}.` };
    }
  }

  if (/^\s*select\s+\*\s+from\b/.test(code) && run.columns > 12 && raw.length < 400) {
    return { id: "select-star", kind: "tip", text: "Muchas columnas: nombra solo las que necesitas y la consulta irá más rápida." };
  }
  return null;
}

/**
 * The conditions: the text after each WHERE / ON / HAVING / WHEN, up to the end of the statement or to a THEN or
 * SET that follows (MERGE … WHEN MATCHED THEN UPDATE SET x = NULL assigns).
 */
function conditions(code: string): string {
  const parts: string[] = [];
  const re = /\b(?:where|on|having|when)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const rest = code.slice(m.index + m[0].length);
    const end = rest.search(/;|\bthen\b|\bset\b/);
    parts.push(end < 0 ? rest : rest.slice(0, end));
  }
  return parts.join(" ");
}

/** LIKE '%…' in the code (not in a comment or a string): the pattern is read from the raw text at the same place. */
function likeLeadingWildcard(raw: string, code: string): boolean {
  const re = /\blike\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const pattern = raw.slice(m.index + 4, m.index + 64).replace(/^\s+/, "");
    if (/^n?'%/i.test(pattern)) return true;
  }
  return false;
}

function limited(code: string): boolean {
  return /\blimit\s+\d|\bfetch\s+(?:first|next)\b|\bselect\s+(?:distinct\s+)?(?:top|first)\s+\d|\brownum\b/.test(code);
}

function limitWord(kind?: string): string {
  if (kind === "mssql") return "TOP n";
  if (kind === "informix") return "FIRST n";
  return "LIMIT n";
}

/** The same statement however it is written (spaces, case, a final ";"): to notice the ones you repeat. */
export function statementKey(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
}
