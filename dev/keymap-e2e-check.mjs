// Keyboard shortcuts in the desktop app (dev/run-desktop.ps1): Ajustes › Atajos de teclado opened from its
// command, Esc while recording only cancels the recording, a recorded shortcut works at once, the library
// shortcut saves a console, and "Restablecer todos" goes back to the defaults.
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const row = (label) => [...document.querySelectorAll('.keymap-row')].find((r) => r.querySelector('.keymap-label').textContent === label);
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 300)}`}`);
  if (!ok) failed++;
};
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function press(key, mods = []) {
  const m = mods.reduce((a, k) => a | MOD[k], 0);
  const code = key.length === 1 ? (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key;
  const vk = { Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: m });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: m });
}

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await js(`document.activeElement?.blur?.();`);
// Open the section through its command (the dialog then mounts after the recorder: the harder case for Esc).
await press("a", ["ctrl", "shift"]);
await js(`
  const input = await until(() => document.querySelector('.palette input'));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Atajos de teclado');
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  const item = await until(() => [...document.querySelectorAll('.pal-item')].find((b) => /Atajos de teclado/.test(b.textContent)));
  item.click();
  await until(() => row('Nueva consola'));
`);
check("the command opens Ajustes on Atajos de teclado", await js(`return document.querySelector('.settings-nav button.on')?.textContent === 'Atajos de teclado';`));
await js(`row('Nueva consola').querySelector('button[title="Añadir un atajo"]').click(); await sleep(150);`);
await press("Escape");
await sleep(200);
const afterEsc = await js(`return { open: !!document.querySelector('.settings'), recording: !!document.querySelector('.keymap-row.recording') };`);
check("Esc while recording cancels the recording, not the dialog", afterEsc.open && !afterEsc.recording, JSON.stringify(afterEsc));
await js(`row('Nueva consola').querySelector('button[title="Añadir un atajo"]').click(); await sleep(150);`);
await press("k", ["ctrl", "alt"]);
await sleep(250);
const keys = await js(`return [...row('Nueva consola').querySelectorAll('.keymap-chip .keys')].map((k) => k.textContent);`);
check("a recorded combination is added", JSON.stringify(keys) === JSON.stringify(["CtrlMayúsL", "CtrlAltK"]), JSON.stringify(keys));
await press("Escape");
await sleep(300);
const before = await js(`return document.querySelectorAll('.tab').length;`);
await js(`document.activeElement?.blur?.();`);
await press("k", ["ctrl", "alt"]);
await sleep(500);
const after = await js(`return document.querySelectorAll('.tab').length;`);
check("the new shortcut works right away", after === before + 1, JSON.stringify({ before, after }));
// Ctrl+Alt+B (library) on the new console: asks for a name.
await js(`document.querySelector('.pane-host.active .cm-content')?.focus();`);
await app.send("Input.insertText", { text: "SELECT 1 AS uno" });
await press("Escape");
await press("b", ["ctrl", "alt"]);
const naming = await js(`await until(() => document.querySelector('#library-name')); await sleep(100); return { focused: document.activeElement?.id, value: document.querySelector('#library-name')?.value };`);
check("Ctrl+Alt+B asks for the script's name in the library", naming.focused === "library-name" && naming.value === "SELECT 1 AS uno", JSON.stringify(naming));
await press("Escape");
// Back to the defaults.
await js(`
  document.activeElement?.blur?.();
  document.querySelector('.stripe-btn[title^="Ajustes"]')?.click();
  await until(() => document.querySelector('.settings-nav'));
  [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'Atajos de teclado').click();
  await until(() => row('Nueva consola'));
  [...document.querySelectorAll('.keymap-head button')].find((b) => /Restablecer todos/.test(b.textContent)).click();
  await sleep(300);
`);
const reset = await js(`return { changed: document.querySelectorAll('.keymap-row.changed').length, keys: [...row('Nueva consola').querySelectorAll('.keymap-chip .keys')].map((k) => k.textContent) };`);
check("Restablecer todos goes back to the defaults", reset.changed === 0 && JSON.stringify(reset.keys) === JSON.stringify(["CtrlMayúsL"]), JSON.stringify(reset));
await press("Escape");
// Close the console opened by the test (it has text: discard).
await js(`
  const tabs = [...document.querySelectorAll('.tab')]; tabs.at(-1)?.querySelector('button[title^="Cerrar"]')?.click(); await sleep(300);
  [...document.querySelectorAll('.dialog button')].find((b) => /No guardar|Descartar|Cerrar/.test(b.textContent))?.click();
`);
app.close?.();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("keymap-e2e-check: all good");
