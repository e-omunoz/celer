// Generated scripts against "Postgres local": SELECT with FK joins runs; UPSERT on countries runs with its
// :parameters inside a transaction that is rolled back; DROP is only written. Needs the desktop app with CDP.
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const menu = async (row, re) => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 200 }));
    const item = await until(() => [...document.querySelectorAll('.ctx-menu button, .menu button, [role=menuitem]')].find((b) => re.test(b.textContent)), 3000);
    item?.click();
    return item?.textContent ?? null;
  };
  const editorText = () => pane().querySelector('.cm-content')?.innerText ?? '';
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

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await js(`
  if (!connRow().classList.contains('connected')) connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => rowByText('events'));
`);
// A fresh console for this connection, so the generated text goes there.
await press("l", 2 | 8);
await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300);`);

const join = await js(`await menu(rowByText('events'), /JOIN de sus claves/); await sleep(1500); return editorText();`);
check("SELECT with FK joins is written", /LEFT JOIN .*customers.* t1 ON t1\..*id.* = t0\..*customer_id/s.test(join), join);
await js(`pane().querySelector('.cm-content').focus();`);
await press("a", 2);
await app.send("Input.insertText", { text: join.replace(/ /g, " ") });
await press("Escape");
await press("Enter", 2);
const ran = await js(`await until(() => pane().querySelector('.rtab.on')?.textContent.includes('Resultado'), 15000); await sleep(300); return { cols: pane().querySelectorAll('.grid-head .col, [data-col]').length, out: pane().querySelector('.rtab.on')?.textContent, error: pane().querySelector('.out-entry.err, .error-banner')?.textContent ?? '' };`);
check("and it runs", /Resultado/.test(ran.out ?? "") && !ran.error, JSON.stringify(ran));

// UPSERT on countries with :parameters, in a transaction we roll back.
await js(`[...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.click(); await until(() => [...pane().querySelectorAll('.tx-toggle button')].find((b) => b.textContent === 'Manual')?.classList.contains('on'));`);
await js(`pane().querySelector('.cm-content').focus();`);
await press("a", 2);
await press("Delete");
const upsert = await js(`await menu(rowByText('countries'), /UPSERT/); await sleep(1500); return editorText();`);
check("UPSERT uses ON CONFLICT and named parameters", /ON CONFLICT \(.*code.*\) DO UPDATE SET/s.test(upsert) && /:code/.test(upsert) && /:name/.test(upsert), upsert);
await js(`pane().querySelector('.cm-content').focus();`);
await press("Enter", 2);
const dialog = await js(`const d = await until(() => document.querySelector('.params-dialog'), 4000); return d ? [...d.querySelectorAll('.param-name')].map((n) => n.textContent) : null;`);
check("running it asks for its parameters", Array.isArray(dialog) && dialog.includes("code") && dialog.includes("name"), JSON.stringify(dialog));
await js(`
  const d = document.querySelector('.params-dialog');
  const set = (name, value) => { const row = [...d.querySelectorAll('.param-row')].find((r) => r.querySelector('.param-name').textContent === name); const input = row.querySelector('input:not([type=checkbox])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new InputEvent('input', { bubbles: true })); };
  set('code', 'ZZ'); set('name', 'Zetalandia'); set('eu_member', 'false');
  d.querySelector('button[type=submit]').click();
`);
const upserted = await js(`await until(() => !pane().querySelector('.progress-bar') && !document.querySelector('.params-dialog'), 10000); await sleep(800); const out = [...pane().querySelectorAll('.out-entry')].pop()?.textContent ?? ''; return { tx: !!pane().querySelector('.tag.warn'), affected: pane().querySelector('.affected strong')?.textContent || out, error: pane().querySelector('.rtab.error')?.textContent ?? '' };`);
check("the UPSERT runs (1 row, transaction open)", /1 fila/.test(upserted.affected) && upserted.tx, JSON.stringify(upserted));
await press("r", 1 | 2 | 8); // Ctrl+Alt+Shift+R: rollback
await sleep(800);
check("rolled back", (await js(`return !pane().querySelector('.tag.warn');`)) === true);

const drop = await js(`pane().querySelector('.cm-content').focus(); await sleep(100); return null;`);
void drop;
await press("a", 2);
await press("Delete");
const dropText = await js(`await menu(rowByText('countries'), /DROP TABLE/); await sleep(1200); return editorText();`);
check("DROP is written with a warning comment, not run", /DROP TABLE .*countries/s.test(dropText) && /Revisa/.test(dropText) && (await js(`return !pane().querySelector('.progress-bar');`)), dropText);

app.close();
process.exit(failed ? 1 : 0);
