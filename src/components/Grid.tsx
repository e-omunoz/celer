import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { cellText, isNullCell, quoteIdentFor, sqlLiteral } from "../sql";
import { copyText, openMenu, setState, state, type GridStats, type MenuItem } from "../state";
import type { Cell, ColumnInfo } from "../types";

const HEAD_H = 30;
const MIN_W = 56;
const MAX_AUTO_W = 420;

interface Pos {
  row: number;
  col: number;
}

export type CopyFormat = "tsv" | "tsv-head" | "csv" | "json" | "markdown" | "insert" | "in" | "where";

export interface GridProps {
  columns: ColumnInfo[];
  rows: Cell[][];
  /** Stable identity for the data set; changing it resets sort, widths and selection. */
  resetKey?: unknown;
  pkCols?: number[];
  deleted?: number[];
  edits?: Record<string, string | null>;
  insertStart?: number;
  hasMore?: boolean;
  loading?: boolean;
  editable?: boolean;
  tableName?: string;
  /** Engine of the data, for identifier quoting and literals in copy-as-SQL. */
  dialect?: string;
  onEdit?: (row: number, col: number, value: string | null) => void;
  onNeedMore?: () => void;
  onDelete?: (rows: number[]) => void;
  onClone?: (row: number) => void;
  onInsert?: () => void;
  onFilter?: (filter: { col: number; op: "eq" | "ne" | "contains" | "null" | "not-null"; value: string }) => void;
  onColumnFilter?: (col: number) => void;
  /** Controlled sorting (server side). When set, the grid does not sort rows itself. */
  sortState?: { col: number; dir: 1 | -1 } | null;
  onSortChange?: (sort: { col: number; dir: 1 | -1 } | null) => void;
  onExport?: () => void;
  onActivate?: (row: number, col: number) => void;
  /** Ctrl+Enter in an editable grid (table viewer): review and save the pending changes. */
  onSave?: () => void;
  api?: (api: GridApi) => void;
}

export interface GridApi {
  deleteSelected: () => void;
  focus: () => void;
}

interface Palette {
  fg: string;
  muted: string;
  faint: string;
  line: string;
  head: string;
  headFg: string;
  sel: string;
  selStrong: string;
  accent: string;
  alt: string;
  bg: string;
  modified: string;
  inserted: string;
  deleted: string;
  warning: string;
  success: string;
  danger: string;
  match: string;
  key: string;
  number: string;
  mono: string;
  sans: string;
}

let probe: HTMLSpanElement | null = null;

/** Resolves a custom property (which may hold var() or color-mix()) to a concrete colour the canvas understands. */
function resolveColor(name: string, fallback: string) {
  if (!probe) {
    probe = document.createElement("span");
    probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
  }
  probe.style.color = "";
  probe.style.color = `var(${name}, ${fallback || "transparent"})`;
  return getComputedStyle(probe).color || fallback;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback = "") => (name === "--mono" || name === "--sans" ? css.getPropertyValue(name).trim() || fallback : resolveColor(name, fallback));
  return {
    fg: v("--text"),
    muted: v("--text-muted"),
    faint: v("--text-faint"),
    line: v("--grid-line"),
    head: v("--grid-head"),
    headFg: v("--text"),
    sel: v("--grid-sel"),
    selStrong: v("--grid-sel-strong", v("--grid-sel")),
    accent: v("--accent"),
    alt: v("--grid-alt"),
    bg: v("--surface"),
    modified: v("--grid-modified"),
    inserted: v("--grid-inserted"),
    deleted: v("--grid-deleted"),
    warning: v("--warning"),
    success: v("--success"),
    danger: v("--danger"),
    match: v("--grid-match"),
    key: v("--obj-key"),
    number: v("--grid-number", v("--text")),
    mono: v("--mono", "monospace"),
    sans: v("--sans", "sans-serif"),
  };
}

export function DataGrid(props: GridProps) {
  let root: HTMLDivElement | undefined;
  let scroller: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let palette: Palette | null = null;
  let charW = 7.5;
  let frame = 0;

  const [scroll, setScroll] = createSignal({ x: 0, y: 0 });
  const [viewport, setViewport] = createSignal({ w: 0, h: 0 });
  const [widths, setWidths] = createSignal<number[]>([]);
  const [anchor, setAnchor] = createSignal<Pos | null>(null);
  const [focus, setFocus] = createSignal<Pos | null>(null);
  const [localSort, setLocalSort] = createSignal<{ col: number; dir: 1 | -1 } | null>(null);
  const sort = () => (props.onSortChange ? props.sortState ?? null : localSort());
  const setSort = (next: { col: number; dir: 1 | -1 } | null) => (props.onSortChange ? props.onSortChange(next) : setLocalSort(next));
  const [hoverCol, setHoverCol] = createSignal(-1);
  const [editor, setEditor] = createSignal<{ row: number; col: number; value: string } | null>(null);
  const [search, setSearch] = createSignal<string | null>(null);
  let drag: { col: number; startX: number; startW: number } | null = null;
  let selecting: "cells" | "rows" | "cols" | null = null;

  const rowH = () => (state.settings.density === "comfortable" ? 28 : 24);
  const gutter = () => Math.max(44, String(props.rows.length).length * 8 + 22);

  const order = () => {
    const current = props.onSortChange ? null : sort();
    const data = unwrap(props.rows);
    props.rows.length;
    const indexes = Array.from({ length: data.length }, (_, index) => index);
    if (!current) return indexes;
    const { col, dir } = current;
    const numeric = props.columns[col]?.kind === "number";
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    indexes.sort((a, b) => {
      const left = data[a]?.[col];
      const right = data[b]?.[col];
      if (isNullCell(left) && isNullCell(right)) return 0;
      if (isNullCell(left)) return 1;
      if (isNullCell(right)) return -1;
      if (numeric) {
        const l = typeof left === "number" ? left : Number(left);
        const r = typeof right === "number" ? right : Number(right);
        if (!Number.isNaN(l) && !Number.isNaN(r)) return (l - r) * dir;
      }
      return collator.compare(cellText(left), cellText(right)) * dir;
    });
    return indexes;
  };

  // Cached ordering so painting does not re-sort.
  const [ordered, setOrdered] = createSignal<number[]>([]);
  createEffect(() => setOrdered(order()));

  const colX = () => {
    const xs: number[] = [];
    let x = gutter();
    for (const w of widths()) {
      xs.push(x);
      x += w;
    }
    xs.push(x);
    return xs;
  };

  const contentW = () => colX()[widths().length] ?? gutter();
  const contentH = () => HEAD_H + ordered().length * rowH() + (props.hasMore ? rowH() : 0);

  const sel = () => {
    const a = anchor();
    const f = focus();
    if (!a || !f) return null;
    return { r1: Math.min(a.row, f.row), r2: Math.max(a.row, f.row), c1: Math.min(a.col, f.col), c2: Math.max(a.col, f.col) };
  };

  function measureWidths() {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return props.columns.map(() => 120);
    ctx.font = `600 12px ${palette?.sans ?? "sans-serif"}`;
    const names = props.columns.map((col) => ctx.measureText(col.name).width);
    ctx.font = `11px ${palette?.sans ?? "sans-serif"}`;
    const heads = props.columns.map((col, index) => names[index] + (col.typeName ? Math.min(150, ctx.measureText(col.typeName.toLowerCase()).width + 6) : 0) + 40 + ((props.pkCols ?? []).includes(index) ? 15 : 0));
    ctx.font = `12.5px ${palette?.mono ?? "monospace"}`;
    charW = ctx.measureText("M").width || 7.5;
    const sample = unwrap(props.rows).slice(0, 300);
    return props.columns.map((_, index) => {
      let longest = 4;
      for (const row of sample) {
        const value = row[index];
        const len = isNullCell(value) ? 4 : Math.min(80, cellText(value).length);
        if (len > longest) longest = len;
      }
      return Math.round(Math.min(MAX_AUTO_W, Math.max(MIN_W, heads[index], longest * charW + 22)));
    });
  }

  function refreshPalette() {
    palette = readPalette();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  }

  function paint() {
    if (!canvas || !scroller) return;
    if (!palette) refreshPalette();
    const p = palette!;
    const dpr = window.devicePixelRatio || 1;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, width, height);
    const RH = rowH();
    const G = gutter();
    const cols = widths();
    const xs = colX();
    const rows = ordered();
    const data = unwrap(props.rows);
    const view = scroll();
    const start = Math.max(0, Math.floor(view.y / RH));
    const end = Math.min(rows.length, start + Math.ceil((height - HEAD_H) / RH) + 2);
    const s = sel();
    const f = focus();
    const query = search()?.toLowerCase() || "";
    const deleted = new Set(props.deleted ?? []);
    const zebra = state.settings.zebra;
    const fontCell = `12.5px ${p.mono}`;
    const fontItalic = `italic 12.5px ${p.mono}`;
    ctx.textBaseline = "middle";

    // first visible column
    let c0 = 0;
    while (c0 < cols.length && xs[c0 + 1] - view.x < G) c0++;

    for (let vr = start; vr < end; vr++) {
      const source = rows[vr];
      const y = HEAD_H + vr * RH - view.y;
      const isDeleted = deleted.has(source);
      const isInserted = props.insertStart !== undefined && source >= props.insertStart;
      let rowBg = zebra && vr % 2 === 1 ? p.alt : p.bg;
      if (isDeleted) rowBg = p.deleted;
      else if (isInserted) rowBg = p.inserted;
      ctx.fillStyle = rowBg;
      ctx.fillRect(G, y, width - G, RH);
      const rowSelected = s && vr >= s.r1 && vr <= s.r2;
      for (let col = c0; col < cols.length; col++) {
        const x = xs[col] - view.x;
        const w = cols[col];
        if (x > width) break;
        const inside = rowSelected && col >= s!.c1 && col <= s!.c2;
        const raw = data[source]?.[col];
        const edited = props.edits && Object.prototype.hasOwnProperty.call(props.edits, `${source}:${col}`);
        if (edited) {
          ctx.fillStyle = p.modified;
          ctx.fillRect(x, y, w, RH);
        }
        if (inside) {
          ctx.fillStyle = p.sel;
          ctx.fillRect(x, y, w, RH);
        }
        const isNull = isNullCell(raw);
        const kind = props.columns[col]?.kind;
        let label = isNull ? "NULL" : cellText(raw);
        if (query && !isNull && label.toLowerCase().includes(query)) {
          ctx.fillStyle = p.match;
          ctx.fillRect(x + 1, y + 1, w - 2, RH - 2);
        }
        if (edited) {
          ctx.fillStyle = p.warning;
          ctx.fillRect(x, y, 2, RH);
        }
        if (label.length > 400) label = label.slice(0, 400);
        if (label.includes("\n") || label.includes("\r")) label = label.replace(/\r?\n|\r/g, " ↵ ");
        const maxChars = Math.floor((w - 16) / charW);
        if (label.length > maxChars) label = maxChars > 1 ? `${label.slice(0, maxChars - 1)}…` : "…";
        ctx.font = isNull || isDeleted ? fontItalic : fontCell;
        if (kind === "bool" && !isNull) {
          const on = raw === true || raw === 1 || /^(true|t|1|yes|y)$/i.test(String(raw));
          ctx.fillStyle = on ? p.success : p.faint;
          ctx.fillText(on ? "✓ true" : "✗ false", x + 8, y + RH / 2 + 0.5);
        } else {
          const right = kind === "number" && !isNull;
          ctx.fillStyle = isNull ? p.faint : right ? p.number : p.fg;
          const tx = right ? x + w - 8 - label.length * charW : x + 8;
          ctx.fillText(label, tx, y + RH / 2 + 0.5);
          if (isDeleted) {
            ctx.strokeStyle = p.danger;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tx, y + RH / 2 + 0.5);
            ctx.lineTo(tx + label.length * charW, y + RH / 2 + 0.5);
            ctx.stroke();
          }
        }
        ctx.fillStyle = p.line;
        ctx.fillRect(x + w - 1, y, 1, RH);
      }
      ctx.fillStyle = p.line;
      ctx.fillRect(G, y + RH - 1, width - G, 1);
    }

    // "more rows" row
    if (props.hasMore) {
      const y = HEAD_H + rows.length * RH - view.y;
      if (y < height) {
        ctx.fillStyle = p.alt;
        ctx.fillRect(G, y, width - G, RH);
        ctx.fillStyle = p.muted;
        ctx.font = `12px ${p.sans}`;
        ctx.fillText(props.loading ? "Cargando más filas…" : "Hay más filas · desplázate o pulsa «Cargar todo»", G + 10, y + RH / 2);
      }
    }

    // active cell outline
    if (f) {
      const y = HEAD_H + f.row * RH - view.y;
      const x = (xs[f.col] ?? 0) - view.x;
      if (y + RH > HEAD_H && x + (cols[f.col] ?? 0) > G) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(G, HEAD_H, width - G, height - HEAD_H);
        ctx.clip();
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, (cols[f.col] ?? 0) - 1.5, RH - 1.5);
        ctx.restore();
      }
    }

    // header
    ctx.fillStyle = p.head;
    ctx.fillRect(0, 0, width, HEAD_H);
    const pk = new Set(props.pkCols ?? []);
    for (let col = c0; col < cols.length; col++) {
      const x = xs[col] - view.x;
      const w = cols[col];
      if (x > width) break;
      const colSelected = s && col >= s.c1 && col <= s.c2;
      if (colSelected) {
        ctx.fillStyle = p.sel;
        ctx.fillRect(x, 0, w, HEAD_H);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w - 1, HEAD_H);
      ctx.clip();
      let tx = x + 8;
      if (pk.has(col)) {
        ctx.strokeStyle = p.key;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(tx + 3.5, HEAD_H / 2, 2.8, 0, Math.PI * 2);
        ctx.moveTo(tx + 6.3, HEAD_H / 2);
        ctx.lineTo(tx + 11, HEAD_H / 2);
        ctx.moveTo(tx + 9.5, HEAD_H / 2);
        ctx.lineTo(tx + 9.5, HEAD_H / 2 + 2.4);
        ctx.stroke();
        tx += 15;
      }
      ctx.font = `600 12px ${p.sans}`;
      ctx.fillStyle = p.headFg;
      const name = props.columns[col].name;
      ctx.fillText(name, tx, HEAD_H / 2 + 0.5);
      const nameW = ctx.measureText(name).width;
      const type = props.columns[col].typeName;
      if (type) {
        ctx.font = `11px ${p.sans}`;
        ctx.fillStyle = p.faint;
        ctx.fillText(type.toLowerCase(), tx + nameW + 6, HEAD_H / 2 + 0.5);
      }
      const sorted = sort()?.col === col;
      if (sorted || hoverCol() === col) {
        const ax = x + w - 16;
        ctx.fillStyle = p.head;
        ctx.fillRect(ax - 4, 0, 20, HEAD_H - 1);
        ctx.fillStyle = sorted ? p.accent : p.faint;
        ctx.beginPath();
        const dir = sorted ? sort()!.dir : 1;
        const cy = HEAD_H / 2;
        if (dir === 1) {
          ctx.moveTo(ax, cy + 2.5);
          ctx.lineTo(ax + 4, cy - 2.5);
          ctx.lineTo(ax + 8, cy + 2.5);
        } else {
          ctx.moveTo(ax, cy - 2.5);
          ctx.lineTo(ax + 4, cy + 2.5);
          ctx.lineTo(ax + 8, cy - 2.5);
        }
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = p.line;
      ctx.fillRect(x + w - 1, 6, 1, HEAD_H - 12);
    }
    ctx.fillStyle = p.line;
    ctx.fillRect(0, HEAD_H - 1, width, 1);

    // gutter
    ctx.fillStyle = p.head;
    ctx.fillRect(0, HEAD_H, G, height - HEAD_H);
    ctx.font = `11px ${p.mono}`;
    for (let vr = start; vr < end; vr++) {
      const source = rows[vr];
      const y = HEAD_H + vr * RH - view.y;
      const rowSelected = s && vr >= s.r1 && vr <= s.r2;
      if (rowSelected) {
        ctx.fillStyle = p.sel;
        ctx.fillRect(0, y, G, RH);
      }
      const isInserted = props.insertStart !== undefined && source >= props.insertStart;
      const isDeleted = deleted.has(source);
      ctx.fillStyle = isInserted ? p.success : isDeleted ? p.danger : f && f.row === vr ? p.fg : p.faint;
      const label = isInserted ? "+" : isDeleted ? "−" : String(source + 1);
      ctx.fillText(label, G - 8 - label.length * 6.6, y + RH / 2 + 0.5);
    }
    ctx.fillStyle = p.head;
    ctx.fillRect(0, 0, G, HEAD_H);
    ctx.fillStyle = p.line;
    ctx.fillRect(G - 1, 0, 1, height);
    ctx.fillRect(0, HEAD_H - 1, G, 1);
  }

  // ------------------------------------------------------------ geometry

  function local(event: MouseEvent) {
    const rect = scroller!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function colAt(x: number) {
    const xs = colX();
    const vx = x + scroll().x;
    for (let col = 0; col < widths().length; col++) {
      if (vx >= xs[col] && vx < xs[col + 1]) return col;
    }
    return -1;
  }

  function hit(event: MouseEvent) {
    const { x, y } = local(event);
    if (x > scroller!.clientWidth || y > scroller!.clientHeight) return { type: "scrollbar" as const };
    const xs = colX();
    if (y < HEAD_H) {
      if (x < gutter()) return { type: "corner" as const };
      for (let col = 0; col < widths().length; col++) {
        const edge = xs[col + 1] - scroll().x;
        if (Math.abs(x - edge) <= 4) return { type: "resize" as const, col };
      }
      const col = colAt(x);
      if (col < 0) return { type: "none" as const };
      const right = xs[col + 1] - scroll().x;
      return { type: x > right - 22 ? ("sort" as const) : ("header" as const), col };
    }
    const row = Math.floor((y - HEAD_H + scroll().y) / rowH());
    if (row >= ordered().length) return { type: row === ordered().length && props.hasMore ? ("more" as const) : ("none" as const) };
    if (x < gutter()) return { type: "gutter" as const, row };
    const col = colAt(x);
    if (col < 0) return { type: "none" as const };
    return { type: "cell" as const, row, col };
  }

  function scrollIntoView(pos: Pos) {
    if (!scroller) return;
    const RH = rowH();
    const top = pos.row * RH;
    const viewH = scroller.clientHeight - HEAD_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + RH > scroller.scrollTop + viewH) scroller.scrollTop = top + RH - viewH;
    const xs = colX();
    const left = xs[pos.col] - gutter();
    const w = widths()[pos.col] ?? 0;
    const viewW = scroller.clientWidth - gutter();
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (left + w > scroller.scrollLeft + viewW) scroller.scrollLeft = Math.min(left, left + w - viewW);
  }

  function setCursor(pos: Pos, extend = false) {
    const rowCount = ordered().length;
    const colCount = props.columns.length;
    if (!rowCount || !colCount) return;
    const next = { row: clamp(pos.row, 0, rowCount - 1), col: clamp(pos.col, 0, colCount - 1) };
    if (!extend || !anchor()) setAnchor(next);
    setFocus(next);
    scrollIntoView(next);
    if (next.row > rowCount - 20 && props.hasMore && !props.loading) props.onNeedMore?.();
  }

  // ------------------------------------------------------------ mouse

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0 && event.button !== 2) return;
    const target = hit(event);
    if (target.type === "scrollbar") return;
    root?.focus({ preventScroll: true });
    if (event.button === 2) {
      if (target.type === "cell") {
        const s = sel();
        const inside = s && target.row >= s.r1 && target.row <= s.r2 && target.col >= s.c1 && target.col <= s.c2;
        if (!inside) setCursor({ row: target.row, col: target.col });
      }
      return;
    }
    if (target.type === "resize") {
      event.preventDefault();
      drag = { col: target.col, startX: event.clientX, startW: widths()[target.col] };
      return;
    }
    if (target.type === "sort") {
      toggleSort(target.col);
      return;
    }
    if (target.type === "header") {
      if (event.shiftKey && anchor()) setFocus({ row: Math.max(0, ordered().length - 1), col: target.col });
      else {
        setAnchor({ row: 0, col: target.col });
        setFocus({ row: Math.max(0, ordered().length - 1), col: target.col });
      }
      selecting = "cols";
      return;
    }
    if (target.type === "corner") {
      selectAll();
      return;
    }
    if (target.type === "gutter") {
      const last = props.columns.length - 1;
      if (event.shiftKey && anchor()) setFocus({ row: target.row, col: last });
      else {
        setAnchor({ row: target.row, col: 0 });
        setFocus({ row: target.row, col: last });
      }
      selecting = "rows";
      return;
    }
    if (target.type === "more") {
      props.onNeedMore?.();
      return;
    }
    if (target.type === "cell") {
      event.preventDefault();
      setCursor({ row: target.row, col: target.col }, event.shiftKey);
      selecting = "cells";
    }
  }

  function onMouseMove(event: MouseEvent) {
    if (drag) {
      const next = widths().slice();
      next[drag.col] = Math.max(MIN_W - 20, drag.startW + event.clientX - drag.startX);
      setWidths(next);
      return;
    }
    if (!scroller) return;
    const { y } = local(event);
    if (y < HEAD_H) {
      const target = hit(event);
      scroller.style.cursor = target.type === "resize" ? "col-resize" : "default";
      setHoverCol(target.type === "header" || target.type === "sort" ? target.col : -1);
    } else {
      scroller.style.cursor = "default";
      if (hoverCol() !== -1) setHoverCol(-1);
    }
    if (!selecting || !(event.buttons & 1)) return;
    const target = hit(event);
    if (selecting === "cells" && target.type === "cell") setFocus({ row: target.row, col: target.col });
    if (selecting === "rows" && (target.type === "gutter" || target.type === "cell")) setFocus({ row: target.row, col: props.columns.length - 1 });
    if (selecting === "cols" && (target.type === "header" || target.type === "sort" || target.type === "cell")) setFocus({ row: Math.max(0, ordered().length - 1), col: target.col });
  }

  function onMouseUp() {
    drag = null;
    selecting = null;
  }

  function onDoubleClick(event: MouseEvent) {
    const target = hit(event);
    if (target.type === "resize") {
      autofit(target.col);
      return;
    }
    if (target.type === "cell") {
      if (props.editable && props.onEdit) beginEdit({ row: target.row, col: target.col });
      else props.onActivate?.(ordered()[target.row], target.col);
    }
  }

  function onLeave() {
    if (hoverCol() !== -1) setHoverCol(-1);
  }

  // ------------------------------------------------------------ actions

  function toggleSort(col: number, dir?: 1 | -1) {
    const current = sort();
    if (dir) setSort({ col, dir });
    else if (current?.col !== col) setSort({ col, dir: 1 });
    else if (current.dir === 1) setSort({ col, dir: -1 });
    else setSort(null);
  }

  function selectAll() {
    if (!ordered().length || !props.columns.length) return;
    setAnchor({ row: 0, col: 0 });
    setFocus({ row: ordered().length - 1, col: props.columns.length - 1 });
  }

  function autofit(col?: number) {
    const measured = measureWidths();
    if (col === undefined) setWidths(measured);
    else {
      const next = widths().slice();
      next[col] = measured[col];
      setWidths(next);
    }
  }

  function beginEdit(pos: Pos, initial?: string) {
    if (!props.editable || !props.onEdit) return;
    const source = ordered()[pos.row];
    if (source === undefined || props.deleted?.includes(source)) return;
    const raw = unwrap(props.rows)[source]?.[pos.col];
    scrollIntoView(pos);
    setEditor({ row: pos.row, col: pos.col, value: initial ?? (isNullCell(raw) ? "" : cellText(raw)) });
    queueMicrotask(() => {
      const input = root?.querySelector<HTMLInputElement>(".cell-editor input");
      input?.focus();
      if (initial === undefined) input?.select();
    });
  }

  function commitEditor(value: string | null, move?: Pos) {
    const current = editor();
    if (!current) return;
    props.onEdit?.(ordered()[current.row], current.col, value);
    setEditor(null);
    root?.focus({ preventScroll: true });
    if (move) setCursor(move);
  }

  function selectedRows() {
    const s = sel();
    if (!s) return [] as number[];
    const rows: number[] = [];
    for (let vr = s.r1; vr <= s.r2; vr++) {
      const source = ordered()[vr];
      if (source !== undefined) rows.push(source);
    }
    return rows;
  }

  function selectedCols() {
    const s = sel();
    if (!s) return [] as number[];
    const cols: number[] = [];
    for (let c = s.c1; c <= s.c2; c++) cols.push(c);
    return cols;
  }

  function formatSelection(format: CopyFormat) {
    const rows = selectedRows().map((source) => unwrap(props.rows)[source] ?? []);
    const cols = selectedCols();
    const names = cols.map((c) => props.columns[c].name);
    const val = (row: Cell[], c: number) => row[c];
    const text = (cell: Cell) => (isNullCell(cell) ? "" : cellText(cell));
    const literal = (cell: Cell, c: number) => (isNullCell(cell) ? "NULL" : sqlLiteral(cellText(cell), props.columns[c]?.kind ?? "text", props.dialect));
    const ident = (name: string) => quoteIdentFor(name, props.dialect);
    switch (format) {
      case "tsv":
        return rows.map((row) => cols.map((c) => text(val(row, c)).replace(/\t|\r?\n/g, " ")).join("\t")).join("\n");
      case "tsv-head":
        return [names.join("\t"), ...rows.map((row) => cols.map((c) => text(val(row, c)).replace(/\t|\r?\n/g, " ")).join("\t"))].join("\n");
      case "csv": {
        const esc = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
        return [names.map(esc).join(","), ...rows.map((row) => cols.map((c) => esc(text(val(row, c)))).join(","))].join("\n");
      }
      case "json":
        return JSON.stringify(
          rows.map((row) => Object.fromEntries(cols.map((c) => [props.columns[c].name, val(row, c) ?? null]))),
          null,
          2,
        );
      case "markdown": {
        const esc = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        return [
          `| ${names.map(esc).join(" | ")} |`,
          `| ${cols.map((c) => (props.columns[c].kind === "number" ? "---:" : "---")).join(" | ")} |`,
          ...rows.map((row) => `| ${cols.map((c) => (isNullCell(val(row, c)) ? "NULL" : esc(text(val(row, c))))).join(" | ")} |`),
        ].join("\n");
      }
      case "insert": {
        const table = props.tableName || "tabla";
        const head = names.map(ident).join(", ");
        return rows.map((row) => `INSERT INTO ${table} (${head}) VALUES (${cols.map((c) => literal(val(row, c), c)).join(", ")});`).join("\n");
      }
      case "in": {
        const c = cols[0];
        const values = [...new Set(rows.map((row) => literal(val(row, c), c)))];
        return `(${values.join(", ")})`;
      }
      case "where":
        return rows
          .map((row) => `(${cols.map((c) => (isNullCell(val(row, c)) ? `${ident(props.columns[c].name)} IS NULL` : `${ident(props.columns[c].name)} = ${literal(val(row, c), c)}`)).join(" AND ")})`)
          .join("\n   OR ");
    }
  }

  function copy(format: CopyFormat = "tsv") {
    if (!sel()) return;
    const count = selectedRows().length;
    void copyText(formatSelection(format), `Copiado${count > 1 ? ` · ${count.toLocaleString()} filas` : ""}`);
  }

  function quickFilter(mode: "eq" | "ne" | "null" | "not-null" | "contains") {
    const f = focus();
    if (!f || !props.onFilter) return;
    const source = ordered()[f.row];
    const cell = unwrap(props.rows)[source]?.[f.col];
    const isNull = isNullCell(cell);
    const op = isNull && mode === "eq" ? "null" : isNull && mode === "ne" ? "not-null" : mode;
    props.onFilter({ col: f.col, op, value: isNull ? "" : cellText(cell) });
  }
  function setNull() {
    const s = sel();
    if (!s || !props.editable || !props.onEdit) return;
    for (const source of selectedRows()) for (const c of selectedCols()) props.onEdit(source, c, null);
  }

  function contextMenu(event: MouseEvent) {
    const target = hit(event);
    if (target.type === "header" || target.type === "sort") {
      openMenu(event, [
        { label: "Orden ascendente", icon: "asc", run: () => toggleSort(target.col, 1) },
        { label: "Orden descendente", icon: "desc", run: () => toggleSort(target.col, -1) },
        { label: "Quitar orden", disabled: !sort(), run: () => setSort(null) },
        ...(props.onColumnFilter ? [{ separator: true }, { label: "Filtrar esta columna…", icon: "filter", run: () => props.onColumnFilter?.(target.col) }] : []),
        { separator: true },
        { label: "Ajustar ancho", run: () => autofit(target.col) },
        { label: "Ajustar todas las columnas", run: () => autofit() },
        { separator: true },
        { label: "Copiar nombre de columna", run: () => void copyText(props.columns[target.col].name) },
      ]);
      return;
    }
    if (target.type !== "cell" && target.type !== "gutter") return;
    const many = selectedRows().length;
    const items: MenuItem[] = [
      { label: "Copiar", hint: "Ctrl+C", icon: "copy", run: () => copy("tsv") },
      { label: "Copiar con cabeceras", hint: "Ctrl+Shift+C", run: () => copy("tsv-head") },
      { label: "Copiar como CSV", run: () => copy("csv") },
      { label: "Copiar como JSON", run: () => copy("json") },
      { label: "Copiar como Markdown", run: () => copy("markdown") },
      { label: "Copiar como SQL INSERT", run: () => copy("insert") },
      { label: "Copiar como lista IN (…)", run: () => copy("in") },
      { label: "Copiar como WHERE", run: () => copy("where") },
      { separator: true },
      { label: "Ver valor", hint: "Mayús+Intro", icon: "eye", run: () => activate() },
    ];
    if (props.onFilter) {
      items.push(
        { separator: true },
        { label: "Filtrar por este valor", icon: "filter", run: () => quickFilter("eq") },
        { label: "Excluir este valor", run: () => quickFilter("ne") },
        { label: "Contiene este texto", run: () => quickFilter("contains") },
        { label: "Es NULL", run: () => quickFilter("null") },
        { label: "No es NULL", run: () => quickFilter("not-null") },
      );
    }
    if (props.editable) {
      items.push(
        { separator: true },
        { label: "Editar celda", hint: "F2", run: () => focus() && beginEdit(focus()!) },
        { label: "Poner a NULL", hint: "Ctrl+Mayús+N", run: setNull },
        { label: "Añadir fila", hint: "Alt+Insert", icon: "plus", run: () => props.onInsert?.() },
        { label: "Clonar fila", hint: "Ctrl+D", run: () => focus() && props.onClone?.(ordered()[focus()!.row]) },
        { label: many > 1 ? `Eliminar ${many} filas` : "Eliminar fila", hint: "Supr", icon: "trash", danger: true, run: () => props.onDelete?.(selectedRows()) },
      );
    }
    items.push({ separator: true }, { label: "Ajustar todas las columnas", run: () => autofit() });
    if (props.onExport) items.push({ label: "Exportar…", icon: "download", run: () => props.onExport?.() });
    openMenu(event, items);
  }

  function activate() {
    const f = focus();
    if (!f) return;
    props.onActivate?.(ordered()[f.row], f.col);
  }

  function nextMatch(step = 1) {
    const query = search()?.toLowerCase();
    if (!query) return;
    const rows = ordered();
    const cols = props.columns.length;
    const total = rows.length * cols;
    const f = focus() ?? { row: 0, col: -1 };
    let index = f.row * cols + f.col;
    for (let i = 0; i < total; i++) {
      index = (index + step + total) % total;
      const vr = Math.floor(index / cols);
      const col = index % cols;
      const cell = unwrap(props.rows)[rows[vr]]?.[col];
      if (!isNullCell(cell) && cellText(cell).toLowerCase().includes(query)) {
        setCursor({ row: vr, col });
        return;
      }
    }
  }

  // ------------------------------------------------------------ keyboard

  function onKey(event: KeyboardEvent) {
    if (editor()) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const f = focus();
    const page = Math.max(1, Math.floor(((scroller?.clientHeight ?? 300) - HEAD_H) / rowH()) - 1);
    const lastRow = ordered().length - 1;
    const lastCol = props.columns.length - 1;
    const move = (pos: Pos) => {
      event.preventDefault();
      setCursor(pos, event.shiftKey);
    };
    const key = event.key;
    if (ctrl && key.toLowerCase() === "c") {
      event.preventDefault();
      copy(event.shiftKey ? "tsv-head" : "tsv");
      return;
    }
    if (ctrl && key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (ctrl && key === "Enter" && props.onSave) {
      event.preventDefault();
      props.onSave();
      return;
    }
    if (ctrl && key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setSearch(search() ?? "");
      queueMicrotask(() => searchInput?.select());
      return;
    }
    if (key === "F3") {
      event.preventDefault();
      nextMatch(event.shiftKey ? -1 : 1);
      return;
    }
    if (ctrl && event.shiftKey && key.toLowerCase() === "n") {
      event.preventDefault();
      setNull();
      return;
    }
    if (ctrl && key.toLowerCase() === "d" && props.editable && f) {
      event.preventDefault();
      props.onClone?.(ordered()[f.row]);
      return;
    }
    if (event.altKey && key === "Insert" && props.editable) {
      event.preventDefault();
      props.onInsert?.();
      return;
    }
    if (key === "Escape" && search() !== null) {
      setSearch(null);
      return;
    }
    if (!f) {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp", "Tab"].includes(key)) move({ row: 0, col: 0 });
      return;
    }
    switch (key) {
      case "ArrowDown":
        return move({ row: ctrl ? lastRow : f.row + 1, col: f.col });
      case "ArrowUp":
        return move({ row: ctrl ? 0 : f.row - 1, col: f.col });
      case "ArrowRight":
        return move({ row: f.row, col: ctrl ? lastCol : f.col + 1 });
      case "ArrowLeft":
        return move({ row: f.row, col: ctrl ? 0 : f.col - 1 });
      case "PageDown":
        return move({ row: f.row + page, col: f.col });
      case "PageUp":
        return move({ row: f.row - page, col: f.col });
      case "Home":
        return move(ctrl ? { row: 0, col: 0 } : { row: f.row, col: 0 });
      case "End":
        return move(ctrl ? { row: lastRow, col: lastCol } : { row: f.row, col: lastCol });
      case "Tab":
        event.preventDefault();
        setCursor(event.shiftKey ? { row: f.col === 0 ? f.row - 1 : f.row, col: f.col === 0 ? lastCol : f.col - 1 } : { row: f.col === lastCol ? f.row + 1 : f.row, col: f.col === lastCol ? 0 : f.col + 1 });
        return;
      case "Enter":
        event.preventDefault();
        if (event.shiftKey || !props.editable) activate();
        else beginEdit(f);
        return;
      case "F2":
        event.preventDefault();
        beginEdit(f);
        return;
      case "Delete":
        if (props.onDelete && props.editable) {
          event.preventDefault();
          props.onDelete(selectedRows());
        }
        return;
    }
    if (props.editable && key.length === 1 && !ctrl && !event.altKey) {
      event.preventDefault();
      beginEdit(f, key);
    }
  }

  // ------------------------------------------------------------ lifecycle

  onMount(() => {
    props.api?.({
      deleteSelected: () => {
        if (props.onDelete && props.editable && sel()) props.onDelete(selectedRows());
        root?.focus({ preventScroll: true });
      },
      focus: () => root?.focus({ preventScroll: true }),
    });
    refreshPalette();
    const ro = new ResizeObserver(() => {
      if (scroller) setViewport({ w: scroller.clientWidth, h: scroller.clientHeight });
      schedule();
    });
    if (scroller) ro.observe(scroller);
    const mo = new MutationObserver(() => {
      refreshPalette();
      schedule();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "data-density"] });
    const up = () => onMouseUp();
    window.addEventListener("mouseup", up);
    const move = (event: MouseEvent) => {
      if (drag) onMouseMove(event);
    };
    window.addEventListener("mousemove", move);
    onCleanup(() => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("mouseup", up);
      window.removeEventListener("mousemove", move);
      if (frame) cancelAnimationFrame(frame);
    });
  });

  createEffect(
    on(
      () => [props.resetKey, props.columns] as const,
      () => {
        setLocalSort(null);
        setAnchor(null);
        setFocus(null);
        setEditor(null);
        if (scroller) {
          scroller.scrollTop = 0;
          scroller.scrollLeft = 0;
        }
        setScroll({ x: 0, y: 0 });
        refreshPalette();
        setWidths(measureWidths());
      },
    ),
  );

  createEffect(() => {
    props.rows;
    props.rows.length;
    props.deleted?.length;
    props.edits && Object.keys(props.edits).length;
    props.hasMore;
    props.loading;
    ordered();
    scroll();
    viewport();
    widths();
    anchor();
    focus();
    sort();
    hoverCol();
    search();
    state.settings.zebra;
    state.settings.density;
    schedule();
  });

  // Selection statistics for the status bar.
  createEffect(() => {
    const s = sel();
    if (!s || (s.r1 === s.r2 && s.c1 === s.c2)) {
      setState("gridStats", null);
      return;
    }
    const rows = ordered();
    let cells = 0;
    let numeric = 0;
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    const distinct = new Set<string>();
    const budget = 250_000;
    outer: for (let vr = s.r1; vr <= s.r2; vr++) {
      const row = unwrap(props.rows)[rows[vr]];
      for (let c = s.c1; c <= s.c2; c++) {
        if (cells++ > budget) break outer;
        const cell = row?.[c];
        if (isNullCell(cell)) continue;
        if (distinct.size < 10_000) distinct.add(cellText(cell));
        const n = typeof cell === "number" ? cell : props.columns[c]?.kind === "number" ? Number(cell) : NaN;
        if (!Number.isNaN(n) && Number.isFinite(n)) {
          numeric++;
          sum += n;
          min = min === null ? n : Math.min(min, n);
          max = max === null ? n : Math.max(max, n);
        }
      }
    }
    const stats: GridStats = { cells, rows: s.r2 - s.r1 + 1, numeric, sum, min, max, distinct: distinct.size };
    setState("gridStats", stats);
  });

  createEffect(() => {
    const f = focus();
    if (!f) return;
    const source = ordered()[f.row];
    const col = props.columns[f.col];
    if (source === undefined || !col) return;
    if (state.inspectorOpen && (state.inspectorMode === "value" || state.inspectorMode === "record")) {
      setState("inspect", { column: col.name, typeName: col.typeName, value: unwrap(props.rows)[source]?.[f.col] ?? null });
      setState("record", { columns: props.columns, row: unwrap(props.rows)[source] ?? [], index: source });
    }
  });

  onCleanup(() => setState("gridStats", null));

  const editorBox = () => {
    const current = editor();
    if (!current) return null;
    const xs = colX();
    return {
      left: xs[current.col] - scroll().x,
      top: HEAD_H + current.row * rowH() - scroll().y,
      width: widths()[current.col],
      height: rowH(),
    };
  };

  return (
    <div class="grid" ref={root} tabIndex={0} onKeyDown={onKey} onContextMenu={contextMenu}>
      <canvas ref={canvas} class="grid-canvas" />
      <div
        class="grid-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          setScroll({ x: el.scrollLeft, y: el.scrollTop });
          if (props.hasMore && !props.loading && el.scrollTop + el.clientHeight > el.scrollHeight - rowH() * 8) props.onNeedMore?.();
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onLeave}
        onDblClick={onDoubleClick}
      >
        <div class="grid-sizer" style={{ width: `${contentW()}px`, height: `${contentH()}px` }} />
      </div>
      <Show when={editorBox()}>
        {(box) => (
          <div class="cell-editor" style={{ left: `${box().left}px`, top: `${box().top}px`, width: `${Math.max(box().width, 160)}px`, height: `${box().height}px` }}>
            <input
              value={editor()!.value}
              spellcheck={false}
              onInput={(event) => setEditor({ ...editor()!, value: event.currentTarget.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                const current = editor()!;
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEditor(current.value, { row: current.row + 1, col: current.col });
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  commitEditor(current.value, { row: current.row, col: current.col + (event.shiftKey ? -1 : 1) });
                } else if (event.key === "Escape") {
                  setEditor(null);
                  root?.focus({ preventScroll: true });
                } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") {
                  event.preventDefault();
                  commitEditor(null);
                }
              }}
              onBlur={() => editor() && commitEditor(editor()!.value)}
            />
            <button type="button" title="Poner a NULL (Ctrl+Mayús+N)" onMouseDown={(event) => { event.preventDefault(); commitEditor(null); }}>NULL</button>
          </div>
        )}
      </Show>
      <Show when={search() !== null}>
        <div class="grid-search">
          <input
            ref={searchInput}
            placeholder="Buscar en resultados"
            value={search() ?? ""}
            onInput={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") nextMatch(event.shiftKey ? -1 : 1);
              if (event.key === "Escape") {
                setSearch(null);
                root?.focus();
              }
            }}
          />
          <button type="button" title="Anterior (Mayús+F3)" onClick={() => nextMatch(-1)}>↑</button>
          <button type="button" title="Siguiente (F3)" onClick={() => nextMatch(1)}>↓</button>
          <button type="button" title="Cerrar (Esc)" onClick={() => setSearch(null)}>✕</button>
        </div>
      </Show>
      <Show when={!props.rows.length && !props.loading}>
        <div class="grid-empty">Sin filas</div>
      </Show>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
