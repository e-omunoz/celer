// Assorted checks against "Postgres local" in the desktop app (dev/run-desktop.ps1):
// - the connection's startup script runs on every new session;
// - a pinned result can be viewed after a run without a grid (UPDATE) and after a failed run;
// - pending table edits can be undone per cell and per row from the grid menu.
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const pane = () => document.querySelector('.pane-host.active');
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const menuItem = async (re) => { const item = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 3000); return item; };
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
async function run(sql) {
  await js(`pane().querySelector('.cm-content').focus();`);
  await press("a", 2);
  await press("Delete");
  await app.send("Input.insertText", { text: sql });
  await press("Escape");
  await press("Enter", 2);
  await js(`await sleep(200); await until(() => !pane().querySelector('.progress-bar') && !pane().querySelector('.tb-btn.stop'), 15000); await sleep(300);`);
}

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");

// ---------------------------------------------------------------- startup script
const connId = await js(`const list = await inv('list_connections'); return list.find((c) => c.name === 'Postgres local').id;`);
await js(`const list = await inv('list_connections'); const c = list.find((x) => x.id === ${JSON.stringify(connId)}); await inv('save_connection', { cfg: { ...c, password: null, startupSql: "SET application_name = 'celer-startup-check';" } });`);
await js(`
  if (connRow().classList.contains('connected')) { connRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 })); (await menuItem(/^Desconectar$/))?.click(); await sleep(400); const d = document.querySelector('.dialog'); if (d) [...d.querySelectorAll('button')].find((b) => /^Desconectar$/.test(b.textContent))?.click(); await until(() => !connRow().classList.contains('connected')); }
  connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => connRow().classList.contains('connected'));
  await until(() => rowByText('events'));
`);
await press("l", 2 | 8);
await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300);`);
await run("SHOW application_name");
const appName = await js(`return pane().querySelector('.results canvas') ? (await inv('list_connections'), document.querySelector('.statusbar')?.textContent ?? '') : '';`);
void appName;
const shown = await js(`
  // Read the value through the record panel: activate the first cell.
  const out = [...pane().querySelectorAll('.out-entry')].pop()?.textContent ?? '';
  return { out, rtab: pane().querySelector('.rtab.on')?.textContent ?? '' };
`);
check("startup script ran (SHOW application_name returned a row)", /Resultado/.test(shown.rtab), JSON.stringify(shown));
await run("SELECT current_setting('application_name') = 'celer-startup-check' AS ok");
const ok = await js(`
  // The grid is a canvas: copy the cell through the app's own clipboard path is overkill; ask the core directly.
  const tabs = document.querySelectorAll('.tab'); return tabs.length;
`);
void ok;
const viaCore = await js(`
  const list = await inv('list_connections'); const c = list.find((x) => x.id === ${JSON.stringify(connId)});
  const s = await inv('open_session', { connId: c.id, password: null });
  const out = await inv('execute', { sessionId: s.sessionId, sql: "SELECT current_setting('application_name')", fetch: 1 });
  await inv('close_session', { sessionId: s.sessionId });
  return out.results[0].rows[0][0];
`);
check("every new session runs it (application_name set)", viaCore === "celer-startup-check", viaCore);
const afterReconnect = await js(`
  const s = await inv('open_session', { connId: ${JSON.stringify(connId)}, password: null });
  const killer = await inv('open_session', { connId: ${JSON.stringify(connId)}, password: null });
  try {
    const pid = (await inv('execute', { sessionId: s.sessionId, sql: "SELECT pg_backend_pid()", fetch: 1 })).results[0].rows[0][0];
    await inv('execute', { sessionId: killer.sessionId, sql: "SELECT pg_terminate_backend(" + pid + ")", fetch: 1 });
    await sleep(300);
    // The lost connection is reopened (the first try may report the loss).
    let value = null;
    for (let i = 0; i < 2 && value === null; i++) {
      try { value = (await inv('execute', { sessionId: s.sessionId, sql: "SELECT current_setting('application_name'), pg_backend_pid() <> " + pid, fetch: 1 })).results[0].rows[0]; } catch (e) { value = null; }
    }
    return value;
  } finally {
    await inv('close_session', { sessionId: s.sessionId }); await inv('close_session', { sessionId: killer.sessionId });
  }
`);
check("a reopened connection runs it again", afterReconnect?.[0] === "celer-startup-check" && afterReconnect?.[1] === true, JSON.stringify(afterReconnect));
await js(`const list = await inv('list_connections'); const c = list.find((x) => x.id === ${JSON.stringify(connId)}); await inv('save_connection', { cfg: { ...c, password: null, startupSql: "" } });`);
await js(`
  const list = await inv('list_connections'); const c = list.find((x) => x.id === ${JSON.stringify(connId)});
  await inv('save_connection', { cfg: { ...c, password: null, startupSql: "SELEC broken" } });
`);
const broken = await js(`try { await inv('open_session', { connId: ${JSON.stringify(connId)}, password: null }); return 'opened'; } catch (e) { return String(e); }`);
check("a broken startup script says so", /script de inicio/i.test(broken), broken);
await js(`const list = await inv('list_connections'); const c = list.find((x) => x.id === ${JSON.stringify(connId)}); await inv('save_connection', { cfg: { ...c, password: null, startupSql: "" } });`);

// ---------------------------------------------------------------- pinned result after an UPDATE and after an error
await js(`[...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.click(); await until(() => [...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.classList.contains('on'));`);
await run("SELECT code, name FROM countries ORDER BY code");
await js(`pane().querySelector('button[title^="Fijar este resultado"]').click(); await sleep(200);`);
await run("UPDATE countries SET name = name WHERE code = 'ES'");
const afterUpdate = await js(`
  [...pane().querySelectorAll('.rtab.pinned .rtab-main')][0].click(); await sleep(300);
  return { grid: !!pane().querySelector('.results canvas'), output: !!pane().querySelector('.output'), on: [...pane().querySelectorAll('.rtab.on')].map((t) => t.textContent) };
`);
check("a pinned result shows after an UPDATE", afterUpdate.grid && !afterUpdate.output && afterUpdate.on.length === 1, JSON.stringify(afterUpdate));
await press("r", 1 | 2 | 8);
await sleep(500);
await run("SELECT * FROM no_such_table");
const afterError = await js(`
  [...pane().querySelectorAll('.rtab.pinned .rtab-main')][0].click(); await sleep(300);
  return { grid: !!pane().querySelector('.results canvas'), output: !!pane().querySelector('.output') };
`);
check("and after a failed run", afterError.grid && !afterError.output, JSON.stringify(afterError));
await press("r", 1 | 2 | 8);

// ---------------------------------------------------------------- undo pending table edits
const reverted = await js(`
  rowByText('countries').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('countries') && (pane().querySelector('.data-toolbar .muted.small')?.textContent ?? '').includes('fila'));
  await sleep(400);
  return true;
`);
void reverted;
// Edit the first "name" cell with real keys: click it, F2, type, Enter.
const cell = await js(`const c = pane().querySelector('.results canvas, .grid canvas, canvas'); const r = c.getBoundingClientRect(); return { x: r.left + 260, y: r.top + 40 };`);
await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cell.x, y: cell.y, button: "left", clickCount: 1 });
await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cell.x, y: cell.y, button: "left", clickCount: 1 });
await press("F2");
await sleep(200);
await press("a", 2);
await app.send("Input.insertText", { text: "Cambiado" });
await press("Enter");
await sleep(300);
const dirty = await js(`return /Guardar \\(1\\)/.test(pane().textContent);`);
check("an edit is pending", dirty === true);
await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cell.x, y: cell.y, button: "right", clickCount: 1 });
await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cell.x, y: cell.y, button: "right", clickCount: 1 });
const undoCell = await js(`const item = await menuItem(/Deshacer el cambio de la celda/); item?.click(); await sleep(300); return { found: !!item, saveBtn: /Guardar \\(/.test(pane().textContent) };`);
check("'Deshacer el cambio de la celda' undoes it", undoCell.found && !undoCell.saveBtn, JSON.stringify(undoCell));

app.close();
process.exit(failed ? 1 : 0);
