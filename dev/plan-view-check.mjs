// The execution plan view against the test databases: Ctrl+Shift+E shows a tree in a "Plan" result tab (the
// results stay), "Analizar" measures it (PostgreSQL), and MariaDB / SQLite plans read too.
// Saves screenshots to <outDir>. Needs the desktop app (dev/run-desktop.ps1).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const out = process.argv[2] || join(process.env.TEMP || "/tmp", "celer-plan");
mkdirSync(out, { recursive: true });
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
  const conn = (name) => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes(name));
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 400)}`}`);
  if (!ok) failed++;
};
async function press(key, mods = 0) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = { Enter: 13, Escape: 27, Delete: 46 }[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
async function consoleFor(name, sql) {
  await js(`
    const c = conn(${JSON.stringify(name)});
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    if (!c.classList.contains('connected')) { c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => c.classList.contains('connected')); }
    await sleep(300);
  `);
  await press("l", 2 | 8);
  await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300); pane().querySelector('.cm-content').focus();`);
  await app.send("Input.insertText", { text: sql });
  await press("Escape");
}
const planState = () => js(`return { tab: !!pane().querySelector('.plan-view'), rows: [...pane().querySelectorAll('.plan-row .plan-op b')].map((b) => b.textContent), tags: [...pane().querySelectorAll('.plan-head .tag')].map((t) => t.textContent), warnings: pane().querySelectorAll('.plan-row.warn').length, err: pane().querySelector('.rtab.error') ? pane().querySelector('.output')?.textContent ?? 'error' : '' };`);

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'));`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");

// PostgreSQL: results first, then the plan; the results stay.
await consoleFor("Postgres local", "SELECT c.first_name, count(*) FROM customers c JOIN events e ON e.customer_id = c.id WHERE e.amount > 100 GROUP BY c.first_name ORDER BY 2 DESC");
await press("Enter", 2);
await js(`await until(() => pane().querySelector('.rtab.on')?.textContent.includes('Resultado'));`);
await press("e", 2 | 8);
await js(`await until(() => pane().querySelector('.plan-view')); await sleep(300);`);
const pg = await planState();
check("PostgreSQL: Ctrl+Shift+E shows the plan tree", pg.tab && pg.rows.length >= 5 && pg.rows.some((r) => /Join/.test(r)), JSON.stringify(pg));
check("estimated plan says so", pg.tags.includes("estimado"), JSON.stringify(pg.tags));
const stays = await js(`return [...pane().querySelectorAll('.rtab')].map((t) => t.textContent);`);
check("the results stay next to the plan", stays.some((t) => t.includes("Resultado")) && stays.some((t) => t.includes("Plan")), JSON.stringify(stays));
writeFileSync(join(out, "plan-pg.png"), await app.shot());
await js(`[...pane().querySelectorAll('.plan-head button')].find((b) => /Analizar/.test(b.textContent))?.click(); await sleep(200); await until(() => [...pane().querySelectorAll('.plan-head .tag')].some((t) => /ANALYZE/.test(t.textContent)), 20000); await sleep(300);`);
const pga = await planState();
check("Analizar runs EXPLAIN ANALYZE (real times)", pga.tags.some((t) => /ANALYZE/.test(t)), JSON.stringify(pga));
const measured = await js(`return [...pane().querySelectorAll('.plan-row')].map((r) => [...r.querySelectorAll('.plan-num')].map((c) => c.textContent));`);
check("every step shows its real rows and time", measured.length >= 5 && measured.every((cells) => cells.length === 3 && cells[1] !== "—" && cells[2] !== "—"), JSON.stringify(measured.slice(0, 3)));
await js(`pane().querySelector('.plan-row').click(); await sleep(200);`);
check("a click shows a step's details", (await js(`return !!pane().querySelector('.plan-detail dl');`)) === true);
writeFileSync(join(out, "plan-pg-analyze.png"), await app.shot());

// MariaDB and SQLite.
await consoleFor("MariaDB local", "SELECT c.id, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY 2 DESC");
await press("e", 2 | 8);
await js(`await until(() => pane().querySelector('.plan-view') || pane().querySelector('.rtab.error'));`);
const my = await planState();
check("MariaDB plan reads", my.tab && my.rows.includes("Consulta") && my.rows.some((r) => /índice|Recorrido/.test(r)), JSON.stringify(my));
await consoleFor("Tienda (SQLite)", "SELECT c.nombre, count(*) FROM clientes c JOIN pedidos p ON p.cliente_id = c.id WHERE p.estado = 'pagado' GROUP BY c.id ORDER BY 2 DESC");
await press("e", 2 | 8);
await js(`await until(() => pane().querySelector('.plan-view') || pane().querySelector('.rtab.error'));`);
const sq = await planState();
check("SQLite plan reads, with its temp B-tree warnings", sq.tab && sq.rows.some((r) => /Búsqueda/.test(r)) && sq.warnings >= 1, JSON.stringify(sq));
writeFileSync(join(out, "plan-sqlite.png"), await app.shot());
app.close();
process.exit(failed ? 1 : 0);
