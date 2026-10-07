import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { cellText, isNullCell, selectionText } from "../sql";
import type { Cell, ColumnInfo } from "../types";

const ROW_H = 22;
const HEAD_H = 28;
const GUTTER = 46;

export interface GridSelection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function DataGrid(props: {
  columns: ColumnInfo[];
  rows: Cell[][];
  deleted?: number[];
  edits?: Record<string, string | null>;
  insertStart?: number;
  hasMore?: boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: string | null) => void;
  onNeedMore?: () => void;
  onView?: (text: string) => void;
  onDelete?: (rows: number[]) => void;
}) {
  let host: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const [scroll, setScroll] = createSignal({ x: 0, y: 0 });
  const [widths, setWidths] = createSignal<number[]>([]);
  const [selection, setSelection] = createSignal<GridSelection | null>(null);
  const [sort, setSort] = createSignal<{ col: number; dir: 1 | -1 } | null>(null);
  const [editor, setEditor] = createSignal<{ row: number; col: number; value: string; x: number; y: number; w: number } | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  let drag: { col: number; startX: number; startW: number } | null = null;
  let selecting = false;

  const order = () => {
    const current = sort();
    const indexes = props.rows.map((_, index) => index);
    if (!current) return indexes;
    const { col, dir } = current;
    indexes.sort((a, b) => {
      const left = props.rows[a]?.[col];
      const right = props.rows[b]?.[col];
      if (isNullCell(left) && isNullCell(right)) return 0;
      if (isNullCell(left)) return 1;
      if (isNullCell(right)) return -1;
      if (typeof left === "number" && typeof right === "number") return (left - right) * dir;
      return cellText(left).localeCompare(cellText(right), "es", { numeric: true }) * dir;
    });
    return indexes;
  };

  const totalWidth = () => GUTTER + widths().reduce((sum, width) => sum + width, 0);

  function ensureWidths() {
    if (widths().length === props.columns.length) return;
    setWidths(props.columns.map((col) => Math.min(240, Math.max(84, col.name.length * 8 + 28))));
  }

  function paint() {
    if (!canvas || !host) return;
    ensureWidths();
    const dpr = window.devicePixelRatio || 1;
    const width = host.clientWidth;
    const height = host.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    const fg = styles.getPropertyValue("--text").trim() || styles.getPropertyValue("--fg").trim();
    const muted = styles.getPropertyValue("--text-muted").trim() || styles.getPropertyValue("--muted").trim();
    const faint = styles.getPropertyValue("--text-faint").trim() || muted;
    const line = styles.getPropertyValue("--grid-line").trim();
    const head = styles.getPropertyValue("--grid-head").trim();
    const sel = styles.getPropertyValue("--grid-sel").trim();
    const alt = styles.getPropertyValue("--row-alt").trim();
    const bg = styles.getPropertyValue("--surface").trim() || styles.getPropertyValue("--bg-elev").trim();
    const modified = styles.getPropertyValue("--grid-modified").trim();
    const insertedBg = styles.getPropertyValue("--grid-inserted").trim();
    const deletedBg = styles.getPropertyValue("--grid-deleted").trim();
    const warning = styles.getPropertyValue("--warning").trim();
    const mono = styles.getPropertyValue("--mono").trim() || "monospace";
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.font = `12.5px ${mono}`;
    ctx.textBaseline = "middle";
    const cols = widths();
    const indexes = order();
    const view = scroll();
    const start = Math.max(0, Math.floor(view.y / ROW_H));
    const end = Math.min(indexes.length, start + Math.ceil((height - HEAD_H) / ROW_H) + 1);
    const selected = selection();
    for (let viewRow = start; viewRow < end; viewRow++) {
      const source = indexes[viewRow];
      const y = HEAD_H + viewRow * ROW_H - view.y;
      const deleted = props.deleted?.includes(source);
      const inserted = props.insertStart !== undefined && source >= props.insertStart;
      ctx.fillStyle = deleted ? deletedBg || "rgba(248, 81, 73, 0.14)" : inserted ? insertedBg || alt : viewRow % 2 ? alt : bg;
      ctx.fillRect(0, y, width, ROW_H);
      let x = GUTTER - view.x;
      for (let col = 0; col < props.columns.length; col++) {
        const w = cols[col] ?? 100;
        if (x + w > GUTTER && x < width) {
          const inside =
            selected &&
            viewRow >= Math.min(selected.r1, selected.r2) &&
            viewRow <= Math.max(selected.r1, selected.r2) &&
            col >= Math.min(selected.c1, selected.c2) &&
            col <= Math.max(selected.c1, selected.c2);
          if (inside) {
            ctx.fillStyle = sel;
            ctx.fillRect(x, y, w, ROW_H);
          }
          const raw = props.rows[source]?.[col];
          const edited = Boolean(props.edits && Object.prototype.hasOwnProperty.call(props.edits, `${source}:${col}`));
          if (edited) {
            ctx.fillStyle = modified || sel;
            ctx.fillRect(x, y, w, ROW_H);
            ctx.fillStyle = warning || fg;
            ctx.fillRect(x, y, 2, ROW_H);
          }
          const alignRight = props.columns[col]?.kind === "number";
          const isNull = isNullCell(raw);
          ctx.fillStyle = isNull ? faint : fg;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 1, y, w - 2, ROW_H);
          ctx.clip();
          const label = isNull ? "NULL" : cellText(raw);
          ctx.font = `${deleted || isNull ? "italic " : ""}12.5px ${mono}`;
          const textX = alignRight ? x + w - 8 - ctx.measureText(label).width : x + 8;
          ctx.fillText(label, textX, y + ROW_H / 2);
          if (deleted) {
            ctx.strokeStyle = faint;
            ctx.beginPath();
            ctx.moveTo(textX, y + ROW_H / 2);
            ctx.lineTo(textX + ctx.measureText(label).width, y + ROW_H / 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.strokeStyle = line;
        ctx.beginPath();
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w, y + ROW_H);
        ctx.stroke();
        x += w;
      }
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(0, y + ROW_H);
      ctx.lineTo(width, y + ROW_H);
      ctx.stroke();
    }
    ctx.fillStyle = head;
    ctx.fillRect(0, 0, width, HEAD_H);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, HEAD_H);
    ctx.lineTo(width, HEAD_H);
    ctx.stroke();
    let x = GUTTER - view.x;
    ctx.font = `600 12px ${styles.getPropertyValue("--sans").trim() || "sans-serif"}`;
    for (let col = 0; col < props.columns.length; col++) {
      const w = cols[col] ?? 100;
      if (x + w > 0 && x < width) {
        ctx.fillStyle = fg;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, w - 4, HEAD_H);
        ctx.clip();
        const mark = sort()?.col === col ? (sort()!.dir === 1 ? " ↑" : " ↓") : "";
        ctx.fillText(props.columns[col].name + mark, x + 8, HEAD_H / 2);
        ctx.restore();
        ctx.fillStyle = line;
        ctx.fillRect(x + w - 1, 0, 1, HEAD_H);
      }
      x += w;
    }
    ctx.fillStyle = head;
    ctx.fillRect(0, 0, GUTTER, height);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(GUTTER, 0);
    ctx.lineTo(GUTTER, height);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = `11px ${styles.getPropertyValue("--sans").trim() || "sans-serif"}`;
    ctx.fillText("#", 16, HEAD_H / 2);
    for (let viewRow = start; viewRow < end; viewRow++) {
      const y = HEAD_H + viewRow * ROW_H - view.y;
      ctx.fillText(String(indexes[viewRow] + 1), 8, y + ROW_H / 2);
    }
  }

  function hit(event: MouseEvent) {
    const rect = canvas!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y < HEAD_H) {
      let cursor = GUTTER - scroll().x;
      for (let col = 0; col < widths().length; col++) {
        const w = widths()[col];
        if (Math.abs(x - (cursor + w)) < 5) return { type: "resize" as const, col };
        if (x >= cursor && x < cursor + w) return { type: "header" as const, col };
        cursor += w;
      }
      return { type: "header-miss" as const };
    }
    const viewRow = Math.floor((y - HEAD_H + scroll().y) / ROW_H);
    const source = order()[viewRow];
    if (source === undefined) return { type: "miss" as const };
    let cursor = GUTTER - scroll().x;
    for (let col = 0; col < widths().length; col++) {
      const w = widths()[col];
      if (x >= cursor && x < cursor + w) {
        return { type: "cell" as const, row: viewRow, source, col, x: cursor, y: HEAD_H + viewRow * ROW_H - scroll().y, w };
      }
      cursor += w;
    }
    return { type: "gutter" as const, row: viewRow, source };
  }

  function onMouseDown(event: MouseEvent) {
    const origin = event.target as HTMLElement | null;
    if (origin?.closest(".cell-editor, .menu, .more")) return;
    if (event.button !== 0) return;
    setMenu(null);
    const target = hit(event);
    if (target.type === "resize") {
      drag = { col: target.col, startX: event.clientX, startW: widths()[target.col] };
      return;
    }
    if (target.type === "header") {
      const current = sort();
      if (current?.col === target.col) setSort({ col: target.col, dir: current.dir === 1 ? -1 : 1 });
      else setSort({ col: target.col, dir: 1 });
      return;
    }
    if (target.type === "cell") {
      const previous = selection();
      if (event.shiftKey && previous) setSelection({ ...previous, r2: target.row, c2: target.col });
      else setSelection({ r1: target.row, c1: target.col, r2: target.row, c2: target.col });
      selecting = true;
      host?.focus();
    }
  }

  function onMouseMove(event: MouseEvent) {
    if (drag) {
      const next = widths().slice();
      next[drag.col] = Math.max(48, drag.startW + event.clientX - drag.startX);
      setWidths(next);
      return;
    }
    if (!selecting) return;
    const target = hit(event);
    if (target.type === "cell") {
      const current = selection();
      if (current) setSelection({ ...current, r2: target.row, c2: target.col });
    }
  }

  function onDoubleClick(event: MouseEvent) {
    const target = hit(event);
    if (target.type !== "cell") return;
    if (props.editable && props.onEdit && !props.deleted?.includes(target.source)) {
      const raw = props.rows[target.source]?.[target.col];
      setEditor({ row: target.source, col: target.col, value: isNullCell(raw) ? "" : cellText(raw), x: target.x, y: target.y, w: target.w });
      queueMicrotask(() => host?.querySelector<HTMLInputElement>(".cell-editor input")?.focus());
      return;
    }
    const raw = props.rows[target.source]?.[target.col];
    props.onView?.(isNullCell(raw) ? "NULL" : cellText(raw));
  }

  function onContext(event: MouseEvent) {
    event.preventDefault();
    setMenu({ x: event.offsetX, y: event.offsetY });
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    const maxY = Math.max(0, order().length * ROW_H - (host!.clientHeight - HEAD_H));
    const maxX = Math.max(0, totalWidth() - host!.clientWidth);
    const next = { ...scroll() };
    if (event.shiftKey) next.x = clamp(next.x + event.deltaY, 0, maxX);
    else {
      next.y = clamp(next.y + event.deltaY, 0, maxY);
      next.x = clamp(next.x + event.deltaX, 0, maxX);
    }
    setScroll(next);
    if (props.hasMore && next.y > maxY - 80) props.onNeedMore?.();
  }

  async function copy(format: "tsv" | "csv" | "sql") {
    const selected = selection();
    setMenu(null);
    if (!selected) return;
    const indexes = order();
    const r1 = Math.min(selected.r1, selected.r2);
    const r2 = Math.max(selected.r1, selected.r2);
    const rows = [];
    for (let viewRow = r1; viewRow <= r2; viewRow++) {
      const source = indexes[viewRow];
      if (source !== undefined) rows.push(props.rows[source] ?? []);
    }
    const text = selectionText(props.columns, rows, { ...selected, r1: 0, r2: rows.length - 1 }, format);
    await navigator.clipboard.writeText(text);
  }

  function onKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copy("tsv");
    }
    if (event.key === "Delete" && props.onDelete && selection()) {
      const selected = selection()!;
      const indexes = order();
      const rows: number[] = [];
      for (let viewRow = Math.min(selected.r1, selected.r2); viewRow <= Math.max(selected.r1, selected.r2); viewRow++) {
        if (indexes[viewRow] !== undefined) rows.push(indexes[viewRow]);
      }
      props.onDelete(rows);
    }
  }

  onMount(() => {
    host?.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(() => paint());
    if (host) observer.observe(host);
    const themeObserver = new MutationObserver(() => paint());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    onCleanup(() => {
      host?.removeEventListener("wheel", onWheel);
      observer.disconnect();
      themeObserver.disconnect();
    });
  });

  createEffect(() => {
    props.rows.length;
    props.columns.length;
    props.deleted?.length;
    scroll();
    widths();
    selection();
    sort();
    resolvedPaint();
  });

  function resolvedPaint() {
    queueMicrotask(paint);
  }

  function commitEditor(value: string | null) {
    const current = editor();
    if (!current) return;
    props.onEdit?.(current.row, current.col, value);
    setEditor(null);
  }

  return (
    <div class="grid-host" ref={host} tabIndex={0} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={() => { drag = null; selecting = false; }} onDblClick={onDoubleClick} onContextMenu={onContext} onKeyDown={onKey}>
      <canvas ref={canvas} />
      {editor() && (
        <div class="cell-editor" style={{ left: `${editor()!.x}px`, top: `${editor()!.y}px`, width: `${editor()!.w}px` }}>
          <input
            value={editor()!.value}
            onInput={(event) => setEditor({ ...editor()!, value: event.currentTarget.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                event.preventDefault();
                event.currentTarget.select();
                return;
              }
              if (event.key === "Enter") commitEditor(editor()!.value);
              if (event.key === "Escape") setEditor(null);
            }}
            onBlur={() => commitEditor(editor()?.value ?? null)}
          />
          <button type="button" title="NULL" onMouseDown={(event) => { event.preventDefault(); commitEditor(null); }}>∅</button>
        </div>
      )}
      {menu() && (
        <div class="menu" style={{ left: `${menu()!.x}px`, top: `${menu()!.y}px` }}>
          <button type="button" onClick={() => void copy("tsv")}>Copiar TSV</button>
          <button type="button" onClick={() => void copy("csv")}>Copiar CSV</button>
          <button type="button" onClick={() => void copy("sql")}>Copiar SQL</button>
          <button type="button" onClick={() => { const selected = selection(); setMenu(null); if (!selected) return; const source = order()[selected.r1]; const raw = props.rows[source]?.[selected.c1]; props.onView?.(isNullCell(raw) ? "NULL" : cellText(raw)); }}>Ver valor</button>
        </div>
      )}
      {props.hasMore && (
        <button class="more" type="button" onClick={() => props.onNeedMore?.()}>Cargar más filas</button>
      )}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
