// Layout of an entity-relationship diagram: tables in columns by dependency (a table sits to the right of the
// tables its foreign keys point to), ordered to keep relations short; tables without relations go in a grid
// below. Pure and deterministic, so dev/erlayout-check.ts can test it.

export interface ErColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  nullable: boolean;
}

export interface ErTable {
  /** Unique within the diagram (schema.name). */
  id: string;
  name: string;
  schema: string;
  columns: ErColumn[];
}

export interface ErEdge {
  name: string;
  /** The table with the foreign key. */
  from: string;
  /** The referenced table. */
  to: string;
  fromCols: string[];
  toCols: string[];
}

export interface ErBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ER = {
  header: 32,
  row: 20,
  pad: 8,
  maxRows: 16,
  gapX: 110,
  gapY: 36,
  margin: 40,
};

/** Rows shown for a table: every column up to maxRows, then a "+N más" line. */
export function visibleRows(table: ErTable): number {
  return table.columns.length > ER.maxRows ? ER.maxRows + 1 : Math.max(1, table.columns.length);
}

export function boxSize(table: ErTable): { w: number; h: number } {
  const longest = Math.max(table.name.length * 7.6 + 40, ...table.columns.slice(0, ER.maxRows).map((c) => c.name.length * 7 + Math.min(c.type.length, 18) * 6.2 + 56));
  return { w: Math.round(Math.min(340, Math.max(190, longest))), h: ER.header + visibleRows(table) * ER.row + ER.pad };
}

/** Y (relative to the box) of a column's row centre, or of the header when the column is not shown. */
export function columnY(table: ErTable, column: string): number {
  const index = table.columns.findIndex((c) => c.name === column);
  if (index < 0 || index >= ER.maxRows) return ER.header / 2;
  return ER.header + index * ER.row + ER.row / 2;
}

export function layoutEr(tables: ErTable[], edges: ErEdge[]): { boxes: Record<string, ErBox>; width: number; height: number } {
  const ids = new Set(tables.map((t) => t.id));
  const links = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const parents = new Map<string, string[]>();
  const neighbours = new Map<string, Set<string>>();
  for (const t of tables) {
    parents.set(t.id, []);
    neighbours.set(t.id, new Set());
  }
  for (const e of links) {
    parents.get(e.from)!.push(e.to);
    neighbours.get(e.from)!.add(e.to);
    neighbours.get(e.to)!.add(e.from);
  }
  const related = tables.filter((t) => neighbours.get(t.id)!.size > 0);
  const alone = tables.filter((t) => neighbours.get(t.id)!.size === 0);

  // Layer = longest chain of references below the table (cycles are cut where they are found).
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of parents.get(id)!) d = Math.max(d, depth(p) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const t of related) depth(t.id);
  const layers: string[][] = [];
  for (const t of [...related].sort((a, b) => a.name.localeCompare(b.name))) {
    const l = layer.get(t.id)!;
    (layers[l] ??= []).push(t.id);
  }
  const compact = layers.filter((l) => l?.length);

  // Barycentre sweeps: each table moves towards the average position of its neighbours in the layer next door.
  const position = new Map<string, number>();
  const index = () => compact.forEach((l) => l.forEach((id, i) => position.set(id, i)));
  index();
  for (let pass = 0; pass < 6; pass++) {
    const order = pass % 2 === 0 ? compact.map((_, i) => i) : compact.map((_, i) => compact.length - 1 - i);
    for (const li of order) {
      const weight = (id: string) => {
        const around = [...neighbours.get(id)!].map((n) => position.get(n)!).filter((v) => v !== undefined);
        return around.length ? around.reduce((a, b) => a + b, 0) / around.length : position.get(id)!;
      };
      compact[li].sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
      index();
    }
  }

  const byId = new Map(tables.map((t) => [t.id, t]));
  const boxes: Record<string, ErBox> = {};
  let x = ER.margin;
  let height = ER.margin;
  // A very full layer (a hub referenced by many tables) wraps into several columns instead of one endless one.
  const perColumn = Math.max(10, Math.ceil(Math.sqrt(related.length) * 2));
  const columns = compact.flatMap((l) => Array.from({ length: Math.ceil(l.length / perColumn) }, (_, i) => l.slice(i * perColumn, (i + 1) * perColumn)));
  for (const l of columns) {
    const sizes = l.map((id) => boxSize(byId.get(id)!));
    const colWidth = Math.max(...sizes.map((s) => s.w));
    let y = ER.margin;
    l.forEach((id, i) => {
      boxes[id] = { x, y, w: sizes[i].w, h: sizes[i].h };
      y += sizes[i].h + ER.gapY;
    });
    height = Math.max(height, y);
    x += colWidth + ER.gapX;
  }
  let width = Math.max(x - ER.gapX + ER.margin, ER.margin * 2);

  // Tables without relations: a grid under the rest (as wide as the related part, at least three columns).
  if (alone.length) {
    const sorted = [...alone].sort((a, b) => a.name.localeCompare(b.name));
    const sizes = sorted.map(boxSize);
    const cell = Math.max(...sizes.map((s) => s.w)) + 40;
    const perRow = Math.max(3, Math.floor((width - ER.margin * 2 + 40) / cell));
    let y = related.length ? height + ER.gapY : ER.margin;
    for (let start = 0; start < sorted.length; start += perRow) {
      const rowSizes = sizes.slice(start, start + perRow);
      sorted.slice(start, start + perRow).forEach((t, i) => {
        boxes[t.id] = { x: ER.margin + i * cell, y, w: rowSizes[i].w, h: rowSizes[i].h };
      });
      y += Math.max(...rowSizes.map((s) => s.h)) + ER.gapY;
    }
    height = y;
    width = Math.max(width, ER.margin * 2 + Math.min(perRow, sorted.length) * cell - 40);
  }
  return { boxes, width, height: height - ER.gapY + ER.margin };
}

/** A smooth connector from the FK column on one box to the referenced column on the other. */
export function edgePath(from: ErBox, fromY: number, to: ErBox, toY: number): string {
  const y1 = from.y + fromY;
  const y2 = to.y + toY;
  if (Math.abs(from.x - to.x) < 5) {
    // Same column (or a table referencing itself): loop out on the right; a loop to the same row opens up.
    const out = Math.max(from.x + from.w, to.x + to.w) + 40;
    const lift = Math.abs(y1 - y2) < 10 ? 24 : 0;
    return `M ${from.x + from.w} ${y1} C ${out} ${y1 - lift}, ${out} ${y2 + lift}, ${to.x + to.w} ${y2}`;
  }
  // Leave from the side that faces the other table.
  const rightward = to.x + to.w / 2 > from.x + from.w / 2;
  const x1 = rightward ? from.x + from.w : from.x;
  const x2 = rightward ? to.x : to.x + to.w;
  const bend = Math.max(40, Math.abs(x2 - x1) / 2);
  const c1 = rightward ? x1 + bend : x1 - bend;
  const c2 = rightward ? x2 - bend : x2 + bend;
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}
