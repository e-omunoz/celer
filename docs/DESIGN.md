# Celer design guide

This guide defines how Celer looks, feels and behaves. It is the reference for the UI implementation,
the brand assets and any contributor. When in doubt: **the data is the hero, the tool stays out of the way.**

Main reference: JetBrains DataGrip (dense, calm, keyboard-first, smart). Celer keeps that seriousness and
adds speed you can feel and a small, well-placed personality.

---

## 1. Design principles

| Principle | What it means in practice |
|---|---|
| **Serious and precise** | Neutral surfaces, small radii, no decoration in work areas. Every pixel serves the data. |
| **Fast you can feel** | Feedback under 100 ms; no animation blocks input; spinners only after 300 ms. |
| **Keyboard first** | Every action reachable from the keyboard and from the command palette. Mouse is optional. |
| **Dense but calm** | DataGrip-level information density with generous contrast and quiet colours. |
| **Context-aware** | Actions, completion and menus adapt to the connection, the object and the cursor position. |
| **Safe by default** | Production connections look different; destructive actions are explicit and reversible where possible. |
| **Personality at the edges** | The mascot and brand colour appear in onboarding, empty states and moments of delight, never in the middle of work. |

---

## 2. Name and voice

- **Name:** *Celer* (Latin: swift; root of *celerity*, and the *c* in physics' speed of light).
  Always written **Celer**, never CELER or celer in UI text (lowercase only in code and package names).
- **Tagline:** *Swift SQL for every database.*
- **Voice:** direct, technical, friendly but never cute. Short sentences. No exclamation marks in errors.

### Microcopy rules

| Do | Don't |
|---|---|
| "Run" · "Commit" · "Export…" (verb first; ellipsis when a dialog follows) | "Click here to run your query" |
| "Connection lost. Reconnect?" | "Oops! Something went wrong 🙈" |
| "3,412 rows · 84 ms" | "Your query returned 3412 rows in 0.084 seconds" |
| Show the database's own error code + message, then a plain-language hint | Hide the original error |
| "Delete 12 rows from **orders**?" | "Are you sure?" |

The UI is localised (English and Spanish at launch). Numbers, dates and thousand separators follow the
OS locale in the UI; SQL generation always uses invariant formatting.

---

## 3. Logo

### Concept

The mark is a bold, open **C** whose opening faces right, the direction of movement. Three horizontal bars
leave through the opening: they read at the same time as **rows of data** and as **speed lines**.
The mascot repeats the brand through its Ember tie (see §4), tying brand and character together.

```
   ████████
 ███      ██
██          ═══════
██        ═════════════
██          ═══════
 ███      ██
   ████████
```

### Construction

- Built on a 128 × 128 grid. The C is a 270° arc, radius 36, stroke 16, round caps, open from −45° to +45°.
- Bars: height 7, radius 3.5, 12-unit pitch, centred on the C's vertical axis; the middle bar is the longest
  and extends beyond the arc to suggest motion.
- The arc uses the **Ember gradient** (`#FF8A3D → #E8571A`, top-left to bottom-right). Bars use the
  foreground colour of the surface (light on dark, ink on light).

### Variants

| Variant | Use |
|---|---|
| **App icon**: mark on an Ink (`#101826`) rounded square, corner radius 28/128 | Windows taskbar, installer, Start menu, macOS dock |
| **Mark**: C + bars, transparent background | In-app header, about dialog, docs |
| **Lockup**: mark + "Celer" wordmark (Inter Semibold, tracking −1%) | Website, README, splash |
| **Monochrome**: single colour (Ink or white) | Print, watermark, one-colour contexts |
| **Small (16 / 20 / 24 px)**: thicker arc (stroke 20), two bars instead of three | Favicons, tab icons, tray |

Files live in `docs/brand/`. The Windows `.ico` must contain 16, 20, 24, 32, 40, 48, 64 and 256 px
renders, each hinted by hand at 16–32 px rather than downscaled.

### Rules

- Clear space around the mark: at least the stroke width (16/128 of its size) on every side.
- Minimum size: 16 px (small variant), 24 px (standard mark), 120 px wide (lockup).
- Never: recolour the bars with the gradient, rotate or flip the mark, add shadows or outlines,
  place the colour mark on busy images, or use the mascot as the app icon.

---

## 4. Mascot: Gib, the office monkey

### Concept

Gib is a **cartoon monkey office worker** in a **white shirt and a black tie**: serious, a bit tired, slightly
scruffy, with a deadpan "poker face". The humour is in the contrast: a monkey that takes your database very
seriously. It never undermines the seriousness of the product.

- **Name:** **Gib** (short, works in English and Spanish).
- **Personality:** calm, competent, dry humour. A colleague, not a clown.
- **Style brief:** [`docs/brand/MASCOT_PROMPT.md`](brand/MASCOT_PROMPT.md) (exact palette, construction and expression system).
- **Reference poses:** `docs/brand/mascot/` — `gib-poker.svg` (main), `gib-laptop.svg` (working),
  `gib-monday.svg` (tired, with coffee), `gib-icon.svg` (flat, 24–40 px). Options explored: `docs/brand/mascot-options.html`.
- **Implementation status:** `src/gib/` draws this character (poker, laptop, Monday, icon) and hosts the
  status-bar companion, welcome pose and empty states described below.

### Visual style

- Flat cartoon with very soft gradients; no outlines around shapes, strokes only for facial features and props.
- Big head, small bust; heavy half-closed eyelids, one raised eyebrow, short flat mouth; pointed hair tufts.
- Palette: fur `#6E4B33` (gradient `#8B6246 → #56392A`), face `#F2D0AC`, eyelids `#E7BE96`, white shirt,
  black tie `#16171B`, Ember `#F26B1D` only on props (mug, laptop logo). Readable on light and dark themes.
- Sizes: 40 px in the status bar (icon pose), 64–96 px in empty states, 150 px on the welcome screen. Grid 200 × 210.

### Moods

The moods map to poses and expression parameters (eyelid closure, brows, mouth, pupils, props):

| Mood | Look | When |
|---|---|---|
| `idle` | Poker face; blinks; pupils follow the pointer | Default |
| `wave` | Eyebrows up, a hand raised | App start, waking up, opening a tip |
| `busy` | Laptop pose: glasses, focused brows, tongue out | Query or export running > 2 s |
| `ok` | Small nod, satisfied flat smile, check badge | Long query finished, commit, export done |
| `love` | Rare: eyebrows up, blush stronger | Moments of delight (clicking Gib on the welcome screen) |
| `error` | Both brows raised, pupils small, `?` | Error in a query (no sad face: errors are normal work) |
| `offline` | Eyelids almost closed, plug badge | Connection lost |
| `sleep` | Monday pose without the mug, eyes closed, `z z` | 10 min without input |

### Where Gib appears

| Place | Size | Behaviour |
|---|---|---|
| Welcome screen | 150 px | Waves on start; clicking it shows `love` |
| Status bar companion | 40 px, rising from the bar's edge | Idle animations, reactions, tips on click |
| Empty states (no connections, no results, no search matches) | 64–96 px | Static pose + one sentence + one action |
| Notifications for long tasks | 24 px | `ok` pose |
| Splash screen (only if startup > 400 ms) | 120 px | `idle` float |

### Gib as an interactive companion

Gib lives as a small **companion** at the right end of the status bar. It is alive but never in the way:
a calm colleague at the next desk, not a pop-up assistant.

**Idle behaviour** (CSS transforms and opacity only, GPU-friendly, < 1 % CPU):

| Animation | Detail |
|---|---|
| Breathing | Shirt and head rise 1 px and back, 3.6 s loop |
| Tufts | Hair tufts sway slightly, out of phase with the breathing |
| Blinking | Eyes squash for 120 ms at random intervals of 2.5–7 s; sometimes a double blink |
| Looking | Eyes follow the pointer within a 2 px radius |
| Fidgets (every 25–70 s) | Adjusts the tie, raises the other eyebrow, glances at the user over the glasses |
| Sleep | After 10 min without input; wakes up waving when the user returns |

**Tips:** clicking Gib opens a speech bubble with a tip (unseen ones first); "Otro consejo" browses more, "Cerrar"
closes it. Hovering him while he waits makes him swat the cursor, but never while he is talking; four clicks in a row
is pestering, and he grumbles. Tips are **contextual and learned from usage**, for example:

- The user ran queries with the mouse five times → "Ctrl+Enter runs the statement under the cursor."
- The user typed `SELECT *` on a wide table → "Alt+Enter on `*` expands it into the column list."
- The user exported via the grid repeatedly → "You can export straight from the query without loading the grid: right-click › Export…"
- A production connection is open → "Production connections ask before UPDATE/DELETE without WHERE."

- The same statement run three times → "Save it in the library (Ctrl+Alt+B)".
- After a run, advice about **that statement** (`src/gib/advice.ts`): likely mistakes always (`= NULL`,
  `NOT IN (SELECT …)`, comma joins without WHERE); performance only when it was slow (`LIKE '%…'`, functions on
  columns in WHERE, `UNION` vs `UNION ALL`, `ORDER BY` without a limit).

Proactive tips appear **at most once every 15 minutes** (the first a few minutes into the session), only while the
user pauses (no input for 5 s, back within a minute) and only tips not seen yet, as a small bubble that closes after
8 s or as soon as the user types. They never take focus, never appear while a query is running, on production
connections or behind a dialog, and offer "No más consejos" (Quiet). Hovering a bubble keeps it open. Warnings come once
per session, other advice at most twice ever; what was seen is remembered per machine (`src/gib/memory.ts`).

**Settings:** Companion: *Off* / *Quiet* (idle animation and warnings only, no tips of his own) / *Normal*.
"Reset tips seen" is the palette command *Gib: volver a contar los consejos desde el principio*. Idle loops pause
while the window is in the background.

### Rules

- **Never** inside the data grid, the editor, error messages about user queries or confirmation dialogs.
- At most **one** large Gib on screen at a time; the companion stays small.
- `prefers-reduced-motion`: no idle loop; mood changes are instant.
- Gib can be switched off completely; the app must feel complete without it.

---

## 5. Colour

### Brand

| Token | Hex | Use |
|---|---|---|
| Ink | `#101826` | App icon background, dark brand surfaces |
| Ember 400 | `#FF8A3D` | Gradient start, accent on dark |
| Ember 500 | `#F26B1D` | Brand accent |
| Ember 600 | `#E8571A` | Gradient end, accent on light |
| Paper | `#F7F8FA` | Light brand surfaces |

### UI accent

The interactive accent (focus rings, selection, primary buttons, active tab underline) defaults to
**Ember**, and users can pick from: Ember, Blue `#3B82F6`, Teal `#14B8A6`, Violet `#8B5CF6`, Green `#22C55E`.
Run actions are always **green**, independent of the accent (industry convention).

### Neutrals

| Token | Celer Dark | Celer Light |
|---|---|---|
| `--bg` (window) | `#15171C` | `#F7F8FA` |
| `--panel` (tool windows) | `#1B1E24` | `#FFFFFF` |
| `--surface` (editor, grid) | `#1F232A` | `#FFFFFF` |
| `--surface-alt` (zebra, headers) | `#242932` | `#F3F5F8` |
| `--border` | `#2E333D` | `#E3E6EB` |
| `--border-strong` | `#3A404C` | `#CDD2DA` |
| `--text` | `#DDE1E8` | `#1B1F27` |
| `--text-muted` | `#8B93A1` | `#667085` |
| `--text-faint` | `#5E6573` | `#98A1B0` |
| `--hover` | `#ffffff0d` | `#0000000a` |
| `--selection` | accent at 28 % | accent at 18 % |

### Semantic

| Token | Dark | Light | Use |
|---|---|---|---|
| `--success` | `#3FB950` | `#1A7F37` | Run button, success status |
| `--warning` | `#D29922` | `#9A6700` | Warnings, pending transaction |
| `--danger` | `#F85149` | `#CF222E` | Errors, destructive actions, production |
| `--info` | `#58A6FF` | `#0969DA` | Information |

### Data grid states

| State | Treatment |
|---|---|
| NULL | Italic `NULL` in `--text-faint` |
| Modified cell | Warning tint at 18 % + left border 2 px warning |
| Inserted row | Success tint at 14 % + "+" in the row header |
| Deleted row | Danger tint at 14 % + strikethrough text |
| Selected cells | `--selection` background, accent 1 px outline on the active cell |
| Zebra striping | Optional, `--surface-alt` |

### Connection colours

Each connection can have a colour (none, red, orange, yellow, green, blue, violet, grey). It appears as a
3 px strip on the editor tab, a tinted toolbar segment and a dot in the explorer.
Connections marked **Production** are always red, show a "PROD" badge in the toolbar and the status bar,
and ask for confirmation before `UPDATE`/`DELETE` without `WHERE`, `DROP` and `TRUNCATE`.

### Contrast

Text meets WCAG AA (4.5:1) on its surface; UI icons and borders meaningful for interaction meet 3:1.
Meaning never relies on colour alone: always pair it with an icon, a label or a pattern.

---

## 6. Themes

Shipped themes: **Celer Dark** (default), **Celer Light**, **High Contrast Dark**, **High Contrast Light**,
plus two community-style options: **Fjord** (cool, Nord-inspired) and **Sand** (warm, Solarized-inspired).
"System" follows the OS light/dark setting and switches live. The native title bar follows the theme.

A theme is a JSON file of tokens (UI + syntax + grid); users can import and export themes.

### Theme picker

- **Settings › Appearance › Theme** shows a gallery of cards; each card is a live miniature of the real UI
  (explorer, editor with SQL, grid) rendered with that theme. Hovering a card previews it on the whole
  window for as long as the pointer stays; clicking applies it. Esc reverts.
- Quick switch from the command palette ("Theme: …") with live preview while moving through the list.
- Separate choices for **light** and **dark** when the theme mode is "System".

### Theme configurator

A visual editor to create or tweak a theme without touching files:

- **Start from** any existing theme (duplicate) or from an accent colour + light/dark base: the configurator
  derives a full, contrast-checked palette.
- Left: token groups (Window, Panels, Text, Accent, Semantic, Editor syntax, Grid, Connection colours).
  Right: a **live preview** of a realistic workspace (explorer, tabs, SQL with every syntax token,
  grid with NULLs, edits, selection, toasts and dialogs).
- Each colour has a picker, hex input, opacity and a **contrast badge** (AA / AAA / fail) against its surface.
- Click any element in the preview to jump to the token that colours it.
- Undo/redo, reset a token or a group, "compare with original" split view.
- Save as a new theme, **export JSON**, import JSON, or **open the JSON file** in the editor (changes apply
  live on save).
- The same tokens drive CodeMirror and the canvas grid, so the preview is exact.

### SQL syntax colours (Celer Dark / Light)

| Element | Dark | Light |
|---|---|---|
| Keyword | `#FF8A5B` (bold off) | `#C2410C` |
| Function | `#7DCFFF` | `#0369A1` |
| String | `#9ECE6A` | `#15803D` |
| Number | `#E0AF68` | `#B45309` |
| Comment | `#6B7385` italic | `#8A94A6` italic |
| Identifier / column | `--text` | `--text` |
| Table / schema (resolved) | `#C0A8FF` | `#7C3AED` |
| Unresolved object | wavy underline `--danger` | same |
| Parameter (`:name`, `?`, `@p`) | `#F7768E` | `#BE185D` |
| Current statement | `--surface-alt` background band | same |

---

## 7. Typography

| Role | Font | Size | Notes |
|---|---|---|---|
| UI | **Inter** (bundled, OFL) with Segoe UI Variable / system fallback | 13 px base | Weights 400 / 500 / 600 only |
| Code and data | **JetBrains Mono** (bundled, OFL) | 13 px editor, 12.5 px grid | Ligatures off by default |
| Numbers in grid | Mono with tabular figures | — | Right-aligned |

Scale: 11 (badges, status bar) · 12 (secondary) · 13 (body) · 14 (dialog titles) · 16 (section titles) ·
20 (welcome) · 28 (splash). Line height 1.45 for UI, 1.5 for the editor. Users can change the UI and
editor sizes separately (Ctrl + mouse wheel zooms the editor or the grid under the cursor).

---

## 8. Iconography

- Base set: **Lucide** (ISC licence), 16 px, 1.5 px stroke, `currentColor`.
- Custom **database object icons** on the same grid, colour-coded for fast scanning (DataGrip-style):

| Object | Glyph | Colour |
|---|---|---|
| Database | stacked cylinder | `--text-muted` |
| Schema | folder with grid | `--text-muted` |
| Table | 3 × 3 grid | Blue `#58A6FF` |
| View | grid with eye | Teal `#2DD4BF` |
| Procedure | gear with play | Violet `#A78BFA` |
| Function | ƒ in a square | Violet `#A78BFA` |
| Column | thin bar | `--text-muted` |
| Primary key column | key | Gold `#E3B341` |
| Foreign key | key with arrow | Gold, outlined |
| Index | lightning bolt | Orange `#F0883E` |
| Trigger | bolt with clock | Pink `#F778BA` |
| Sequence | 1-2-3 | Green `#3FB950` |
| Synonym | linked arrows | `--text-muted` |

- **Engine icons:** neutral glyphs plus the engine name. Official vendor logos are used only where their
  trademark guidelines allow it.

---

## 9. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Native title bar (follows theme)                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Toolbar: [● prod-erp ▾] [db: sales ▾] [schema: dbo ▾] │ ▶ Run  ■ Stop │ Tx: Auto ▾ │
│          Commit  Rollback │ Explain │ Format │               ⌕ Search (Shift Shift)│
├────────────┬───────────────────────────────────────────────┬─────────────────┤
│ Database   │ Tabs: [● console ×] [orders ×] [report.sql ×]   │ Value viewer /  │
│ Explorer   │ ┌─────────────────────────────────────────────┐ │ Structure /     │
│            │ │ SQL editor                                  │ │ History         │
│ filter ⌕   │ │                                             │ │ (optional,      │
│ ▸ prod-erp │ └─────────────────────────────────────────────┘ │ collapsible)    │
│ ▾ dev-sql  │ Results: [Result 1] [Result 2] [Output]         │                 │
│   ▾ sales  │ ┌ filter WHERE… ─────────── ORDER BY… ─ ⟳ ⤓ ┐ │                 │
│     ▸ dbo  │ │ canvas data grid                            │ │                 │
│            │ └─────────────────────────────────────────────┘ │                 │
├────────────┴───────────────────────────────────────────────┴─────────────────┤
│ Status: ● dev-sql · sales · Auto-commit │ 3,412 rows · 84 ms │ Ln 12, Col 8 │ UTF-8 │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Tool windows** (Explorer left, Results bottom, Inspector right) can be resized, collapsed with one
  shortcut (Alt+1, Alt+4, Alt+7), maximised (Ctrl+Shift+F12 hides all) and the layout is remembered per window.
- **Spacing:** 4 px base unit (4, 8, 12, 16, 24, 32).
- **Radii:** 4 px controls, 6 px popovers and dialogs. No pill shapes except badges.
- **Elevation:** borders and slight background shifts; shadows only on popovers, menus and dialogs
  (`0 8px 24px rgb(0 0 0 / 0.28)` dark, `/ 0.12` light).
- **Density:** Compact (default): tree row 22 px, grid row 22 px, toolbar 36 px.
  Comfortable: 28 / 28 / 40 px. Chosen in settings.

---

## 10. Components

### Buttons
Primary (accent fill), secondary (border), ghost (icon / toolbar), danger (red fill, only in confirmations).
Height 26 px compact / 30 px comfortable. Toolbar buttons are icon-only with a tooltip that shows the
action name **and its shortcut**.

### Editor tabs
Connection colour strip on top, icon by type (console, table, script), modified dot, pin, close on hover.
Middle-click closes. Drag to reorder or split the editor (vertical / horizontal). Overflow goes to a dropdown.

### Windows
Several windows share connections, library, settings and Gib; each has its own tabs, explorer and side panel.
A tab dragged out of the tab bar opens a new window where it is dropped; dragged onto another window's tab bar it
moves there (that tab bar takes the accent tint while a tab from another window is in the air). The tab's menu and
the palette offer the same ("Mover a una ventana nueva", "Mover a la ventana 2"). The library, the assistant, a plan,
the E-R diagram and the comparisons have an "own window" button (external-link icon) and come back with *Acoplar*.
A panel window has a slim title bar: the panel's name, *Acoplar* and the window buttons. Gib appears in one window
only, the one in use. Closing a window that is not the last asks only when tabs would lose work.

### Data grid (canvas)
- Header: column name (600 weight) + type in `--text-faint`, sort indicator, resize handle,
  key icon for PK/FK columns. Double-click the border auto-fits the column.
- Row header with row number; it shows the inserted / deleted / modified state.
- Numbers right-aligned with tabular figures; booleans as a check glyph; dates in mono; long text truncated
  with "…"; binary as a `0x…` badge; JSON and XML with a format icon that opens the value viewer.
- Selection: cells, rows, columns, rectangular ranges; Ctrl+C copies TSV; "Copy as" for CSV, JSON,
  Markdown, SQL INSERT, SQL IN list, WHERE clause.
- Filter bar above the grid: `WHERE` and `ORDER BY` inputs with completion (DataGrip-style),
  plus quick filters from the cell context menu ("Filter by this value", "Exclude this value", "Is NULL").
- Footer: row count, "Fetch next page" / "Fetch all", elapsed time, read-only or editable indicator.

### Database explorer
Lazy tree with type-to-filter, object counts per folder, row estimates on tables, connection status dot,
"Show only this schema", drag a table into the editor to insert its name, and context actions
(Open data, Open DDL, Generate SELECT/INSERT/UPDATE, Copy name, Refresh, Drop…).

### Command palette and Search Everywhere
- **Shift Shift**: search everything (tables, columns, views, procedures, scripts, actions, settings).
- **Ctrl+Shift+A**: actions only. **Ctrl+N**: go to table or view. **Ctrl+E**: recent tabs.
- Results grouped by type with icons; Enter opens, Alt+Enter shows actions on the item.

### Notifications
JetBrains-style balloons, bottom-right, auto-dismiss after 5 s unless they contain an action.
Errors from user queries go to the Output / Messages tab, **not** to balloons.
Long operations (export, import) live in the status bar with progress and a cancel button.

### Dialogs
Used sparingly: connection, export/import wizards, confirmations. Titles state the action
("Export 125,000 rows from orders"), the primary button repeats it ("Export"). Esc always cancels.

### Empty states
Small Gib illustration (64–96 px) + one sentence + one primary action. Example:
"No connections yet. **Add connection** (Ctrl+Alt+N)".

### Loading
- < 300 ms: nothing.
- 300 ms – 2 s: thin indeterminate bar at the top of the affected panel.
- > 2 s: live timer in the results area and the status bar ("Running… 4.2 s") with **Stop**.
- The splash screen (only if startup exceeds 400 ms) shows the lockup and Gib floating.

---

## 11. Interaction and motion

Celer should look polished and feel alive, like a well-made native app, while staying instant.
Motion explains **where things come from and where they go**; it is never decoration for its own sake.

### Motion tokens

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 60 ms | Press feedback, checkbox, toggle |
| `--dur-fast` | 100 ms | Hover, tooltip in, focus ring |
| `--dur-med` | 160 ms | Popovers, menus, dropdowns, tabs |
| `--dur-slow` | 240 ms | Panels, dialogs, theme cross-fade |
| `--ease-out` | `cubic-bezier(.2, .8, .2, 1)` | Things entering |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | Things leaving (and 30 % shorter than entering) |
| `--ease-spring` | `cubic-bezier(.34, 1.4, .64, 1)` | Small playful accents only (Gib, success check) |

### Choreography

| Element | Animation |
|---|---|
| Menus, popovers, completion list | Fade + scale 0.97 → 1 from the anchor point, 160 ms |
| Dialogs | Backdrop fade 160 ms; dialog fade + translate 8 px up, 200 ms |
| Tool windows | Width/height slide 200 ms; content does not re-layout during the slide |
| Tabs | New tab grows from 0 width, 160 ms; active underline slides between tabs |
| Explorer tree | Children expand with height + fade, 120 ms, stagger 12 ms for the first 10 items only |
| Toasts / balloons | Slide in 12 px from the right + fade, 200 ms; leave with fade 140 ms |
| Theme change | Whole-window cross-fade 240 ms (snapshot of the old theme fades out) |
| Run button | Turns into a Stop button with a morph, a thin progress shimmer runs along the toolbar |
| Results arriving | **No animation**: the grid paints immediately; only the row-count badge counts up over 300 ms |
| Successful commit | The transaction indicator flashes green and settles, 400 ms |
| Copy | A small "Copied" label rises from the cursor, 600 ms |
| Skeletons | For metadata loads > 300 ms: shimmering placeholder rows in the tree, never in the grid |

### Rules

- Never animate scrolling, typing, caret movement, grid painting or anything on the critical path of input.
- Animations run on `transform` and `opacity` only (GPU compositing; no layout thrashing) and must keep 60 fps.
- Interrupting an animation (a new click, a key press) completes it instantly.
- `prefers-reduced-motion` and a setting **Reduce motion** replace all of the above with ≤ 100 ms fades.
- Keyboard focus is always visible (2 px accent ring, offset 1 px).
- Every hover action has a keyboard equivalent and appears in the context menu.
- Undo / redo for grid edits before saving, and for explorer actions that are reversible.
- Selectable **keymaps**: Celer (default), **DataGrip / IntelliJ**, VS Code. Fully customisable.

### Default shortcuts (Celer keymap, DataGrip-compatible)

| Action | Shortcut |
|---|---|
| Run statement at cursor / selection | Ctrl+Enter |
| Run whole script | Ctrl+Shift+Enter |
| Stop | Ctrl+F2 |
| Explain plan | Ctrl+Shift+E |
| Format SQL | Ctrl+Alt+L |
| Search everywhere | Shift Shift |
| Find action | Ctrl+Shift+A |
| Go to table | Ctrl+N |
| Quick documentation (columns, types, comments) | Ctrl+Q |
| Go to declaration (open table / DDL) | Ctrl+B or Ctrl+Click |
| Intentions / quick fixes | Alt+Enter |
| Comment line | Ctrl+/ |
| Duplicate line | Ctrl+D |
| Move line up/down | Ctrl+Shift+↑ / ↓ |
| Multiple cursors | Alt+Click, Alt+J |
| New console | Ctrl+Shift+L |
| New window | Ctrl+Shift+N |
| Commit / rollback | Ctrl+Alt+Shift+C / Ctrl+Alt+Shift+R |
| Toggle explorer / results | Alt+1 / Alt+4 |
| Recent tabs | Ctrl+E |
| Settings | Ctrl+Alt+S |

---

## 12. Practical utilities (feature catalogue)

The everyday tools a serious SQL client must have, grouped by area. Phase numbers refer to [ROADMAP.md](ROADMAP.md).

### Editor (phase 1–3)
- Schema-aware completion: tables, columns, aliases, joins on FK (`JOIN orders o ON …` auto-completed),
  keywords and functions per dialect.
- **Live templates**: `sel` → `SELECT * FROM |`, `ins`, `upd`, `cnt`, `top`, user-defined snippets.
- Inspections: unresolved tables/columns, `DELETE`/`UPDATE` without `WHERE`, ambiguous columns,
  `SELECT *` hint, missing `GO` / statement separators.
- Intentions (Alt+Enter): expand `*` to column list, qualify names, convert to `INSERT`/`UPDATE`,
  extract to CTE, add alias, wrap in transaction.
- Query **parameters** (`:name`, `?`, `@p`, `${var}`): a small dialog asks for values, remembered per script.
- Statement detection: the statement under the cursor is highlighted and runs with Ctrl+Enter.
- Format SQL with configurable style; uppercase/lowercase keywords.
- Local history for every console and script (restore any previous version).
- Find and replace with regex, multi-cursor, column selection, code folding, bracket matching.

### Results (phase 1–3)
- Multiple result tabs; **pin** a result to keep it when re-running.
- Transpose view (row as form), value viewer for text, JSON, XML, images and hex.
- In-grid search (Ctrl+F) and quick filters; aggregate of selection in the status bar
  (count, sum, avg, min, max, distinct).
- **Compare** two results side by side.
- Fetch size and "fetch all" with a safety limit; results stay in memory per tab until closed.
- Export from the grid or directly from a query (streaming): CSV, TSV, JSON, XML, Markdown, HTML,
  SQL INSERT/UPDATE, Excel; copy to clipboard in any of those.

### Data editing (phase 1)
- Edit cells, insert, clone and delete rows on tables with a primary key; batched changes with
  **SQL preview** before submit; revert changes per cell, row or all.
- Smart editors per type: date/time picker, boolean toggle, NULL toggle (Ctrl+Shift+N), long-text editor,
  FK lookup (pick a value from the referenced table).
- Load a file into a BLOB/BYTE column and save a BLOB to a file.

### Schema (phase 1–3)
- DDL view for every object, with copy and "open in console".
- Modify table dialog (add/rename/drop columns, indexes, keys) with generated script preview.
- Generate scripts: SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, MERGE templates for any table.
- ER diagram for a schema or a selection of tables.
- Find usages of a table or column inside views, procedures and triggers.
- Schema compare and data compare between two connections, with a migration script.

### Connections and sessions (phase 1–2)
- Folders, colours, production / read-only flags, per-connection startup script, keep-alive, auto-reconnect.
- SSH tunnel and SSL/TLS settings; Windows integrated authentication.
- **Migration assistant** from other tools (see §16): DBeaver, DbVisualizer, DataGrip and SSMS registered servers.
- Session manager: see open sessions and running queries, kill or cancel them.
- Transaction mode per console (auto / manual), pending-transaction indicator, warning on close.

### Productivity and safety (phase 3)
- Query history across all consoles, searchable, with duration, rows and connection.
- Saved scripts library with folders; open `.sql` files from disk with encoding detection.
- Workspace restore after restart (tabs, content, cursor, results metadata).
- Data import wizard (CSV, Excel, JSON) with column mapping and preview.
- Server monitoring basics: active sessions, locks, long-running queries (SQL Server, Informix, PostgreSQL first).
- Execution plan viewer: graphical tree with cost and row estimates, warnings highlighted.

---

## 13. Accessibility

- Full keyboard operation, visible focus, logical tab order, Esc closes any popover.
- ARIA roles on tree, tabs, menus and grid (the canvas grid exposes an accessible table proxy for the
  visible range).
- Respect OS high contrast, text scaling and `prefers-reduced-motion`.
- Minimum hit target 24 × 24 px (compact) and 28 × 28 px (comfortable).

---

## 14. Implementation

- All colours, spacing, radii, fonts and durations are **CSS custom properties** on `:root`, generated
  from the theme JSON. Components never use raw hex values.
- Naming: `--bg`, `--panel`, `--surface`, `--text-*`, `--accent-*`, `--success` …, `--syntax-*`, `--grid-*`,
  `--space-1…8`, `--radius-sm/md`, `--dur-fast/med/slow`.
- The canvas grid and the CodeMirror theme read the same tokens (re-read on theme change; no restart).
- Fonts (Inter, JetBrains Mono) are bundled locally: the app works fully offline.
- Brand assets: `docs/brand/` (SVG sources) and `docs/brand/playground.html`, an interactive prototype of the
  themes, accent colours, motion and the Gib companion (open it with the Vite dev server: `/docs/brand/playground.html`).
- The app icon set is generated with `npm run tauri icon` from `docs/brand/app-icon.svg`.
- Every new component is checked in Celer Dark, Celer Light and High Contrast before merging.

---

## 15. Configuration as code (AI-friendly)

Everything about appearance and behaviour is stored in **plain, documented JSON files** that a person,
a script or an AI assistant can read and edit safely. The UI settings screens are just editors for these files.

### Files

All in the user configuration folder (`%APPDATA%\es.celer.app\config\` on Windows), plus an optional
`.celer/` folder inside a project to share settings with a team (project values override user values):

| File | Contents |
|---|---|
| `appearance.json` | Active theme (light / dark / system), accent, fonts, sizes, density, motion, mascot |
| `themes/<name>.theme.json` | One file per custom theme (all tokens) |
| `editor.json` | Editor behaviour: tabs, completion, formatting style, inspections |
| `grid.json` | Grid behaviour: fetch size, NULL text, date format, zebra, row height |
| `keymap.json` | Base keymap and overrides |
| `snippets.json` | Live templates |
| `connections.json` | Connections (never passwords; those stay in the OS credential store) |

### Design rules for AI-friendliness

- Every file starts with `"$schema"` pointing to a bundled **JSON Schema** (`celer-appearance.schema.json`,
  `celer-theme.schema.json`, …). Every property has a `description`, type, allowed values, default and an example,
  so an AI or VS Code can validate and autocomplete it.
- Files are **JSONC** (comments and trailing commas allowed), like VS Code settings.
- Only values that differ from the defaults need to be written; unknown keys produce a visible warning, not a crash.
- **Hot reload:** saving a file applies it immediately; invalid files show the exact line and error in a
  notification and the last valid configuration stays active.
- Colours accept `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `hsl()` and references to other tokens (`"@accent"`,
  `"mix(@accent, @surface, 20%)"`) so a theme can be described with a few base colours.
- **"Copy settings for AI"** action: copies the current files plus their schemas to the clipboard, ready to paste
  into an assistant with a request such as "make a dark blue theme with high-contrast syntax".
- **"Apply JSON from clipboard"**: validates pasted JSON against the schema, shows a diff and a live preview,
  and applies it only after confirmation.
- A command-line flag `celer --config-dir <path>` and an environment variable allow fully scripted setups.

### Example: `appearance.json`

```jsonc
{
  "$schema": "https://celer.dev/schema/celer-appearance.schema.json",
  "theme": { "mode": "system", "light": "Celer Light", "dark": "Celer Dark" },
  "accent": "#F26B1D",
  "font": { "ui": "Inter", "uiSize": 13, "code": "JetBrains Mono", "codeSize": 13, "ligatures": false },
  "density": "compact",            // compact | comfortable
  "motion": "full",                // full | reduced | none
  "grid": { "zebra": true, "nullText": "NULL" },
  "mascot": {
    "companion": "normal",         // off | quiet | normal
    "tipsEveryMinutes": 15,
    "sleepAfterMinutes": 10
  }
}
```

### Example: `themes/midnight.theme.json`

```jsonc
{
  "$schema": "https://celer.dev/schema/celer-theme.schema.json",
  "name": "Midnight",
  "base": "dark",                  // inherit everything not listed from Celer Dark
  "colors": {
    "accent": "#4F8CFF",
    "bg": "#0E1320",
    "panel": "#121929",
    "surface": "#151D2E",
    "border": "#22304A",
    "text": "#D8E1F0",
    "selection": "mix(@accent, @surface, 30%)"
  },
  "syntax": {
    "keyword": "#7AA2F7",
    "string": "#9ECE6A",
    "number": "#FF9E64",
    "comment": { "color": "#565F89", "italic": true }
  },
  "grid": { "modified": "#E0AF6830", "inserted": "#9ECE6A26", "deleted": "#F7768E26" },
  "connectionColors": { "production": "#F7768E" }
}
```

The theme configurator (§6) reads and writes exactly these files, so editing by hand, through the UI or
with an AI always produces the same result.

---

## 16. Migration from other tools

A **Migration assistant** (first run, and *File › Import from…*) detects other database tools installed
on the machine and imports their work into Celer. Nothing is modified in the source tools.

| Source | What is read | Imported |
|---|---|---|
| **DBeaver** | `%APPDATA%\DBeaverData\workspace6\<project>\.dbeaver\data-sources.json`, `credentials-config.json`, `Scripts\` | Connections (host, port, database, user, driver properties), folders, connection colours/types (production), saved passwords (optional), SQL scripts |
| **DbVisualizer** | `%USERPROFILE%\.dbvis\config70\dbvis.xml`, bookmarks | Connections and folders, driver properties, saved passwords (optional), SQL bookmarks as scripts |
| **DataGrip** | `dataSources.xml` / `dataSources.local.xml` in the IDE config or a project | Connections, folders, colours |
| **SSMS** | Registered servers (`RegSrvr.xml`) | SQL Server connections and groups |
| **ODBC** | System and user DSNs | Generic ODBC connections |

- The assistant shows a checklist of what was found, maps each source driver to a Celer driver
  (for example DBeaver `informix` → Celer Informix DRDA; unsupported drivers → generic ODBC or skipped,
  listed explicitly), and previews conflicts with existing connections.
- **Passwords** are imported only if the user ticks the option; they go straight into the OS credential store.
- A summary at the end lists what was imported, what was skipped and why.
- The reverse is also available: **export Celer connections** to a portable JSON (without passwords)
  to share with a team or move to another machine.
