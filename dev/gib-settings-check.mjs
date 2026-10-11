// Settings › Apariencia › Gib, every control verified in the running UI: the look (colour, accessories, name, pose)
// and the presence (on/off, frequency, reactions, eye tracking, where he appears), plus petting and poking a Gib and
// his reactions to real queries (first of the day, an empty result, an error; none with reactions off).
//   node dev/gib-settings-check.mjs [outDir]
// Against the browser preview (npm run dev; GIB_APP_URL=http://localhost:1420, the default), in a headless browser with
// a fresh profile; or against the desktop app with CDP_PORT=9333 (dev/run-desktop.ps1; it changes that app's Gib
// settings). The queries run in a new console of the connection selected in the explorer, so on the desktop app the
// reactions are checked on each engine by selecting its connection first; GIB_SQL_EMPTY overrides the empty query for
// engines that need a FROM (Informix: SELECT 1 FROM systables WHERE 1 = 0).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

const out = process.argv[2] || join(process.env.TEMP || "/tmp", "gib-settings");
mkdirSync(out, { recursive: true });
const desktop = Boolean(process.env.CDP_PORT);
const url = (process.env.GIB_APP_URL || "http://localhost:1420").replace(/\/$/, "");
const browser = desktop ? null : await headlessBrowser({ port: Number(process.env.GIB_CDP_PORT || 9446), width: 1400, height: 900 });
const app = await connect(desktop ? Number(process.env.CDP_PORT) : browser.port);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const companion = () => document.querySelector('.companion .gib');
  const box = (name) => document.querySelector('[data-gib-pref="' + name + '"]');
  const place = (name) => document.querySelector('[data-gib-place="' + name + '"]');
  const outside = () => [...document.querySelectorAll('.gib')].filter((g) => !g.closest('.gib-preview'));
`;
const js = (code) => app.js(H + code);
async function key(keyName, mods = 0) {
  const code = keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName;
  const vk = { Enter: 13, Escape: 27 }[keyName] ?? keyName.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
async function palette(label) {
  await js(`document.activeElement?.blur?.();`);
  await key("a", 2 | 8);
  return js(`
    const input = await until(() => document.querySelector('.palette input'), 3000);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const item = await until(() => [...document.querySelectorAll('.pal-item')].find((b) => b.querySelector('.pal-label')?.textContent === ${JSON.stringify(label)}), 2000);
    if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return false; }
    item.click();
    return true;
  `);
}
/** Clicks a settings checkbox (only when it is not already as wanted). */
const setBox = (selector, on) => js(`const b = ${selector}; if (b.checked !== ${on}) b.click(); await sleep(120); return b.checked;`);
const openSettings = async () => {
  if (await js(`return !!document.querySelector('.gib-settings');`)) return;
  await palette("Ajustes…");
  await js(`await until(() => document.querySelector('.settings-nav'), 3000); [...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'Apariencia')?.click(); await until(() => document.querySelector('.gib-settings'), 3000);`);
};
const closeSettings = () => js(`document.querySelector('.dialog.settings header .icon-btn')?.click(); await sleep(200);`);
async function shot(name) {
  await js(`document.querySelector('.gib-settings')?.scrollIntoView({ block: 'start' }); await sleep(150);`);
  writeFileSync(join(out, `${name}.png`), await app.shot());
}

/** Runs SQL in a fresh console of the demo connection and waits for it to finish. */
async function run(sql) {
  await palette("Nueva consola");
  // The new console's editor (the others stay in the page, hidden).
  await js(`const visible = () => [...document.querySelectorAll('.cm-content')].find((e) => e.offsetParent && !e.textContent.trim()); await sleep(200); (await until(visible, 4000)).focus();`);
  await app.send("Input.insertText", { text: sql });
  // Gib at rest first (no face, activity or words left from before), so what follows is his answer to this query.
  await closeTip();
  for (let i = 0; i < 60; i++) {
    const now = await companionState();
    if (now.mood === "mood-idle" && !now.act && !now.tip) break;
    await sleep(100);
  }
  await key("Enter", 2);
  // He reacts once it has run (the demo's SQLite loads on the first query): wait for that, or for 8 s of nothing.
  for (let i = 0; i < 80; i++) {
    const now = await companionState();
    if (now.tip || now.mood !== "mood-idle" || now.act) break;
    await sleep(100);
  }
  await sleep(150);
}
const companionState = () =>
  js(`const g = companion(); return { mood: g ? [...g.classList].find((c) => c.startsWith('mood-')) : null, act: g ? [...g.classList].find((c) => c.startsWith('act-')) ?? '' : '', tip: document.querySelector('.companion .tip p')?.textContent ?? '' };`);
const closeTip = () => js(`[...document.querySelectorAll('.companion .tip button')].find((b) => b.textContent === 'Cerrar')?.click(); await sleep(150);`);

try {
  if (!desktop) {
    // A fresh profile that has done the start-up guide (so it does not cover the window), animations on.
    await app.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await app.send("Page.navigate", { url: `${url}/?gibcheck=${Date.now()}` });
    await sleep(1500);
    await app.js(`localStorage.clear(); localStorage.setItem('celer.settings', JSON.stringify({ onboarded: true, motion: 'full' })); location.reload();`).catch(() => {});
    await sleep(2500);
  }
  if (desktop) {
    // His memory says whether today's first query was already greeted: forget it (and the once-a-day ones).
    await app.js(`localStorage.removeItem('celer.gib'); location.reload();`).catch(() => {});
    await sleep(3000);
  }
  await js(`await until(() => document.querySelector('.companion.landed'), 15000);`);
  check("the companion is in the status bar", Boolean(await js(`return companion();`)));

  // ---------------------------------------------------------------- the look
  await openSettings();
  check("Settings › Apariencia shows the Gib section with a preview", await js(`return !!document.querySelector('.gib-preview .gib');`));
  await js(`[...document.querySelectorAll('.gib-chip')].find((b) => b.textContent === 'Gorra').click(); await sleep(100); [...document.querySelectorAll('.gib-chip')].find((b) => b.textContent === 'Bufanda').click(); await sleep(150);`);
  const acc = await js(`return { root: document.documentElement.dataset.gibAcc, preview: getComputedStyle(document.querySelector('.gib-preview .acc-cap')).display, companion: getComputedStyle(companion().querySelector('.acc-cap')).display, glasses: getComputedStyle(companion().querySelector('.acc-glasses')).display };`);
  check("accessories: cap and scarf on, everywhere (preview and companion)", acc.root === "cap scarf" && acc.preview !== "none" && acc.companion !== "none" && acc.glasses === "none", JSON.stringify(acc));
  await js(`document.querySelector('.gib-settings .swatch.follow').click(); await sleep(150);`);
  const tint = await js(`return { tint: document.documentElement.style.getPropertyValue('--gib-tint'), tie: getComputedStyle(companion().querySelector('.tie path[fill]')).fill, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() };`);
  check("colour: follow the accent", tint.tint === "var(--accent)" && tint.tie !== "rgb(27, 28, 33)", JSON.stringify(tint));
  await js(`document.querySelector('.gib-settings .swatch.classic').click(); await sleep(150);`);
  check("colour: back to the classic black tie", (await js(`return getComputedStyle(companion().querySelector('.tie path[fill]')).fill;`)) === "rgb(27, 28, 33)");
  await js(`const i = document.querySelector('.gib-look input[type=text]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Bob'); i.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);`);
  check("name: shown in the preview and in his label", await js(`return document.querySelector('.gib-preview-name').textContent === 'Bob' && companion().getAttribute('aria-label').startsWith('Bob');`));
  await js(`[...document.querySelectorAll('.gib-look .seg button')].find((b) => b.textContent === 'Solo la cabeza').click(); await sleep(150);`);
  check("pose: the companion wears the chosen one", await js(`return companion().classList.contains('pose-icon');`));
  await shot("settings-look");
  await closeSettings();
  check("name: the palette knows him as Bob (Gib)", await palette("Bob (Gib): un consejo"));
  await sleep(300);
  check("…and the tip is shown", (await companionState()).tip.length > 20);
  await closeTip();

  // ---------------------------------------------------------------- reactions to real queries (SQLite demo)
  await run(process.env.GIB_SQL_OK || "SELECT 1 AS uno");
  let s = await companionState();
  check("reactions: the first query of the day is greeted", /Primera consulta del día/.test(s.tip), JSON.stringify(s));
  await closeTip();
  await run(process.env.GIB_SQL_EMPTY || "SELECT 1 AS uno WHERE 1 = 0");
  s = await companionState();
  check("reactions: an empty result makes him wonder", /Ni una fila/.test(s.tip) && (s.act === "act-scratch" || s.mood === "mood-think"), JSON.stringify(s));
  await closeTip();
  await sleep(3800);
  await run("SELEC mal");
  s = await companionState();
  check("reactions: an error gets his error face", s.mood === "mood-error", JSON.stringify(s));
  await sleep(2800);

  // ---------------------------------------------------------------- presence toggles
  await closeTip();
  await openSettings();
  check("reactions: toggle off", (await setBox("box('reactions')", false)) === false);
  await closeSettings();
  await run(process.env.GIB_SQL_EMPTY || "SELECT 2 AS dos WHERE 1 = 0");
  await sleep(1200);
  s = await companionState();
  check("reactions off: no face, no words after a query", s.mood === "mood-idle" && !s.act && !s.tip, JSON.stringify(s));
  await openSettings();
  await setBox("box('reactions')", true);

  for (const [name, label] of [["idle", "idle activities"], ["tips", "volunteered tips"]]) {
    const off = await setBox(`box('${name}')`, false);
    const saved = await js(`return JSON.parse(localStorage.getItem('celer.settings') ?? '{}').gib?.${name};`).catch(() => null);
    check(`${label}: toggle off is saved`, off === false && (desktop || saved === false), String(saved));
    await setBox(`box('${name}')`, true);
  }

  await setBox("box('eyes')", false);
  check("eye tracking off: the root says so", (await js(`return document.documentElement.dataset.gibEyes;`)) === "off");
  await closeSettings();
  const c = await js(`const r = companion().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x - 300, y: c.y - 300 });
  await sleep(300);
  check("eye tracking off: the eyes do not follow the cursor", await js(`return !companion().style.getPropertyValue('--look-x');`));
  await openSettings();
  await setBox("box('eyes')", true);
  await closeSettings();
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x - 320, y: c.y - 320 });
  await sleep(300);
  check("eye tracking on: they do", await js(`return parseFloat(companion().style.getPropertyValue('--look-x')) < 0;`));

  await openSettings();
  await js(`document.querySelector('[data-gib-frequency="rare"]').click(); await sleep(120);`);
  check("frequency: «Poco» chosen, with its budget shown", await js(`return document.querySelector('[data-gib-frequency="rare"]').classList.contains('on') && /3 mensajes/.test(document.querySelector('.gib-presence .field-hint').textContent);`));
  await js(`document.querySelector('[data-gib-frequency="normal"]').click(); await sleep(120);`);

  await setBox("place('companion')", false);
  check("where: no companion", await js(`return !document.querySelector('.companion');`));
  await setBox("place('companion')", true);
  check("where: companion back", Boolean(await js(`return await until(() => companion(), 2000);`)));
  await closeSettings();
  // A new console: its empty output has a Gib at his laptop.
  await palette("Nueva consola");
  await sleep(400);
  const emptyGibs = () => js(`return document.querySelectorAll('.welcome .gib, .output-empty .gib, .tree-empty .gib, .grid-empty .gib, .ai-empty .gib').length;`);
  const before = await emptyGibs();
  await openSettings();
  await setBox("place('empty')", false);
  await closeSettings();
  const afterOff = await emptyGibs();
  check("where: no Gib in empty states", before > 0 && afterOff === 0, `${before} → ${afterOff}`);
  await openSettings();
  await setBox("place('empty')", true);
  for (const name of ["splash", "overlays"]) {
    check(`where: ${name} can be switched off and on`, (await setBox(`place('${name}')`, false)) === false && (await setBox(`place('${name}')`, true)) === true);
  }

  await setBox("box('on')", false);
  const off = await js(`return { outside: outside().length, disabled: document.querySelector('.gib-presence-body').disabled };`);
  check("global off: Gib nowhere (but in the preview), the rest disabled", off.outside === 0 && off.disabled, JSON.stringify(off));
  await shot("settings-off");
  await setBox("box('on')", true);
  check("global on: he is back", Boolean(await js(`return await until(() => companion(), 2000);`)));
  await closeSettings();

  // ---------------------------------------------------------------- petting and poking a Gib (empty state)
  await palette("Nueva consola");
  await sleep(400);
  // The new console's empty output: its Gib (the one on screen; hidden tabs keep theirs).
  const target = await js(`const g = await until(() => [...document.querySelectorAll('.output-empty .gib')].find((el) => el.getBoundingClientRect().width), 3000); if (!g) return null; g.dataset.petme = '1'; const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel: '[data-petme]' };`);
  if (target) {
    await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
    await sleep(800);
    check("petting: the cursor resting on a Gib", await js(`return document.querySelector('${target.sel}').classList.contains('is-pet');`));
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await sleep(80);
    check("poking: a click", await js(`return document.querySelector('${target.sel}').classList.contains('is-poke');`));
    for (let i = 0; i < 2; i++) {
      await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await sleep(120);
    }
    check("three quick pokes: grumpy", await js(`return document.querySelector('${target.sel}').classList.contains('mood-grumpy');`));
  } else check("an empty-state Gib to pet", false, JSON.stringify(target));
} finally {
  app.close();
  browser?.kill();
}
console.log(failed ? `${failed} check(s) failed` : "gib-settings-check: all good");
process.exit(failed ? 1 : 0);
