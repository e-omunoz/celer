/** What stands for a row value taken out of a server error before it reaches the AI. */
export const OMITTED = "«valor omitido»";

// Messages that quote a row's values. The value is matched up to the message's own closing text, so quotes or
// parentheses inside it do not end it early.
const VALUE_PATTERNS: [RegExp, string][] = [
  // PostgreSQL: a whole failing row, a key's value (in DETAIL, but some drivers put it in the message).
  [/(Failing row contains |La fila que falla contiene )\(.*\)/g, `$1(${OMITTED})`],
  [/(\b(?:Key|[Ll]lave|[Cc]lave) \([^)]*\))=\((?:[^()\n]|\([^()\n]*\))*\)/g, `$1=(${OMITTED})`],
  // PostgreSQL: a value that does not convert (also from a column read by the query).
  [/(invalid input (?:syntax|value) for (?:type |enum )?[^:\n]+: )".*"/g, `$1"${OMITTED}"`],
  [/(no es válid[ao] para (?:el )?(?:tipo|enum) [^:\n]+: )«.*»/g, `$1«${OMITTED}»`],
  // MySQL / MariaDB.
  [/(Duplicate entry ').*(' for key)/g, `$1${OMITTED}$2`],
  [/(Truncated incorrect [\w ]+ value: ').*(')/g, `$1${OMITTED}$2`],
  [/(Incorrect [\w ]+ value: ').*(' for column)/g, `$1${OMITTED}$2`],
  // SQL Server.
  [/(duplicate key value is \().*(\))/g, `$1${OMITTED}$2`],
  [/(converting the [\w ]+ value ').*(' to data type)/g, `$1${OMITTED}$2`],
  [/(Truncated value: ').*(')/g, `$1${OMITTED}$2`],
];

/**
 * The server error as the in-app assistant gets it. Errors can carry row values: PostgreSQL's DETAIL holds a whole
 * failing row or a key's value, and duplicate-key and conversion messages quote the value. Unless the connection's AI
 * level lets the assistant read data («Lectura» or above), the DETAIL and CONTEXT lines are left out and the values in
 * those messages become «valor omitido»; the rest (code, message, hint, position) is kept for the fix.
 */
export function errorForAi(error: string, dataAllowed: boolean): { text: string; redacted: boolean } {
  if (dataAllowed) return { text: error, redacted: false };
  let text = error.replace(/(?:^|\s|;)(?:Detalle|DETALLE|DETAIL|Contexto|CONTEXTO|CONTEXT):[^\n]*/g, "");
  for (const [re, to] of VALUE_PATTERNS) text = text.replace(re, to);
  text = text.replace(/\n{2,}/g, "\n").trim();
  return { text, redacted: text !== error.trim() };
}
