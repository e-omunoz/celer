// Quick checks for src/erLayout.ts: node --experimental-strip-types dev/erlayout-check.ts
import assert from "node:assert/strict";
import { boxSize, columnY, edgePath, ER, layoutEr, type ErEdge, type ErTable } from "../src/erLayout.ts";

const col = (name: string, pk = false, fk = false) => ({ name, type: "int", pk, fk, nullable: !pk });
const table = (name: string, columns = [col("id", true)]): ErTable => ({ id: `public.${name}`, name, schema: "public", columns });
const edge = (from: string, to: string): ErEdge => ({ name: `${from}_${to}_fk`, from: `public.${from}`, to: `public.${to}`, fromCols: [`${to}_id`], toCols: ["id"] });

const tables = [table("countries"), table("customers"), table("orders"), table("order_lines"), table("products"), table("logs"), table("settings")];
const edges = [edge("customers", "countries"), edge("orders", "customers"), edge("order_lines", "orders"), edge("order_lines", "products")];
const { boxes, width, height } = layoutEr(tables, edges);

// Every table is placed, inside the canvas.
for (const t of tables) {
  const b = boxes[t.id];
  assert.ok(b, `${t.name} is placed`);
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= width && b.y + b.h <= height, `${t.name} fits`);
}
// Referenced tables to the left of the tables that point to them.
assert.ok(boxes["public.countries"].x < boxes["public.customers"].x);
assert.ok(boxes["public.customers"].x < boxes["public.orders"].x);
assert.ok(boxes["public.orders"].x < boxes["public.order_lines"].x);
assert.ok(boxes["public.products"].x < boxes["public.order_lines"].x);
// Tables without relations go below the rest.
const relatedBottom = Math.max(...["countries", "customers", "orders", "order_lines", "products"].map((n) => boxes[`public.${n}`].y + boxes[`public.${n}`].h));
assert.ok(boxes["public.logs"].y > relatedBottom && boxes["public.settings"].y > relatedBottom);
// No two boxes overlap.
const all = Object.values(boxes);
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const a = all[i];
    const b = all[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!overlap, `boxes ${i} and ${j} overlap`);
  }
}
// Cycles and self references do not hang or break the layout.
const cyc = layoutEr([table("a"), table("b"), table("c")], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "a")]);
assert.equal(Object.keys(cyc.boxes).length, 3);
// Only unrelated tables, and an empty schema.
assert.equal(Object.keys(layoutEr([table("x"), table("y")], []).boxes).length, 2);
assert.deepEqual(layoutEr([], []).boxes, {});
// Long tables are cut at maxRows plus a "+N más" line; columns beyond that point at the header.
const wide = table("wide", Array.from({ length: 30 }, (_, i) => col(`c${i}`)));
assert.equal(boxSize(wide).h, ER.header + (ER.maxRows + 1) * ER.row + ER.pad);
assert.equal(columnY(wide, "c29"), ER.header / 2);
assert.equal(columnY(wide, "c0"), ER.header + ER.row / 2);
// Paths are valid SVG path data.
assert.match(edgePath(boxes["public.orders"], 40, boxes["public.customers"], 40), /^M [\d.]+ [\d.]+ C /);
console.log("erlayout-check: all good");
