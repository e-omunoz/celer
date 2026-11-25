// Light SQL analysis for the editor: which tables a statement uses (with aliases), what kind of name is
// expected at the caret, and which table an identifier refers to. Used by completion and Ctrl+click.
import type { CompletionTable } from "./types";

export interface TableRef {
  table: CompletionTable;
  /** Alias written in the statement (or the table name when there is none). */
  alias: string;
}

const IDENT = String.raw`(?:[A-Za-z_$][\w$]*|"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\])`;
/** server.db.owner.table, and Informix's database[@server]:owner.table. */
const QUALIFIED = String.raw`(?:${IDENT}(?:@${IDENT})?\s*:\s*)?${IDENT}(?:\s*\.\s*${IDENT}){0,3}`;
/** Words that can follow a table name but are not aliases. */
const NOT_ALIAS = new Set(
  "where join inner left right full outer cross natural on using group order by having limit offset union intersect except set values select from as returning window fetch for into lateral with and or not when then else end".split(" "),
);

export function unquoteIdent(name: string) {
  const n = name.trim();
  if ((n.startsWith('"') && n.endsWith('"')) || (n.startsWith("`") && n.endsWith("`"))) return n.slice(1, -1).replace(/""/g, '"');
  if (n.startsWith("[") && n.endsWith("]")) return n.slice(1, -1);
  return n;
}

export function splitQualified(text: string): string[] {
  return (text.match(new RegExp(IDENT, "g")) ?? []).map(unquoteIdent);
}

/** Finds a table by (schema.)name, case-insensitively, preferring the default schema. */
export function findTable(tables: CompletionTable[], parts: string[], defaultSchema?: string): CompletionTable | undefined {
  if (!parts.length) return undefined;
  const name = parts[parts.length - 1].toLowerCase();
  const schema = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : undefined;
  const matches = tables.filter((t) => t.name.toLowerCase() === name && (!schema || t.schema.toLowerCase() === schema));
  return matches.find((t) => !schema && defaultSchema && t.schema.toLowerCase() === defaultSchema.toLowerCase()) ?? matches[0];
}

/** Tables referenced by a statement (FROM / JOIN / UPDATE / INTO, comma lists included), with aliases. */
export function referencedTables(statement: string, tables: CompletionTable[], defaultSchema?: string): TableRef[] {
  const out: TableRef[] = [];
  const add = (qualified: string, alias?: string) => {
    const table = findTable(tables, splitQualified(qualified), defaultSchema);
    if (!table) return;
    const a = alias && !NOT_ALIAS.has(alias.toLowerCase()) ? alias : table.name;
    if (!out.some((r) => r.table === table && r.alias.toLowerCase() === a.toLowerCase())) out.push({ table, alias: a });
  };
  const head = new RegExp(String.raw`\b(?:from|join|update|into|table)\s+(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENT}))?`, "gi");
  for (const m of statement.matchAll(head)) {
    add(m[1], m[2] && unquoteIdent(m[2]));
    // "FROM a x, b y": the comma list that follows the first table.
    if (/^from/i.test(m[0])) {
      let rest = statement.slice((m.index ?? 0) + m[0].length);
      const next = new RegExp(String.raw`^\s*,\s*(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENT}))?`, "i");
      for (let i = 0; i < 20; i++) {
        const n = next.exec(rest);
        if (!n) break;
        add(n[1], n[2] && unquoteIdent(n[2]));
        rest = rest.slice(n[0].length);
      }
    }
  }
  return out;
}

export type Expect = "table" | "column";

/** Whether the caret expects a table name (after FROM/JOIN/…) or columns/expressions. */
export function expectAt(textBefore: string): Expect {
  const words = [...textBefore.matchAll(/\b(select|from|join|where|and|or|on|by|set|having|into|update|table|values|returning|when|then|else|case|as)\b|,/gi)];
  const last = words[words.length - 1]?.[0]?.toLowerCase();
  // "INSERT INTO t (|": the column list of t.
  if (new RegExp(String.raw`\binto\s+${QUALIFIED}\s*\([^()]*$`, "i").test(textBefore)) return "column";
  if (last === "from" || last === "join" || last === "into" || last === "update" || last === "table") return "table";
  // "FROM a, |": still a table list when the last keyword before the comma was FROM.
  if (last === ",") {
    const kw = words.slice(0, -1).reverse().find((w) => w[0] !== ",")?.[0]?.toLowerCase();
    if (kw === "from") return "table";
  }
  return "column";
}

/** The identifier chain (a.b.c, quotes allowed) around `pos` in `text`. */
export function identifierAt(text: string, pos: number): { from: number; to: number; parts: string[] } | null {
  const isPart = (c: string | undefined) => !!c && /[\w$."`[\]]/.test(c);
  let from = pos;
  let to = pos;
  while (from > 0 && isPart(text[from - 1])) from--;
  while (to < text.length && isPart(text[to])) to++;
  const raw = text.slice(from, to);
  if (!raw || !/[A-Za-z_$"`[]/.test(raw)) return null;
  return { from, to, parts: splitQualified(raw) };
}

/**
 * The text with string literals and comments blanked out (same length and offsets, newlines kept), so that a
 * word or parenthesis inside them is not read as SQL. Quoted identifiers stay: they are table names.
 */
export function maskSql(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "-" && text[i + 1] === "-") {
      const j = text.indexOf("\n", i);
      blank(i, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j;
    } else if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      blank(i, j < 0 ? text.length : j + 2);
      i = j < 0 ? text.length : j + 2;
    } else if (c === "$" && !/[\w$]/.test(text[i - 1] ?? "") && /^\$(?:[A-Za-z_]\w*)?\$/.test(text.slice(i, i + 64))) {
      // PostgreSQL dollar quoting: $$ … $$ or $tag$ … $tag$.
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64))![0];
      const j = text.indexOf(tag, i + tag.length);
      blank(i + tag.length, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j + tag.length;
    } else if (c === '"' || c === "`" || c === "[") {
      // A quoted identifier: skipped whole, so a quote or parenthesis in it does not count.
      const j = text.indexOf(c === "[" ? "]" : c, i + 1);
      i = j < 0 ? text.length : j + 1;
    } else i++;
  }
  return out.join("");
}

/**
 * Tables in scope at `caret` (an offset into `statement`): those of the query the caret is in (inside a subquery its
 * own tables, without those of the subqueries nested in it), then those of the queries around it, which a correlated
 * subquery can use. Falls back to every table of the statement when the scope names none the catalog knows (a
 * derived table, a CTE).
 */
export function tablesInScope(statement: string, caret: number, tables: CompletionTable[], defaultSchema?: string): TableRef[] {
  const masked = maskSql(statement);
  // Parenthesised groups (an unclosed one runs to the end of the text) that hold a subquery.
  const stack: number[] = [];
  const pairs: { open: number; close: number }[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "(") stack.push(i);
    else if (masked[i] === ")" && stack.length) pairs.push({ open: stack.pop()!, close: i });
  }
  for (const open of stack) pairs.push({ open, close: masked.length });
  const groups = pairs.filter((p) => /^\s*(?:select|with)\b/i.test(masked.slice(p.open + 1, p.open + 64)));
  // Scopes around the caret, innermost first, ending with the whole statement.
  const scopes = groups
    .filter((g) => g.open < caret && caret <= g.close)
    .sort((a, b) => b.open - a.open)
    .map((g) => ({ from: g.open + 1, to: g.close }));
  scopes.push({ from: 0, to: masked.length });
  const out: TableRef[] = [];
  for (const scope of scopes) {
    const chars = masked.slice(scope.from, scope.to).split("");
    // Blank the subqueries nested in this scope: their tables are theirs.
    for (const g of groups) {
      if (g.open < scope.from || g.close > scope.to) continue;
      for (let k = g.open + 1; k < g.close; k++) if (chars[k - scope.from] !== "\n") chars[k - scope.from] = " ";
    }
    for (const ref of referencedTables(chars.join(""), tables, defaultSchema)) {
      if (!out.some((r) => r.table === ref.table && r.alias.toLowerCase() === ref.alias.toLowerCase())) out.push(ref);
    }
  }
  return out.length ? out : referencedTables(masked, tables, defaultSchema);
}

/**
 * How a completion label matches what was typed, case-insensitively: tier 0 the whole label, 1 its start, 2 the start
 * of a word in it ("id" in cliente_id), 3 anywhere (two letters or more); null when it does not match. `from`/`to`
 * is the matched part, for highlighting.
 */
export function matchTier(label: string, typed: string): { tier: number; from: number; to: number } | null {
  const l = label.toLowerCase();
  const t = typed.toLowerCase();
  if (!t) return { tier: 1, from: 0, to: 0 };
  if (l === t) return { tier: 0, from: 0, to: l.length };
  if (l.startsWith(t)) return { tier: 1, from: 0, to: t.length };
  if (t.length < 2) return null;
  for (let i = 1; i < l.length; i++) {
    const wordStart = !/[a-z0-9]/.test(l[i - 1]) || (/[a-z]/.test(label[i - 1]) && /[A-Z]/.test(label[i]));
    if (wordStart && l.startsWith(t, i)) return { tier: 2, from: i, to: i + t.length };
  }
  const at = l.indexOf(t);
  return at >= 0 ? { tier: 3, from: at, to: at + t.length } : null;
}

/**
 * Filters and orders completion options: by group (lower first: the query's columns before table names), then by
 * how well each matches what was typed, then in the order given. Each kept option comes with its matched part.
 */
export function rankOptions<T extends { label: string }>(options: { option: T; group: number }[], typed: string): { option: T; from: number; to: number }[] {
  return options
    .map((o, index) => ({ ...o, index, match: matchTier(o.option.label, typed) }))
    .filter((o) => o.match)
    .sort((a, b) => a.group - b.group || a.match!.tier - b.match!.tier || a.index - b.index)
    .map((o) => ({ option: o.option, from: o.match!.from, to: o.match!.to }));
}

/**
 * Splits the completion options in two: `first`, the group-0 options (the query's columns and aliases) that match
 * what was typed at its start or at a word start, ranked to go above keywords; and `rest`, everything else (group-0
 * options matching only in the middle, and the other groups), left to the editor's own fuzzy ranking, where a
 * keyword starting with what was typed (AND, OR) beats them.
 */
export function splitOptions<T extends { label: string }>(options: { option: T; group: number }[], typed: string): { first: { option: T; from: number; to: number }[]; rest: T[] } {
  const strong = (o: { option: T; group: number }) => o.group === 0 && (matchTier(o.option.label, typed)?.tier ?? 3) <= 2;
  return {
    first: rankOptions(options.filter(strong), typed),
    rest: options.filter((o) => !strong(o) && (o.group !== 0 || matchTier(o.option.label, typed))).map((o) => o.option),
  };
}
