// Schema comparison against "Postgres local" in the desktop app (dev/run-desktop.ps1): two schemas with known
// differences, marked and compared from the explorer menu; the synchronization script is opened in a console,
// run, and a second comparison leaves only what the script deliberately does not touch (drops).
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const menuItem = (re) => until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 3000);
  const menuOn = async (row, re) => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 })); const item = await menuItem(re); if (!item) { document.querySelector('.menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return false; } item.click(); return true; };
  const pane = () => document.querySelector('.pane-host.active');
  const sql = async (text) => {
    const c = (await inv('list_connections')).find((x) => x.name === 'Postgres local');
    const s = await inv('open_session', { connId: c.id, password: null });
    try { return await inv('execute', { sessionId: s.sessionId, sql: text, fetch: 100 }); } finally { await inv('close_session', { sessionId: s.sessionId }); }
  };
  const report = () => {
    const d = document.querySelector('.schema-compare');
    if (!d) return null;
    return {
      loading: !!d.querySelector('.sc-progress'),
      error: d.querySelector('.import-warn')?.textContent ?? '',
      filters: [...d.querySelectorAll('.sc-filters button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
      items: [...d.querySelectorAll('.sc-item')].map((b) => b.querySelector('.sc-dot').className.replace('sc-dot ', '') + ':' + b.querySelector('span').textContent),
      cols: [...d.querySelectorAll('.sc-cols tbody tr')].map((r) => r.className + ':' + r.querySelector('code').textContent),
      sides: [...d.querySelectorAll('.sc-side b')].map((b) => b.textContent),
    };
  };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 500)}`}`);
  if (!ok) failed++;
};
async function press(key, mods = 0) {
  const vk = { Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, modifiers: mods });
}

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await js(`
  await sql("DROP SCHEMA IF EXISTS sc_a CASCADE; DROP SCHEMA IF EXISTS sc_b CASCADE; CREATE SCHEMA sc_a; CREATE SCHEMA sc_b; " +
    "CREATE TABLE sc_a.clientes (id int PRIMARY KEY, nombre varchar(120) NOT NULL, email text, vip boolean); " +
    "CREATE TABLE sc_a.pedidos (id int PRIMARY KEY, total numeric(10,2)); " +
    "CREATE TABLE sc_a.facturas (id int PRIMARY KEY, importe numeric(12,2) NOT NULL); " +
    "CREATE TABLE sc_b.clientes (id int PRIMARY KEY, nombre varchar(100) NOT NULL, email text NOT NULL, legacy text); " +
    "CREATE TABLE sc_b.pedidos (id int PRIMARY KEY, total decimal(10, 2)); " +
    "CREATE TABLE sc_b.auditoria (id bigint PRIMARY KEY); INSERT INTO sc_b.clientes VALUES (1, 'Ana', 'ana@x.es', 'L1');");
  if (!connRow().classList.contains('connected')) { connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => connRow().classList.contains('connected')); }
  await until(() => rowByText('public'));
  await menuOn(connRow(), /^Actualizar/);
  await until(() => rowByText('sc_a') && rowByText('sc_b'));
`);
const marked = await js(`return await menuOn(rowByText('sc_a'), /^Marcar para comparar/);`);
check("a schema can be marked from its menu", marked);
const offered = await js(`
  rowByText('sc_b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }));
  const item = await menuItem(/^Comparar con/);
  const label = item?.textContent ?? '';
  item?.click();
  return label;
`);
check("another schema offers 'Comparar con' the marked one", /Comparar con «Postgres local · celer · sc_a»/.test(offered), offered);
const first = await js(`await until(() => { const r = report(); return r && !r.loading; }, 20000); await sleep(200); return report();`);
check("the comparison opens with source and target", JSON.stringify(first?.sides) === JSON.stringify(["Postgres local · celer · sc_a", "Postgres local · celer · sc_b"]), JSON.stringify(first));
check("tables by status, differences first", JSON.stringify(first?.items) === JSON.stringify(["different:clientes", "only-source:facturas", "only-target:auditoria", "same:pedidos"]), JSON.stringify(first?.items));
check("counts per group", JSON.stringify(first?.filters) === JSON.stringify(["Todas 4", "Diferentes 1", "Solo en el origen 1", "Solo en el destino 1", "Iguales 1"]), JSON.stringify(first?.filters));
check("the different table shows its columns (decimal = numeric is not a difference)", JSON.stringify(first?.cols) === JSON.stringify(["type:nombre", "nullable:email", "only-source:vip", "only-target:legacy"]), JSON.stringify(first?.cols));
const swapped = await js(`
  document.querySelector('.schema-compare button[title^="Intercambiar"]').click();
  await sleep(100); await until(() => { const r = report(); return r && !r.loading; }, 20000); await sleep(150);
  const r = report();
  document.querySelector('.schema-compare button[title^="Intercambiar"]').click();
  await sleep(100); await until(() => { const r = report(); return r && !r.loading; }, 20000); await sleep(150);
  return r;
`);
check("swapping turns the comparison around", swapped?.sides[0] === "Postgres local · celer · sc_b" && swapped.items.includes("only-source:auditoria"), JSON.stringify(swapped));

// The script, in a console of the target, then run.
const script = await js(`
  const before = document.querySelectorAll('.tab').length;
  [...document.querySelectorAll('.schema-compare footer button')].find((b) => /Script para igualar/.test(b.textContent)).click();
  await until(() => document.querySelectorAll('.tab').length > before && !document.querySelector('.schema-compare'));
  await sleep(500);
  return { dialog: !!document.querySelector('.schema-compare'), text: [...pane().querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n') };
`);
check("the script opens in a new console and the dialog closes", !script.dialog && /ALTER TABLE "sc_b"\."clientes" ALTER COLUMN "nombre" TYPE (varchar|character varying)\(120\);/.test(script.text) && /CREATE TABLE "sc_b"\."facturas"/.test(script.text), script.text);
check("it creates the missing table from the source's DDL", /CREATE TABLE/i.test(script.text) && /facturas/.test(script.text), script.text);
check("drops stay commented", /^-- DROP TABLE "sc_b"\."auditoria";$/m.test(script.text) && /^-- Solo en el destino/m.test(script.text), script.text);
await js(`pane().querySelector('.cm-content').focus();`);
await press("Enter", 2 | 8);
await js(`await sleep(300); await until(() => !pane().querySelector('.progress-bar') && !pane().querySelector('.tb-btn.stop'), 20000); await sleep(400);`);
const runError = await js(`return pane().querySelector('.out-entry.error, .output .error')?.textContent ?? pane().querySelector('.results-error')?.textContent ?? '';`);
check("the script runs without errors", !runError, runError);
const second = await js(`
  rowByText('sc_b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }));
  (await menuItem(/^Comparar con/))?.click();
  await until(() => { const r = report(); return r && !r.loading; }, 20000); await sleep(200);
  const r = report();
  document.querySelector('.schema-compare footer .btn:not(.primary)').click();
  return r;
`);
check("after running it, only the deliberate leftovers differ", JSON.stringify(second?.items) === JSON.stringify(["different:clientes", "only-target:auditoria", "same:facturas", "same:pedidos"]) && JSON.stringify(second.cols) === JSON.stringify(["only-target:legacy"]), JSON.stringify(second));
const kept = await js(`return (await sql("SELECT nombre, legacy FROM sc_b.clientes")).results[0].rows;`);
check("no data was lost", JSON.stringify(kept) === JSON.stringify([["Ana", "L1"]]), JSON.stringify(kept));

await js(`await sql("DROP SCHEMA IF EXISTS sc_a CASCADE; DROP SCHEMA IF EXISTS sc_b CASCADE");`);
app.close?.();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("schema-compare-check: all good");
