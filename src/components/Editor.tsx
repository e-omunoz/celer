import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { copyLineDown, defaultKeymap, deleteLine, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp, toggleComment } from "@codemirror/commands";
import { MariaSQL, MSSQL, MySQL, PostgreSQL, sql, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
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
import { splitSql } from "../sql";
import type { DbKind } from "../types";

const language = new Compartment();
const theme = new Compartment();

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

/** Paints a soft band behind the statement under the cursor, like DataGrip. */
const statementBand = (dialect: () => string) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      const text = doc.toString();
      const parts = splitSql(text, dialect());
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

export function SqlEditor(props: {
  doc: string;
  revision: number;
  kind: DbKind;
  schema: Record<string, string[]>;
  defaultSchema?: string;
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
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let applying = false;

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
      ".cm-panels": { background: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "var(--sans)", fontSize: "12px" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "var(--sans)", fontSize: "12px", borderRadius: "5px", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", padding: "2px 6px" },
      ".cm-panel.cm-search label": { fontSize: "12px" },
      ".cm-stmt": { background: "var(--editor-stmt)" },
    });
  }

  function languageExtension() {
    return sql({ dialect: dialectOf(props.kind), schema: props.schema, defaultSchema: props.defaultSchema, upperCaseKeywords: true });
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
          theme.of(themeExtension()),
          keymap.of([
            { key: "Mod-Enter", preventDefault: true, run: () => { props.onRun(); return true; } },
            { key: "Mod-Shift-Enter", preventDefault: true, run: () => { props.onRunAll(); return true; } },
            { key: "Alt-x", preventDefault: true, run: () => { props.onRunAll(); return true; } },
            { key: "Mod-Shift-e", preventDefault: true, run: () => { props.onExplain(); return true; } },
            { key: "Mod-F2", preventDefault: true, run: () => { props.onCancel(); return true; } },
            { key: "Mod-Alt-l", preventDefault: true, run: () => { props.onFormat(); return true; } },
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
      () => [props.schema, props.kind, props.defaultSchema] as const,
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
  return <div class="editor" ref={host} />;
}

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
