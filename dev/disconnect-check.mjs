// Disconnect end to end against "Postgres local" (dev/testdb-postgres.ps1): it asks when a transaction is open,
// really forgets the connection (explorer, sessions), and consoles / tables reconnect on their next run.
// Needs the desktop app with CDP (dev/run-desktop.ps1).
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const button = (re, root = document) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));
  const menu = async (re) => {
    connRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }));
    const item = await until(() => [...document.querySelectorAll('.ctx-menu button, .menu button, [role=menuitem]')].find((b) => re.test(b.textContent)), 2000);
    item?.click();
    return !!item;
  };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};
async function press(key, mods = 0) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = { Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
}

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 15000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await sleep(300);

const connected = await js(`
  if (!connRow().classList.contains('connected')) connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => connRow().classList.contains('connected'), 15000);
  await until(() => [...document.querySelectorAll('.tree-row')].some((e) => e.querySelector('.tree-name')?.textContent === 'events'), 10000);
  return { connected: connRow().classList.contains('connected'), rows: document.querySelectorAll('.tree-row').length };
`);
check("connects to Postgres local", connected.connected && connected.rows > 4, JSON.stringify(connected));

// A console in Manual mode with a statement run: a transaction is open.
await press("l", 2 | 8); // Ctrl+Shift+L
await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300);`);
await js(`button(/^Manual$/, pane())?.click(); await sleep(300); pane().querySelector('.cm-content').focus();`);
await app.send("Input.insertText", { text: "SELECT count(*) FROM events" });
await press("Enter", 2);
const tx = await js(`await until(() => pane().querySelector('.rtab.on')?.textContent.includes('Resultado'), 15000); await sleep(300); return { tx: !!pane().querySelector('.tx-pending, .tx-badge, [class*=pending]'), result: pane().querySelector('.rtab.on')?.textContent };`);
check("manual console ran a statement", /Resultado/.test(tx.result ?? ""), JSON.stringify(tx));

// Disconnect: the open transaction is Commit, Rollback or Cancelar (never an implicit commit); cancelling keeps everything.
const ask = await js(`
  await menu(/^Desconectar$/);
  const dlg = await until(() => document.querySelector('[role=dialog], .dialog'), 3000);
  const text = dlg?.textContent ?? '';
  const buttons = [...(dlg?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()).filter(Boolean);
  button(/Cancelar/, dlg)?.click();
  await sleep(300);
  return { text, buttons, stillConnected: connRow().classList.contains('connected') };
`);
check("disconnect asks about the open transaction", /transacci/.test(ask.text), ask.text);
check("it offers Commit and Rollback", ask.buttons.includes("Commit") && ask.buttons.includes("Rollback"), JSON.stringify(ask.buttons));
check("cancel keeps the connection", ask.stillConnected);

const gone = await js(`
  await menu(/^Desconectar$/);
  const dlg = await until(() => document.querySelector('[role=dialog], .dialog'), 3000);
  button(/^Rollback$/, dlg)?.click();
  await until(() => !connRow().classList.contains('connected'), 5000);
  await sleep(300);
  return {
    connected: connRow().classList.contains('connected'),
    eventsVisible: [...document.querySelectorAll('.tree-row')].some((e) => e.querySelector('.tree-name')?.textContent === 'events'),
    tabs: document.querySelectorAll('.tab').length,
  };
`);
check("disconnect forgets the connection", !gone.connected && !gone.eventsVisible, JSON.stringify(gone));
check("tabs stay open", gone.tabs >= 1, JSON.stringify(gone));

// The console reconnects on its next run.
await js(`pane().querySelector('.cm-content').focus();`);
await press("Enter", 2);
const again = await js(`
  await until(() => connRow().classList.contains('connected'), 15000);
  await until(() => pane().querySelector('.rtab.on')?.textContent.includes('Resultado') && !pane().querySelector('.progress-bar'), 15000);
  return { connected: connRow().classList.contains('connected'), error: pane().querySelector('.error-banner, .out-error')?.textContent ?? '' };
`);
check("the console reconnects and runs again", again.connected && !again.error, JSON.stringify(again));

// Disconnect all from the palette leaves nothing connected.
const all = await js(`
  await menu(/^Desconectar$/);
  const dlg = await until(() => document.querySelector('[role=dialog], .dialog'), 1500);
  if (dlg) button(/^Rollback$/, dlg)?.click();
  await until(() => !connRow().classList.contains('connected'), 5000);
  return { connected: document.querySelectorAll('.tree-row.conn.connected').length };
`);
check("nothing stays connected", all.connected === 0, JSON.stringify(all));

app.close();
process.exit(failed ? 1 : 0);
