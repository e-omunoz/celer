// Light SQL analysis for the editor: which tables a statement uses (with aliases), what kind of name is
// expected at the caret, and which table an identifier refers to. Used by completion and Ctrl+click.
import type { CompletionTable } from "./types";

export interface TableRef {
  table: CompletionTable;
  /** Alias written in the statement (or the table name when there is none). */
  alias: string;
}

const IDENT = String.raw`(?:[A-Za-z_$][\w$]*|"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\])`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;
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
