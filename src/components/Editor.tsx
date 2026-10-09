import {
  acceptCompletion,
  autocompletion,
  snippetCompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { copyLineDown, defaultKeymap, deleteLine, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp, toggleComment } from "@codemirror/commands";
import { MariaSQL, MSSQL, MySQL, PostgreSQL, sql, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { createEffect, on, onCleanup, onMount, untrack } from "solid-js";
import { chordsFor, codeMirrorKey } from "../keymap";
import { splitSql } from "../sql";
import { unfilteredWrites, type Snippet } from "../snippets";
import { compatibility, guessEngines } from "../engineCompat";
import { expectAt, findTable, identifierAt, referencedTables, splitQualified, type TableRef } from "../sqlContext";
import type { CompletionTable, DbKind } from "../types";

const language = new Compartment();
const theme = new Compartment();
const userKeys = new Compartment();

const sqlHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--syntax-keyword)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.name), tags.standard(tags.name)], color: "var(--syntax-function)" },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: "var(--syntax-type)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.special(tags.variableName), tags.variableName], color: "var(--syntax-param)" },
  { tag: [tags.className, tags.namespace, tags.propertyName], color: "var(--syntax-table)" },
  { tag: tags.special(tags.name), color: "var(--syntax-table)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--syntax-punct)" },
  { tag: tags.name, color: "var(--text)" },
]);

function dialectOf(kind: DbKind) {
  if (kind === "postgres") return PostgreSQL;
  if (kind === "mysql") return MySQL;
  if (kind === "mssql") return MSSQL;
  if (kind === "sqlite") return SQLite;
  if (kind === "informix") return StandardSQL;
  return StandardSQL;
}
void MariaSQL;

/**
 * Paints a soft band behind the statement under the cursor, like DataGrip. The split is kept while only the cursor
 * moves, and very long scripts (a dump) get no band, as with unfilteredWarning.
 */
const statementBand = (dialect: () => string) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    split: { doc: EditorState["doc"]; dialect: string; text: string; parts: ReturnType<typeof splitSql> } | null = null;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      if (doc.length > 200_000) {
        this.split = null;
        return builder.finish();
      }
      if (this.split?.doc !== doc || this.split.dialect !== dialect()) {
        const text = doc.toString();
        this.split = { doc, dialect: dialect(), text, parts: splitSql(text, dialect()) };
      }
      const { text, parts } = this.split;
      if (parts.length < 2) return builder.finish();
      const head = view.state.selection.main.head;
      let chosen = parts[0];
      for (const part of parts) {
        if (head < part.start) break;
        chosen = part;
        if (head <= part.end + 1) break;
      }
      const startOffset = chosen.start + (text.slice(chosen.start, chosen.end).length - text.slice(chosen.start, chosen.end).trimStart().length);
      const from = doc.lineAt(startOffset).number;
      const to = doc.lineAt(Math.min(doc.length, chosen.start + text.slice(chosen.start, chosen.end).trimEnd().length)).number;
      for (let line = from; line <= to; line++) {
        const l = doc.line(line);
        builder.add(l.from, l.from, Decoration.line({ class: line === from ? "cm-stmt cm-stmt-first" : line === to ? "cm-stmt cm-stmt-last" : "cm-stmt" }));
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * DELETE / UPDATE without WHERE: the keyword gets a wavy underline and a tooltip, before anything runs.
 * Skipped on very long scripts (the check walks the whole text).
 */
const unfilteredWarning = (dialect: () => string) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    dialect = "";
    update(update: ViewUpdate) {
      // Also when the console switches engine (quoting and comments differ).
      if (update.docChanged || dialect() !== this.dialect) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      this.dialect = dialect();
      const text = view.state.doc.toString();
      if (text.length > 200_000) return Decoration.none;
      const builder = new RangeSetBuilder<Decoration>();
      for (const w of unfilteredWrites(text, dialect())) {
        builder.add(w.from, w.to, Decoration.mark({ class: "cm-unfiltered", attributes: { title: `${w.keyword} sin WHERE: afectará a todas las filas de la tabla` } }));
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Live templates: typing a template's name (sel, ins, upd…) offers it at the top of the completion list;
 * Tab or Enter expands it, then Tab moves between its fields.
 */
function snippetSource(get: () => { snippets: Snippet[]; dialect: string }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[A-Za-z_][\w]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;
    // Not after a dot (that is a column or table name), nor where a table name goes (FROM cte⏎ is a table).
    if (ctx.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    // Right after FROM / JOIN / INTO / UPDATE (or "FROM a,") a table name goes: no templates there. After the
    // table and its alias ("FROM orders o⏎lj") they are welcome.
    const text = ctx.state.doc.toString();
    const stmt = statementAround(text, ctx.pos, get().dialect);
    const before = text.slice(stmt.start, word.from);
    if (/\b(from|join|into|update)\s+$/i.test(before) || /\bfrom\b[^;()]*,\s*$/i.test(before)) return null;
    const typed = word.text.toLowerCase();
    const options = get()
      .snippets.filter((s) => s.name.toLowerCase().startsWith(typed))
      .map((s) => {
        // A template for another engine is still offered, marked and below the others.
        const other = compatibility(guessEngines(s.body, { override: s.engine }), get().dialect as DbKind) === "warn";
        return snippetCompletion(s.body, {
          label: s.name,
          detail: `plantilla · ${s.description}${other ? " · otro motor" : ""}`,
          type: "text",
          boost: (s.name.toLowerCase() === typed ? 20 : 4) - (other ? 10 : 0),
        });
      });
    return options.length ? { from: word.from, options, validFor: /^[\w]*$/ } : null;
  };
}

/** The statement (text and start offset) that contains `pos`. */
function statementAround(text: string, pos: number, dialect: string) {
  const parts = splitSql(text, dialect);
  let chosen = parts[0] ?? { sql: text, start: 0, end: text.length };
  for (const part of parts) {
    if (pos < part.start) break;
    chosen = part;
    if (pos <= part.end + 1) break;
  }
  return { start: chosen.start, text: text.slice(chosen.start, Math.max(chosen.end, pos)) };
}

const quoteIfNeeded = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/**
 * Context-aware completion over the real catalog (replaces lang-sql's schema completion, which only offers
 * columns after "table."): tables after FROM/JOIN/UPDATE/INTO, the statement's columns everywhere else,
 * alias./table. → that table's columns, schema. → its tables. Ranked above keywords and functions.
 */
function catalogCompletion(get: () => { tables: CompletionTable[]; defaultSchema?: string; dialect: string }) {
  const source = catalogSource(get);
  return (ctx: CompletionContext): CompletionResult | null => {
    try {
      return source(ctx);
    } catch (err) {
      console.error("catalog completion failed", err);
      return null;
    }
  };
}

function catalogSource(get: () => { tables: CompletionTable[]; defaultSchema?: string; dialect: string }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { tables, defaultSchema, dialect } = get();
    if (!tables.length) return null;
    const word = ctx.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !ctx.explicit && ctx.state.sliceDoc(word.from - 1, word.from) !== ".")) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;
    const text = ctx.state.doc.toString();
    const stmt = statementAround(text, ctx.pos, dialect);
    const refs = referencedTables(stmt.text, tables, defaultSchema);
    const before = text.slice(stmt.start, word.from);
    const cols = (ref: TableRef, boost: number): Completion[] =>
      ref.table.columns.map((col) => ({ label: col, type: "property", detail: ref.alias, boost, apply: quoteIfNeeded(col) }));
    const tableOption = (t: CompletionTable, boost: number): Completion => ({
      label: t.name,
      type: "class",
      detail: t.schema || undefined,
      boost,
      apply: !t.schema || !defaultSchema || t.schema.toLowerCase() === defaultSchema.toLowerCase() ? quoteIfNeeded(t.name) : `${quoteIfNeeded(t.schema)}.${quoteIfNeeded(t.name)}`,
    });

    // Qualified: "x." → columns of alias/table x, or the tables of schema x.
    const qualifier = /((?:[A-Za-z_$][\w$]*|"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]))\s*\.\s*$/.exec(before);
    if (qualifier) {
      const q = splitQualified(qualifier[1])[0]?.toLowerCase() ?? "";
      const ref = refs.find((r) => r.alias.toLowerCase() === q) ?? refs.find((r) => r.table.name.toLowerCase() === q);
      const table = ref?.table ?? findTable(tables, [q], defaultSchema);
      if (table) return { from: word.from, options: cols(ref ?? { table, alias: table.name }, 10), validFor: /^[\w$]*$/ };
      const inSchema = tables.filter((t) => t.schema.toLowerCase() === q);
      if (inSchema.length) return { from: word.from, options: inSchema.map((t) => ({ ...tableOption(t, 10), apply: quoteIfNeeded(t.name) })), validFor: /^[\w$]*$/ };
      return null;
    }

    if (expectAt(before) === "table") {
      const schemas = [...new Set(tables.map((t) => t.schema).filter(Boolean))];
      return {
        from: word.from,
        options: [
          ...tables.map((t) => tableOption(t, 6)),
          ...schemas.map((s) => ({ label: s, type: "namespace", boost: 1, apply: quoteIfNeeded(s) })),
        ],
        validFor: /^[\w$]*$/,
      };
    }

    const options: Completion[] = [];
    if (refs.length) {
      refs.forEach((ref, i) => options.push(...cols(ref, 8 - Math.min(i, 3))));
      refs.forEach((ref) => ref.alias !== ref.table.name && options.push({ label: ref.alias, type: "variable", detail: ref.table.name, boost: 5 }));
    } else {
      // No FROM yet (e.g. "SELECT |"): every column of the catalog when it is a reasonable list.
      const total = tables.reduce((n, t) => n + t.columns.length, 0);
      if (total <= 3000) tables.forEach((t) => options.push(...cols({ table: t, alias: t.name }, 2)));
    }
    tables.forEach((t) => options.push(tableOption(t, 1)));
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}

/** Ctrl/Cmd + hover over a table name: underline it like a link (Ctrl+click opens it). */
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLink)) value = e.value ? Decoration.set([Decoration.mark({ class: "cm-table-link" }).range(e.value.from, e.value.to)]) : Decoration.none;
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function SqlEditor(props: {
  doc: string;
  revision: number;
  kind: DbKind;
  /** Catalog for completion and Ctrl+click (tables with their columns). */
  tables: CompletionTable[];
  /** Live templates offered by name (built-in and the user's). */
  snippets?: Snippet[];
  defaultSchema?: string;
  /** Ctrl+click / F4 / Ctrl+B on a table (or an alias of one) in the SQL. */
  onOpenTable?: (table: CompletionTable) => void;
  /** Where to put the caret after an external text change. */
  cursor?: number;
  fontSize: number;
  onDoc: (sql: string, cursor: number, selection: string) => void;
  onCursor?: (line: number, col: number) => void;
  onRun: () => void;
  onRunAll: () => void;
  onExplain: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onReady?: (view: EditorView) => void;
  /** The user's shortcuts (settings.keymap): run, run script, plan and format follow them. */
  keymap?: Record<string, string[]>;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let applying = false;

  /** The editor's commands on their shortcuts (defaults or the user's). */
  function commandKeys(): Extension {
    const bind = (id: string, run: () => void) => chordsFor(id, props.keymap).map((chord) => ({ key: codeMirrorKey(chord), preventDefault: true, run: () => (run(), true) }));
    return keymap.of([...bind("run", props.onRun), ...bind("run-script", props.onRunAll), ...bind("explain", props.onExplain), ...bind("format", props.onFormat)]);
  }

  function themeExtension(): Extension {
    return EditorView.theme({
      "&": { height: "100%", fontSize: `${props.fontSize}px`, background: "var(--editor-bg)", color: "var(--text)" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
      ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
      ".cm-gutters": { background: "var(--editor-bg)", border: "none", color: "var(--text-faint)", paddingLeft: "6px" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "32px", fontSize: "0.9em" },
      ".cm-activeLineGutter": { background: "transparent", color: "var(--text)" },
      ".cm-foldGutter .cm-gutterElement": { color: "var(--text-faint)", cursor: "pointer", padding: "0 4px" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "var(--editor-selection) !important" },
      ".cm-selectionMatch": { background: "var(--editor-match)" },
      ".cm-matchingBracket": { background: "var(--editor-match)", outline: "1px solid var(--border-strong)", color: "inherit" },
      ".cm-searchMatch": { background: "var(--grid-match)", outline: "1px solid var(--warning)" },
      ".cm-searchMatch.cm-searchMatch-selected": { background: "var(--editor-selection)" },
      ".cm-tooltip": { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: "8px", boxShadow: "var(--shadow-lg)", overflow: "hidden" },
      ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12.5px", maxHeight: "18em", padding: "4px" },
      ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", borderRadius: "5px", lineHeight: "1.5" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--selection)", color: "var(--text)" },
      ".cm-completionDetail": { color: "var(--text-faint)", fontStyle: "normal", marginLeft: "8px" },
      ".cm-completionIcon": { opacity: "0.75", width: "1.2em" },
      ".cm-stmt": { background: "var(--editor-stmt)" },
      ".cm-table-link": { textDecoration: "underline", textUnderlineOffset: "3px", color: "var(--accent)", cursor: "pointer" },
      ".cm-unfiltered": { textDecoration: "underline wavy var(--warning)", textUnderlineOffset: "3px", textDecorationSkipInk: "none" },
    });
  }

  // Keywords and functions come from lang-sql; tables and columns from catalogCompletion (always current).
  function languageExtension() {
    return sql({ dialect: dialectOf(props.kind), upperCaseKeywords: true });
  }

  /** The catalog table an identifier at `pos` refers to: schema.table, table, or an alias of the statement. */
  function tableAt(state: EditorState, pos: number): { table: CompletionTable; from: number; to: number } | null {
    const text = state.doc.toString();
    const ident = identifierAt(text, pos);
    if (!ident || !props.tables.length) return null;
    const stmt = statementAround(text, pos, props.kind);
    const refs = referencedTables(stmt.text, props.tables, props.defaultSchema);
    const [first] = ident.parts;
    const byAlias = (name: string) => refs.find((r) => r.alias.toLowerCase() === name.toLowerCase())?.table;
    const table =
      findTable(props.tables, ident.parts, props.defaultSchema) ??
      (ident.parts.length === 1 ? byAlias(first) : byAlias(first) ?? findTable(props.tables, ident.parts.slice(0, -1), props.defaultSchema));
    return table ? { table, from: ident.from, to: ident.to } : null;
  }

  function openTableAt(state: EditorState, pos: number) {
    const hit = tableAt(state, pos);
    if (!hit || !props.onOpenTable) return false;
    props.onOpenTable(hit.table);
    return true;
  }

  const completionSource = catalogCompletion(() => ({ tables: props.tables, defaultSchema: props.defaultSchema, dialect: props.kind }));
  const templates = snippetSource(() => ({ snippets: props.snippets ?? [], dialect: props.kind }));

  let linked: { from: number; to: number } | null = null;
  function setLinked(v: EditorView, next: { from: number; to: number } | null) {
    if (linked?.from === next?.from && linked?.to === next?.to) return;
    linked = next;
    v.dispatch({ effects: setLink.of(next) });
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.doc,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          foldGutter({ openText: "⌄", closedText: "›" }),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          spanishPhrases,
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: true, defaultKeymap: true, maxRenderedOptions: 80 }),
          rectangularSelection(),
          crosshairCursor(),
          highlightSelectionMatches(),
          syntaxHighlighting(sqlHighlight),
          statementBand(() => props.kind),
          language.of(languageExtension()),
          // One stable source: CodeMirror matches results to sources by identity (a new function per call
          // would leave every result "pending" and never shown).
          EditorState.languageData.of(() => [{ autocomplete: completionSource }, { autocomplete: templates }]),
          unfilteredWarning(() => props.kind),
          linkField,
          theme.of(themeExtension()),
          panelTheme,
          // Before the built-in bindings: a user's shortcut wins over the editor's own (not over the completion
          // list's keys, which CodeMirror puts above everything).
          userKeys.of(commandKeys()),
          keymap.of([
            // Go to the table under the caret (DataGrip: F4 / Ctrl+B).
            { key: "F4", preventDefault: true, run: (v) => openTableAt(v.state, v.state.selection.main.head) },
            { key: "Mod-b", preventDefault: true, run: (v) => openTableAt(v.state, v.state.selection.main.head) },
            { key: "Mod-/", run: toggleComment },
            { key: "Mod-d", run: copyLineDown, preventDefault: true },
            { key: "Mod-y", run: deleteLine, preventDefault: true },
            { key: "Mod-Shift-ArrowUp", run: moveLineUp },
            { key: "Mod-Shift-ArrowDown", run: moveLineDown },
            { key: "Tab", run: acceptCompletion },
            ...closeBracketsKeymap,
            ...completionKeymap,
            // Ctrl+Shift+L is "Nueva consola" in Celer (DataGrip), not select-all-matches.
            ...searchKeymap.filter((binding) => binding.key !== "Mod-Shift-l"),
            ...foldKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              props.onCursor?.(line.number, head - line.from + 1);
            }
            if (applying || (!update.docChanged && !update.selectionSet)) return;
            const main = update.state.selection.main;
            props.onDoc(update.state.doc.toString(), main.head, main.empty ? "" : update.state.sliceDoc(main.from, main.to));
          }),
          EditorView.domEventHandlers({
            focus: (_event, v) => {
              const head = v.state.selection.main.head;
              const line = v.state.doc.lineAt(head);
              props.onCursor?.(line.number, head - line.from + 1);
            },
            // Ctrl/Cmd+click on a table name or alias opens the table.
            mousedown: (event, v) => {
              if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null || !openTableAt(v.state, pos)) return false;
              event.preventDefault();
              setLinked(v, null);
              return true;
            },
            mousemove: (event, v) => {
              if (!(event.ctrlKey || event.metaKey)) return setLinked(v, null);
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              const hit = pos === null ? null : tableAt(v.state, pos);
              setLinked(v, hit ? { from: hit.from, to: hit.to } : null);
            },
            mouseleave: (_event, v) => setLinked(v, null),
            keyup: (event, v) => {
              if (event.key === "Control" || event.key === "Meta") setLinked(v, null);
            },
          }),
        ],
      }),
    });
    props.onReady?.(view);
    requestAnimationFrame(() => view?.focus());
  });

  onCleanup(() => view?.destroy());

  // External text changes (format, history, AI, open file) always bump `revision`; typing does not, so the
  // document is never compared or copied on each keystroke.
  createEffect(
    on(
      () => props.revision,
      (revision) => {
        if (!view || revision === 0) return;
        const doc = untrack(() => props.doc);
        if (view.state.doc.toString() === doc) return;
        applying = true;
        const wanted = untrack(() => props.cursor);
        const head = Math.min(wanted ?? view.state.selection.main.head, doc.length);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: head }, scrollIntoView: true });
        applying = false;
      },
      { defer: true },
    ),
  );

  // Completion schema and dialect: reconfigure only when they actually change (compared by reference).
  createEffect(
    on(
      () => props.kind,
      () => view?.dispatch({ effects: language.reconfigure(languageExtension()) }),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.fontSize,
      () => view?.dispatch({ effects: theme.reconfigure(themeExtension()) }),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => JSON.stringify(props.keymap ?? {}),
      () => view?.dispatch({ effects: userKeys.reconfigure(commandKeys()) }),
      { defer: true },
    ),
  );
  return <div class="editor" ref={host} />;
}

/** CodeMirror's own texts (find/replace panel, folding, go to line) in Spanish, like the rest of the UI. */
const spanishPhrases = EditorState.phrases.of({
  Find: "Buscar",
  Replace: "Reemplazar",
  next: "siguiente",
  previous: "anterior",
  all: "todos",
  "match case": "mayúsculas",
  regexp: "regexp",
  "by word": "palabra completa",
  replace: "reemplazar",
  "replace all": "reemplazar todo",
  close: "cerrar",
  "current match": "coincidencia actual",
  "replaced $ matches": "$ coincidencias reemplazadas",
  "replaced match on line $": "coincidencia reemplazada en la línea $",
  "on line": "en la línea",
  "Go to line": "Ir a la línea",
  go: "ir",
  "Folded lines": "Líneas plegadas",
  "Unfold line": "Desplegar línea",
  "Fold line": "Plegar línea",
  unfold: "desplegar",
  "Control character": "Carácter de control",
  Completions: "Sugerencias",
});

/**
 * The find/replace panel (Ctrl+F / Ctrl+H) in Celer's look, in every theme. CodeMirror's base theme stacks panels at
 * z-index 300 and tooltips at 500, over the scrim (60) and the dialogs: here they stay above the editor, the grid and
 * the status bar, but under every dialog and menu. Selectors repeat the base theme's (`.cm-panel.cm-search …`) so
 * these win over it.
 */
const panelTheme = EditorView.theme({
  ".cm-panels": { background: "var(--panel)", color: "var(--text)", zIndex: "1" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip": { zIndex: "50" },
  ".cm-panel.cm-search": { padding: "5px 40px 5px 8px", fontFamily: "var(--sans)", fontSize: "12px", lineHeight: "1" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { margin: "2px 6px 2px 0", verticalAlign: "middle" },
  ".cm-panel.cm-search .cm-textfield": {
    width: "220px", height: "26px", padding: "0 8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-strong)",
    background: "var(--surface)", color: "var(--text)", fontFamily: "var(--sans)", fontSize: "12.5px",
    transition: "border-color var(--dur-fast), box-shadow var(--dur-fast)",
  },
  ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-search .cm-textfield:focus-visible": { outline: "none", borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" },
  ".cm-panel.cm-search .cm-textfield::placeholder": { color: "var(--text-faint)" },
  ".cm-panel.cm-search .cm-button": {
    height: "26px", padding: "0 10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-strong)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--sans)", fontSize: "12px", fontWeight: "500", cursor: "pointer", transition: "background var(--dur-fast)",
  },
  ".cm-panel.cm-search .cm-button:hover": { background: "color-mix(in srgb, var(--text) 5%, var(--surface))" },
  ".cm-panel.cm-search .cm-button:active": { backgroundImage: "none", transform: "translateY(0.5px)" },
  // mayúsculas / regexp / palabra completa: toggles that light up in the accent colour when on.
  ".cm-panel.cm-search label": {
    display: "inline-flex", alignItems: "center", gap: "5px", height: "26px", padding: "0 8px", borderRadius: "var(--radius-sm)",
    border: "1px solid transparent", color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none",
    transition: "background var(--dur-fast), color var(--dur-fast)",
  },
  ".cm-panel.cm-search label:hover": { background: "var(--hover)", color: "var(--text)" },
  ".cm-panel.cm-search label:has(input:checked)": { background: "var(--accent-soft)", borderColor: "color-mix(in srgb, var(--accent) 35%, transparent)", color: "var(--accent-text)" },
  ".cm-panel.cm-search input[type=checkbox]": { width: "13px", height: "13px", margin: "0", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-panel.cm-search [name=close]": {
    top: "6px", right: "8px", width: "24px", height: "24px", margin: "0", display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)",
    color: "var(--text-muted)", fontSize: "17px", lineHeight: "1", cursor: "pointer", transition: "background var(--dur-fast), color var(--dur-fast)",
  },
  ".cm-panel.cm-search [name=close]:hover": { background: "var(--hover)", color: "var(--text)" },
});

/** Read-only, syntax-highlighted SQL (DDL, definitions). */
export function CodeView(props: { doc: string; kind: DbKind }) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.doc,
        extensions: [
          lineNumbers(),
          foldGutter({ openText: "⌄", closedText: "›" }),
          highlightSelectionMatches(),
          syntaxHighlighting(sqlHighlight),
          sql({ dialect: dialectOf(props.kind) }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          spanishPhrases,
          panelTheme,
          keymap.of([...searchKeymap, ...defaultKeymap]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px", background: "var(--editor-bg)", color: "var(--text)" },
            ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
            ".cm-content": { padding: "10px 0" },
            ".cm-gutters": { background: "var(--editor-bg)", border: "none", color: "var(--text-faint)", paddingLeft: "6px" },
            "&.cm-focused": { outline: "none" },
            ".cm-selectionBackground, ::selection": { background: "var(--editor-selection) !important" },
          }),
        ],
      }),
    });
  });
  createEffect(() => {
    const doc = props.doc;
    if (view && view.state.doc.toString() !== doc) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  });
  onCleanup(() => view?.destroy());
  return <div class="editor code-view" ref={host} />;
}
