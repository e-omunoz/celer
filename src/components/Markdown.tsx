import { For, Match, Switch, type JSX } from "solid-js";

type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "para"; text: string }
  | { type: "rule" };

/** A horizontal rule: `---`, `***` or `___` (spaces between allowed). Before lists, so `- - -` is a rule. */
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** Splits Markdown into blocks. Handles what assistant answers and release notes use: fences, headings, lists, rules, paragraphs. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[1].toLowerCase(), text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !RULE.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "");
        i++;
        // Indented lines that are not items themselves continue the item (wrapped changelog entries).
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !RULE.test(lines[i])) para.push(lines[i++]);
    blocks.push({ type: "para", text: para.join(" ") });
  }
  return blocks;
}

/** Inline formatting: `code`, **bold**, _italic_ / *italic*. Rendered as elements, never as HTML. */
export function Inline(props: { text: string }) {
  const parts = () => props.text.split(/(`[^`]+`|\*\*[^*]+\*\*|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_]+_(?!\w))/g).filter(Boolean);
  return (
    <For each={parts()}>
      {(part) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code>{part.slice(1, -1)}</code>;
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong>{part.slice(2, -2)}</strong>;
        if ((part.startsWith("_") && part.endsWith("_")) || (part.startsWith("*") && part.endsWith("*") && part.length > 2)) return <em>{part.slice(1, -1)}</em>;
        return <>{part}</>;
      }}
    </For>
  );
}

export function Markdown(props: { text: string; code?: (block: { lang: string; text: string }) => JSX.Element }) {
  return (
    <div class="md">
      <For each={parseBlocks(props.text)}>
        {(block) => (
          <Switch>
            <Match when={block.type === "code"}>
              {props.code ? props.code(block as { lang: string; text: string }) : <pre class="md-code">{(block as { text: string }).text}</pre>}
            </Match>
            <Match when={block.type === "heading"}>
              <p class="md-h"><Inline text={(block as { text: string }).text} /></p>
            </Match>
            <Match when={block.type === "list" && (block as { ordered: boolean }).ordered}>
              <ol>
                <For each={(block as { items: string[] }).items}>{(item) => <li><Inline text={item} /></li>}</For>
              </ol>
            </Match>
            <Match when={block.type === "list"}>
              <ul>
                <For each={(block as { items: string[] }).items}>{(item) => <li><Inline text={item} /></li>}</For>
              </ul>
            </Match>
            <Match when={block.type === "para"}>
              <p><Inline text={(block as { text: string }).text} /></p>
            </Match>
            <Match when={block.type === "rule"}>
              <hr />
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
