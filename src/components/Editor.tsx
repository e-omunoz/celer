import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, MSSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { createEffect, onCleanup, onMount } from "solid-js";
import type { DbKind } from "../types";

const language = new Compartment();
const theme = new Compartment();

const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.name), tags.typeName], color: "var(--syntax-function)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.special(tags.variableName), color: "var(--syntax-param)" },
  { tag: [tags.className, tags.namespace], color: "var(--syntax-table)" },
  { tag: tags.name, color: "var(--text)" },
]);

function dialectOf(kind: DbKind) {
  if (kind === "mssql") return MSSQL;
  if (kind === "sqlite") return SQLite;
  return StandardSQL;
}

export function SqlEditor(props: {
  doc: string;
  revision: number;
  kind: DbKind;
  schema: Record<string, string[]>;
  fontSize: number;
  onDoc: (sql: string, cursor: number) => void;
  onRun: () => void;
  onRunAll: () => void;
  onCancel: () => void;
}) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let applying = false;
  let schemaKey = "";
  let seenKind = props.kind;
  let seenFont = props.fontSize;

  function themeExtension() {
    return EditorView.theme({
      "&": { height: "100%", fontSize: `${props.fontSize}px`, background: "transparent", color: "var(--fg)" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
      ".cm-gutters": { background: "transparent", border: "none", color: "var(--muted)" },
      ".cm-activeLine, .cm-activeLineGutter": { background: "var(--accent-soft)" },
      "&.cm-focused": { outline: "none" },
      ".cm-content, .cm-line": { caretColor: "var(--accent)", color: "var(--fg)" },
    });
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.doc,
        extensions: [
          history(),
          syntaxHighlighting(sqlHighlight),
          EditorView.lineWrapping,
          language.of(sql({ dialect: dialectOf(props.kind), schema: props.schema, upperCaseKeywords: true })),
          theme.of(themeExtension()),
          keymap.of([
            { key: "Ctrl-Enter", mac: "Cmd-Enter", preventDefault: true, run: () => { props.onRun(); return true; } },
            { key: "Mod-Shift-Enter", preventDefault: true, run: () => { props.onRunAll(); return true; } },
            { key: "Alt-x", preventDefault: true, run: () => { props.onRunAll(); return true; } },
            { key: "Escape", run: () => { props.onCancel(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (applying || (!update.docChanged && !update.selectionSet)) return;
            props.onDoc(update.state.doc.toString(), update.state.selection.main.head);
          }),
        ],
      }),
    });
  });

  onCleanup(() => view?.destroy());

  createEffect(() => {
    const doc = props.doc;
    const revision = props.revision;
    const kind = props.kind;
    const key = JSON.stringify(props.schema);
    const fontSize = props.fontSize;
    if (!view) return;
    if (revision > 0 && view.state.doc.toString() !== doc) {
      applying = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
      applying = false;
    }
    const effects = [];
    if (key !== schemaKey || kind !== seenKind) {
      schemaKey = key;
      seenKind = kind;
      effects.push(language.reconfigure(sql({ dialect: dialectOf(kind), schema: props.schema, upperCaseKeywords: true })));
    }
    if (fontSize !== seenFont) {
      seenFont = fontSize;
      effects.push(theme.reconfigure(themeExtension()));
    }
    if (effects.length) view.dispatch({ effects });
  });

  return <div class="editor" ref={host} />;
}
