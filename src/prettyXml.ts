// XML values (SQL Server xml columns, PostgreSQL xml, SOAP payloads kept in text) indented for reading. Pure,
// without a DOM: dev/prettyxml-check.ts tests it. Anything that is not well-formed XML gives null (shown as is).

const TOKEN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]*>|[^<]+/g;

/** `text` indented two spaces per level, or null when it is not a well-formed XML document or fragment. */
export function prettyXml(text: string): string | null {
  const src = text.trim();
  if (!src.startsWith("<") || !src.endsWith(">") || src.length > 2_000_000) return null;
  const tokens = src.match(TOKEN) ?? [];
  if (tokens.join("") !== src) return null;
  const lines: string[] = [];
  const open: string[] = [];
  let elements = 0;
  const pad = () => "  ".repeat(open.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("<![CDATA[") || token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) {
      lines.push(pad() + token);
      continue;
    }
    if (token.startsWith("</")) {
      const name = /^<\/\s*([^\s>]+)\s*>$/.exec(token)?.[1];
      if (!name || open.pop() !== name) return null;
      lines.push(pad() + token);
      continue;
    }
    if (token.startsWith("<")) {
      const name = /^<([^\s/>]+)/.exec(token)?.[1];
      if (!name || !/^[\p{L}_:][\p{L}\p{N}_:.-]*$/u.test(name)) return null;
      elements++;
      if (token.endsWith("/>")) {
        lines.push(pad() + token);
        continue;
      }
      // <a>short text</a> stays on one line.
      const next = tokens[i + 1];
      const close = tokens[i + 2];
      if (next !== undefined && !next.startsWith("<") && close !== undefined && /^<\/\s*([^\s>]+)\s*>$/.exec(close)?.[1] === name) {
        lines.push(pad() + token + next.trim() + close);
        i += 2;
        continue;
      }
      lines.push(pad() + token);
      open.push(name);
      continue;
    }
    // Text between tags: kept (trimmed); whitespace-only text is layout and goes.
    const content = token.trim();
    if (content) lines.push(pad() + content);
  }
  if (open.length || !elements) return null;
  return lines.join("\n");
}
