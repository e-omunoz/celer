# Area: frontend state and performance

Code: `src/state.ts`, `src/windows.ts`, `src/windowModel.ts`, `src/api.ts`, `src/types.ts`, `src/library*.ts`,
`src/components/Workspace.tsx`, the grid and explorer components, `src/gib/*`; checks `dev/windows-check.ts`,
`dev/library-check.ts`, `dev/perf-check.mjs`, `dev/perf-probe.mjs`.

## Look for
- Solid reactivity bugs: reading signals outside tracking scope, effects that never re-run or loop, stores mutated
  without `produce`/setters, `createResource` races (an old response overwriting a newer tab's state).
- Missing `onCleanup` for timers, event listeners, Tauri `listen()` unlisten functions, ResizeObservers.
- Per-window vs shared state: settings/library/connections written by two windows at once; layout file version 2
  migration; tabs handed between windows keep their session id.
- Performance: grid with 1M rows and 300 columns (scroll FPS, memory), explorer with 10k+ objects, editor with a
  5 MB script, completion with a large schema; run `dev/perf-probe.mjs` when the desktop app is up.
- `api.ts` ↔ Rust command signatures in sync (names, argument casing, optional fields), and `src/demo.ts` backend
  matching them so the browser preview does not lie.
- TypeScript: `any`, unchecked casts and non-null assertions on data from the backend.
