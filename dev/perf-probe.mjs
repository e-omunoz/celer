// Loads all rows of `events`, then profiles one interaction with the V8 CPU profiler and prints the hottest
// functions. Usage: node dev/perf-probe.mjs <action>   (action: selectall | copy | column | edit | delete)
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const action = process.argv[2] || "selectall";
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(30); } return null; };
  const rowByText = (t) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === t);
  const pane = () => document.querySelector('.pane-host.active');
  const grid = () => pane().querySelector('.grid-scroll');
`;
const js = (code) => app.js(H + code);
const key = async (k, mods = 0, vk = { Enter: 13, Delete: 46, F2: 113 }[k] ?? k.toUpperCase().charCodeAt(0)) => {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
const click = async (x, y) => {
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => "TIMEOUT")]);

await js(`
  await until(() => document.querySelector('.companion.landed'), 15000);
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  if (!rowByText('events')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => rowByText('events')); }
  rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && [...pane().querySelectorAll('.data-toolbar .btn')].some((b) => b.textContent.includes('Cargar todo')));
  [...pane().querySelectorAll('.data-toolbar .btn')].find((b) => b.textContent.includes('Cargar todo')).click();
  await until(() => /200[.,]000 filas/.test(pane().querySelector('.data-toolbar .muted.small')?.textContent ?? ''));
`);
const box = await js(`const r = grid().getBoundingClientRect(); return { x: r.left, y: r.top };`);
await click(box.x + 180, box.y + 60);
await sleep(300);

await app.send("Profiler.enable");
await app.send("Profiler.setSamplingInterval", { interval: 200 });
await app.send("Profiler.start");
const t0 = Date.now();
if (action === "selectall") await key("a", 2);
else if (action === "copy") { await key("a", 2); await key("c", 2); }
else if (action === "column") await click(box.x + 300, box.y + 12);
else if (action === "edit") { await key("F2"); await app.send("Input.insertText", { text: "9" }); await key("Enter"); }
else if (action === "delete") { await key("a", 2); await key("Delete"); }
// Wait for the page to answer again (or give up).
const alive = await withTimeout(js(`return 'alive';`), 60000);
console.log(`${action}: page answered after ${Date.now() - t0} ms (${alive})`);
const res = await withTimeout(app.send("Profiler.stop"), 30000);
if (res === "TIMEOUT") { console.log("profiler stop timed out"); process.exit(1); }
const { nodes, samples, timeDeltas } = res.profile;
const self = new Map();
const byId = new Map(nodes.map((n) => [n.id, n]));
samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (timeDeltas[i] ?? 0)));
const agg = new Map();
for (const [id, us] of self) {
  const f = byId.get(id).callFrame;
  const name = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  agg.set(name, (agg.get(name) ?? 0) + us);
}
[...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([n, us]) => console.log(`${String(Math.round(us / 1000)).padStart(7)} ms  ${n}`));
writeFileSync(`${process.env.TEMP}/celer-${action}.cpuprofile`, JSON.stringify(res.profile));
app.close();
process.exit(0);
