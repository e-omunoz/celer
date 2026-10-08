# Area: visual (layout, themes, rendering)

## How to look at the app
- Browser preview with the in-memory SQLite demo backend: start launch config `celer-web` (port 1420) with
  `mcp__Claude_Browser__preview_start {name: "celer-web"}`, then screenshot. Fast; no Tauri chrome.
- Real desktop app: `powershell -ExecutionPolicy Bypass -File dev\run-desktop.ps1` (debug build, own data folder,
  DevTools on 9333). Drive and screenshot it with `dev/cdp-lib.mjs` (see `dev/readme-media.mjs`, `dev/tour-check.mjs`
  for examples). Use this for the title bar, caption buttons, several windows, splash and native dialogs.
- Save every screenshot to `review-out/ui-visual/<screen>-<theme>-<width>.png`.

## Matrix
Themes: Celer Dark, Celer Light, Darcula, Fjord, Sand, both high-contrast, System (light and dark OS).
Density: compact / comfortable. Sizes: 1024×640, 1366×768, 1920×1080, and 125 % / 150 % scaling.

## Screens
Splash and Gib; empty first run and onboarding; explorer (long names, 10k objects, nested folders, favourites,
state dots); console + editor (completion popup, current-statement band, folding, search panel); results grid
(wide/narrow columns, NULLs, long text, unicode/emoji, RTL, numbers alignment, selection, aggregates bar);
table viewer (filters chips, editing, SQL preview, DDL tab); inspector (JSON, XML, record view); command palette;
connection dialog (every engine, JDBC URL field, validation messages, step-by-step test); settings (all tabs,
theme previews, keymap); export/import dialogs and progress; library view; E-R diagram; plan view; schema and
data compare; activity; update dialog; several windows and panels in their own window; installer UI
(launch config `celer-setup`).

## Look for
Clipping, overflow and horizontal scroll; text cut without ellipsis/tooltip; overlapping layers and z-index; popups
off-screen near edges; misaligned icons/baselines; colours hard-coded instead of theme tokens (grep `#[0-9a-f]{3,6}`
and `rgb(` in `src/**/*.css|tsx`); insufficient contrast (WCAG AA 4.5:1 text, 3:1 UI) especially in high-contrast and
Sand/Fjord; focus ring missing or invisible; hover/active states missing; flashes (white frame, layout jump) on
open, theme switch, tab switch; blurry canvas grid at fractional scaling; inconsistent spacing between equivalent
dialogs; Spanish text with typos, mixed languages, or English leftovers; console errors/warnings while navigating
(`read_console_messages`).
