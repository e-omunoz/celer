// Server activity monitor against the test databases: a console runs a long statement, the monitor shows it
// as active, "Cancelar consulta" stops it (PostgreSQL) and "Terminar sesión" ends it (MariaDB).
// Needs the desktop app (dev/run-desktop.ps1). Saves <outDir>\activity.png.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const out = process.argv[2] || join(process.env.TEMP || "/tmp", "celer-activity");
mkdirSync(out, { recursive: true });
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
  const conn = (name) => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes(name));
  const confirmWith = async (re) => { const d = await until(() => [...document.querySelectorAll('.dialog')].find((x) => /Cancelar la consulta|Terminar la sesión/.test(x.textContent)), 4000); [...d.querySelectorAll('button')].find((b) => re.test(b.textContent)).click(); };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 400)}`}`);
  if (!ok) failed++;
};
async function press(key, mods = 0) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = { Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
async function runLong(name, sql) {
  await js(`
    const c = conn(${JSON.stringify(name)});
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    if (!c.classList.contains('connected')) { c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => c.classList.contains('connected')); }
    await sleep(200);
  `);
  await press("l", 2 | 8);
  await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300); pane().querySelector('.cm-content').focus();`);
  await app.send("Input.insertText", { text: sql });
  await press("Escape");
  await press("Enter", 2);
  await js(`await until(() => pane().querySelector('.tb-btn.stop'));`);
}
async function openMonitor(name) {
  await js(`
    conn(${JSON.stringify(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }));
    const item = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Actividad del servidor/.test(b.textContent)), 3000);
    item.click();
    await until(() => document.querySelector('.activity-dialog .activity-row:not(.head)'));
    await sleep(800);
  `);
}
// The console opens its session and sends the statement a moment after it shows "Detener": the monitor
// refreshes every 3 s, so give it a few rounds.
const rowWith = (re) => js(`const row = await until(() => [...document.querySelectorAll('.activity-dialog .activity-row:not(.head)')].find((r) => ${re}.test(r.textContent) && r.classList.contains('busy')), 10000); return row ? { busy: row.classList.contains('busy'), text: row.textContent, id: row.firstElementChild.textContent } : null;`);

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'));`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");

// PostgreSQL: cancel the running statement.
await runLong("Postgres local", "SELECT pg_sleep(30) AS durmiendo");
await openMonitor("Postgres local");
// Celer reads through a cursor: the server shows the FETCH (the console's own text is only visible from it).
const sleeping = await rowWith("/pg_sleep|Celer leyendo resultados/");
check("PostgreSQL: the running statement shows as an active session", sleeping?.busy === true, JSON.stringify(sleeping));
check("the monitor marks its own session", (await js(`return !!document.querySelector('.activity-dialog .activity-row.self');`)) === true);
writeFileSync(join(out, "activity.png"), await app.shot());
await js(`
  const row = [...document.querySelectorAll('.activity-dialog .activity-row:not(.head)')].find((r) => /pg_sleep|Celer leyendo resultados/.test(r.textContent) && r.classList.contains('busy') && !r.classList.contains('self'));
  row.querySelector('button[title^="Cancelar"]').click();
  await confirmWith(/^Cancelar consulta$/);
  await sleep(1500);
`);
const stopped = await js(`
  await sleep(500);
  document.querySelector('.activity-dialog .icon-btn[title^="Cerrar"]')?.click();
  await sleep(300);
  await until(() => !pane().querySelector('.tb-btn.stop'), 8000);
  return { running: !!pane().querySelector('.tb-btn.stop'), output: [...pane().querySelectorAll('.out-entry')].pop()?.textContent ?? pane().textContent.slice(0, 200) };
`);
check("Cancelar consulta stops it in the console", !stopped.running && /cancel/i.test(stopped.output), JSON.stringify(stopped));

// MariaDB: end the session.
await runLong("MariaDB local", "SELECT SLEEP(30) AS durmiendo");
await openMonitor("MariaDB local");
const mysqlRow = await rowWith("/SLEEP\\(30\\)/i");
check("MariaDB: the running statement shows up", Boolean(mysqlRow?.busy), JSON.stringify(mysqlRow));
await js(`
  const row = [...document.querySelectorAll('.activity-dialog .activity-row:not(.head)')].find((r) => /SLEEP\\(30\\)/i.test(r.textContent));
  row.querySelector('button[title^="Terminar"]').click();
  await confirmWith(/^Terminar sesión$/);
  await sleep(1500);
  document.querySelector('.activity-dialog .icon-btn[title^="Cerrar"]')?.click();
`);
const ended = await js(`await until(() => !pane().querySelector('.tb-btn.stop'), 10000); return { running: !!pane().querySelector('.tb-btn.stop') };`);
check("Terminar sesión ends it", !ended.running, JSON.stringify(ended));
app.close();
process.exit(failed ? 1 : 0);
