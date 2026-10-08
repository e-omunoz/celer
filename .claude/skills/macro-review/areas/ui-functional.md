# Area: interface behaviour (flows, keyboard, state)

Run the app as in `ui-visual.md` (browser preview for logic, desktop app for windows, dialogs and files).
Code: `src/App.tsx`, `src/state.ts`, `src/commands.ts`, `src/keymap.ts`, `src/windows.ts`, `src/windowModel.ts`,
`src/library*.ts`, `src/connTree.ts`, `src/connManage.ts`, `src/components/*`, `src/gib/*`.

## Flows to walk end to end
- Connect, open console, run statement / selection / script, cancel a long query, EXPLAIN, format, history.
- Grid: keyboard navigation, copy in every format, Ctrl+F, load more / load all, autofit, aggregates.
- Table viewer: filters, sort, edit cells/NULL, add/clone/delete rows, save atomically, error path rolls back.
- Export (every format, cancel, "show in folder") and import CSV/TSV/Excel/JSON (mapping, required columns, rollback).
- Explorer: tree keyboard nav, type-to-filter, context menus, rename/duplicate/delete with undo, folders, drag to editor.
- Command palette (Shift Shift, Ctrl+K, Ctrl+N, Ctrl+Shift+A) and every entry in `src/keymap.ts`; conflicts between
  shortcuts by focus (Ctrl+Shift+N in explorer vs grid vs elsewhere).
- Several windows: move tabs between windows keeping sessions, dock/undock panels, close a non-last window with
  unsaved work, quit and restore every window on next start, missing monitor.
- Library: folders, tags, search, run, unsaved-changes dot, import/export `.sql` round trip.
- AI assistant and "Copiar esquema para IA" (no row data ever sent), settings persistence, theme switch live.
- Updates dialog (no download before «Actualizar»).

## Look for
Actions that silently do nothing; stale UI after an action (counts, dots, tab titles); state lost on window move or
restart; double execution; focus lost after dialogs; shortcuts that fire in the wrong focus or in text inputs;
unhandled promise rejections and console errors; memory/timer leaks (intervals not cleared, listeners not removed in
`onCleanup`); race conditions between async loads and tab switches; behaviour that contradicts `docs/GUIA.md`.
