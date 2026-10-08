// Gib in the status bar of the desktop app: an idle activity from the palette ("Gib: haz algo"), the cursor
// over him (annoyed, swatting), a click (a tip, "Otro consejo") and clicking on and on (a grumble). Saves crops of
// the corner to <outDir> and a contact sheet. Needs the desktop app with CDP (dev/run-desktop.ps1).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const out = process.argv[2] || join(process.env.TEMP || "/tmp", "gib-companion");
mkdirSync(out, { recursive: true });
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const gib = () => document.querySelector('.companion .gib');
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
const shots = [];
async function crop(name) {
  const box = await js(`const r = gib().getBoundingClientRect(); return { x: Math.max(0, r.left - 170), y: Math.max(0, r.top - 120), width: Math.min(innerWidth - Math.max(0, r.left - 170), 240), height: Math.min(innerHeight - Math.max(0, r.top - 120), 190) };`);
  const file = join(out, `${String(shots.length).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, await app.shot({ clip: { ...box, scale: 2 } }));
  shots.push({ file, name });
}
async function palette(label) {
  await js(`document.activeElement?.blur?.();`);
  await press("a", 2 | 8);
  await js(`
    const input = await until(() => document.querySelector('.palette input'), 3000);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const item = await until(() => [...document.querySelectorAll('.pal-item')].find((b) => b.querySelector('.pal-label')?.textContent === ${JSON.stringify(label)}), 2000);
    item.click();
  `);
}

await js(`await until(() => document.querySelector('.companion.landed'), 15000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 300 });
await sleep(400);

// An idle activity on demand (not the coffee break: while he is away the cursor does not bother him, by design,
// and the hover checks below need him in place).
let act = "";
for (let attempt = 0; attempt < 8; attempt++) {
  await palette("Gib: haz algo");
  act = await js(`await until(() => [...gib().classList].some((c) => c.startsWith('act-')), 3000); return [...gib().classList].find((c) => c.startsWith('act-')) ?? '';`);
  if (act && !act.startsWith("act-coffee")) break;
  await press("x"); // interrupts it; try again
  await sleep(300);
}
check("'Gib: haz algo' starts an idle activity", Boolean(act), act);
for (let i = 0; i < 6; i++) {
  await sleep(900);
  await crop(`activity-${i}`);
}
// The cursor over him: annoyed, swatting with the arm on the cursor's side.
const g = await js(`const r = gib().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };`);
await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x + g.w * 0.3, y: g.y });
await sleep(350);
const annoyed = await js(`return { mood: [...gib().classList].find((c) => c.startsWith('mood-')), side: [...gib().classList].find((c) => c.startsWith('side-')), act: [...gib().classList].find((c) => c.startsWith('act-')) ?? '' };`);
check("hovering makes him annoyed and stops the activity", annoyed.mood === "mood-annoyed" && !annoyed.act, JSON.stringify(annoyed));
check("he swats on the cursor's side", annoyed.side === "side-right", JSON.stringify(annoyed));
await crop("annoyed-right");
await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x - g.w * 0.3, y: g.y });
await sleep(300);
check("cursor on his left: he swats with the left arm", (await js(`return gib().classList.contains('side-left');`)) === true);
await crop("annoyed-left");

// A click: a tip (he stops swatting while he talks); a second click closes it; clicking on and on: a grumble.
const click = async () => {
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: g.x, y: g.y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x, y: g.y, button: "left", clickCount: 1 });
};
const bubble = () => js(`return { mood: [...gib().classList].find((c) => c.startsWith('mood-')), text: document.querySelector('.companion .tip p')?.textContent ?? '', buttons: [...document.querySelectorAll('.companion .tip button')].map((b) => b.textContent) };`);
await click();
await sleep(380); // single clicks wait 230 ms to tell them from a double click
const first = await bubble();
check("a click gives a tip", first.text.length > 20 && first.buttons.includes("Otro consejo"), JSON.stringify(first));
check("he does not swat while he talks", first.mood !== "mood-annoyed" && first.mood !== "mood-grumpy", JSON.stringify(first));
await crop("tip");
await js(`[...document.querySelectorAll('.companion .tip button')].find((b) => b.textContent === 'Otro consejo')?.click(); await sleep(150);`);
const second = await bubble();
check("'Otro consejo' shows another one", second.text.length > 20 && second.text !== first.text, JSON.stringify(second));
await click();
await sleep(380);
check("a click on him closes the tip", (await bubble()).text === "");
await click();
await sleep(380);
await click();
await sleep(380);
const grumble = await bubble();
check("the fourth click in a row is pestering: a grumble", grumble.mood === "mood-grumpy" && /bot[oó]n|mosca|clics/i.test(grumble.text), JSON.stringify(grumble));
await crop("grumpy");
await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 300 });
await sleep(1600);
check("moving away calms him down", (await js(`return gib().classList.contains('mood-idle');`)) === true);
await js(`[...document.querySelectorAll('.companion .tip button')].find((b) => b.textContent === 'Cerrar')?.click();`);

// Typing interrupts an activity.
await palette("Gib: haz algo");
await js(`await until(() => [...gib().classList].some((c) => c.startsWith('act-')), 3000);`);
await press("x");
await sleep(150);
check("a key press interrupts the activity", (await js(`return ![...gib().classList].some((c) => c.startsWith('act-'));`)) === true);

// Palette tip command.
await palette("Gib: un consejo");
await sleep(200);
check("'Gib: un consejo' shows a tip", (await js(`return (document.querySelector('.companion .tip')?.textContent ?? '').length > 20;`)) === true);
await js(`[...document.querySelectorAll('.companion .tip button')].find((b) => b.textContent === 'Cerrar')?.click();`);

const sheet = `<!doctype html><body style="margin:0;background:#222;display:flex;flex-wrap:wrap;gap:8px;padding:8px;font:11px monospace;color:#bbb">${shots
  .map((s) => `<figure style="margin:0"><img src="file:///${s.file.replace(/\\/g, "/")}" style="height:190px"><figcaption>${s.name}</figcaption></figure>`)
  .join("")}</body>`;
writeFileSync(join(out, "sheet.html"), sheet);
console.log("crops in", out);
app.close();
process.exit(failed ? 1 : 0);
