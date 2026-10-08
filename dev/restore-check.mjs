// Workspace restore: table tabs (with their WHERE) and the console's caret and transaction mode survive a restart.
//   node dev/restore-check.mjs prepare   → opens "events" with a WHERE, sets a console to Manual
//   (close the app normally, start it again)
//   node dev/restore-check.mjs verify    → the table tab is back, loads with the same WHERE; the console too
// Needs the desktop app with CDP (dev/run-desktop.ps1) and "Postgres local" (dev/testdb-postgres.ps1).
import { connect, sleep } from "./cdp-lib.mjs";

const phase = process.argv[2] ?? "verify";
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const setInput = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new InputEvent('input', { bubbles: true })); };
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

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await sleep(300);

if (phase === "prepare") {
  await js(`
    if (!connRow().classList.contains('connected')) connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => rowByText('events'));
    rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && !pane().querySelector('.progress-bar'));
    await sleep(500);
  `);
  // The WHERE box (real keys, so the app sees them).
  await js(`pane().querySelector('.filter-field input, .where-input input, input[placeholder*="WHERE"], .data-toolbar input').focus();`);
  await app.send("Input.insertText", { text: "kind = 'click'" });
  await press("Enter");
  const applied = await js(`await sleep(1500); return { info: pane().querySelector('.data-toolbar .muted.small')?.textContent ?? '', where: pane().querySelector('.data-toolbar input')?.value ?? '' };`);
  check("events opened with a WHERE", /kind/.test(applied.where), JSON.stringify(applied));
  // A console in Manual mode, caret in the middle of its text.
  await press("l", 2 | 8);
  await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300); [...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.click(); await until(() => [...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.classList.contains('on')); pane().querySelector('.cm-content').focus();`);
  await app.send("Input.insertText", { text: "SELECT 1;\nSELECT 2;" });
  await press("Escape");
  console.log("now close the app normally and start it again, then run: node dev/restore-check.mjs verify");
} else {
  const tabs = await js(`return [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim());`);
  check("the table tab is restored", tabs.some((t) => t.includes("events")), JSON.stringify(tabs));
  const loaded = await js(`
    [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('events')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events'));
    await until(() => (pane().querySelector('.data-toolbar .muted.small')?.textContent ?? '').includes('filas'), 20000);
    return { where: pane().querySelector('.data-toolbar input')?.value ?? '', info: pane().querySelector('.data-toolbar .muted.small')?.textContent ?? '', connected: connRow().classList.contains('connected') };
  `);
  check("it loads when shown, connecting first", loaded.connected && /filas/.test(loaded.info), JSON.stringify(loaded));
  check("with the same WHERE", /kind = 'click'/.test(loaded.where), JSON.stringify(loaded));
  const consoleTab = await js(`
    const tab = [...document.querySelectorAll('.tab')].reverse().find((t) => !t.textContent.includes('events'));
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await sleep(500);
    return { manual: [...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.classList.contains('on'), text: pane().querySelector('.cm-content')?.textContent ?? '' };
  `);
  check("the console keeps its text and Manual mode", consoleTab.manual === true && consoleTab.text.includes("SELECT 2"), JSON.stringify(consoleTab));
}
app.close();
process.exit(failed ? 1 : 0);
