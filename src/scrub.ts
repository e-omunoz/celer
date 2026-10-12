// The error log's scrubber for the browser side: the rules of src-tauri/src/errlog.rs, in the same order, checked
// against the same samples (dev/fixtures/scrub-samples.json, dev/errorlog-check.ts). In the desktop app the core
// scrubs every entry itself; this one serves the browser demo's log and the report window (user paths, #112).

type Rule = [RegExp, string];

const PATH_RULES: Rule[] = [
  [/\b([a-z]:[\\/]+(?:users|documents and settings)[\\/]+)[^\\/\s"';:]+/gi, "$1…"],
  [/(\/(?:home|Users)\/)[^/\s"';:]+/g, "$1…"],
];

const RULES: Rule[] = [
  [/Token error: '(.*)' on server \S+/g, "Token error: $1 on server …"],
  [/\bon server \S+/g, "on server …"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s'"<>]+/gi, "$1…"],
  [
    /\b(password|passwd|pwd|user ?id|uid|user(?:name)?|server|host(?:name)?|address|addr|data source|dsn|database|dbname|initial catalog|port|service|informixserver|api[_-]?key|token|secret)\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*'|[^;\s,)]*)/gi,
    "$1=…",
  ],
  [/\b(password|passwd|pwd|secret|token|api[_ -]?key)\s*:\s*[^\s;,)]+/gi, "$1: …"],
  [/^(\s*LINE \d+:).*$/gm, "$1 ‹SQL›"],
  [/^\s*\^\s*$\n?/gm, ""],
  [/near '.*' at line (\d+)/g, "near '…' at line $1"],
  [/\b(\w+n)'t\b/gi, "$1’t"],
  [/\b(server on|host|to) '[^'\n]*'/gi, "$1 '…'"],
  [/^[\w.-]+(: (?:host|no such host|name or service|nodename|unknown host|temporary failure))/gim, "‹host›$1"],
  [/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+){2,}\b(?::\d+)?/g, "‹host›"],
  [/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+:\d{2,5}\b/g, "‹host›"],
  [/\b(duplicate key value is|duplicate key row in object [^\n]*? with unique index [^\n]*?\. The duplicate key value is) \([^\n]*\)/gi, "$1 (…)"],
  [/\b(?:exec(?:ute)?\s+[\w.\[\]]+[^\n]*@\w[^\n]*|with\s+\w+(?:\s*\([^)\n]*\))?\s+as\s*\(?[^\n]*)/gi, "‹SQL›"],
  [
    /\b(?:select\b[^\n]*\bfrom\b|insert\s+into\b|update\b[^\n]*\bset\b|delete\s+from\b|merge\s+into\b|create\s+(?:or\s+replace\s+)?(?:table|view|index|procedure|function|trigger)\b|alter\s+table\b|drop\s+(?:table|view|index)\b|truncate\s+table\b)[^\n]*/gi,
    "‹SQL›",
  ],
  [/\([^()\n]*\)=\([^()\n]*\)/g, "(…)=(…)"],
  [/(row contains) \([^\n]*\)/gi, "$1 (…)"],
  [/'(?:[^'\n]|'')*'/g, "'…'"],
  [/"[^"\n]*"/g, '"…"'],
  [/`[^`\n]*`/g, "`…`"],
  [/«[^»\n]*»/g, "«…»"],
  [/\(([^()\s]*[a-z][^()\s]*)\)/gi, "(…)"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "‹ip›"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "‹email›"],
];

const apply = (text: string, rules: Rule[]) => rules.reduce((acc, [re, to]) => acc.replace(re, to), text);

function withoutUser(text: string, user?: string | null): string {
  if (!user || user.length < 3) return text;
  return text.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "‹usuario›");
}

/** A message without SQL text, values, secrets, connection strings, hosts or user paths. */
export function scrubText(text: string, user?: string | null): string {
  return withoutUser(apply(apply(text, PATH_RULES), RULES), user);
}

/** Only user folders (C:\Users\<name>, /home/<name>, /Users/<name>) and the user's name: for text the user wrote. */
export function scrubPaths(text: string, user?: string | null): string {
  return withoutUser(apply(text, PATH_RULES), user);
}

/** A stack keeps its frames: only user paths, the user's name and quoted text go. */
export function scrubStack(text: string, user?: string | null): string {
  // Up to the first frame, a JS stack is "Error: <message>": that part is a message and gets every rule.
  const m = /^\s+at |@\S+:\d+:\d+$/m.exec(text);
  const cut = m ? m.index : text.length;
  const quoted = RULES.filter((r) => r[1] === "'…'" || r[1] === '"…"');
  return withoutUser(scrubText(text.slice(0, cut)) + apply(apply(text.slice(cut), PATH_RULES), quoted), user);
}
