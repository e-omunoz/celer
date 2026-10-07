// Captures the README screenshots and the demo GIF from the running desktop app.
//   1. powershell -File dev\testdb-postgres.ps1        (sample data on port 54329)
//   2. powershell -File dev\run-desktop.ps1 -NoBuild    (Celer with DevTools on port 9333)
//   3. node dev/readme-media.mjs [outDir=docs/media] [only=demo,hero,…]
// GIF encoding needs gifenc/pngjs/jpeg-js outside the project (see dev/gif.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";
import { writeGif } from "./gif.mjs";

const out = process.argv[2] || "docs/media";
const only = process.argv[3]?.split(",");
const want = (name) => !only || only.includes(name);
mkdirSync(out, { recursive: true });

const W = 1440;
const H = 900;
const app = await connect(process.env.CDP_PORT || 9333);
await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const pane = () => document.querySelector('.pane-host.active');
  const setInput = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new InputEvent('input', { bubbles: true })); };
`;
const js = (code) => app.js(HELPERS + code);

// ---------------------------------------------------------------- input (trusted events: the app ignores synthetic keys)
const VK = { Enter: 13, Escape: 27, Delete: 46, Tab: 9 };
async function press(key, mods = "") {
  const m = mods.split(",").reduce((acc, k) => acc | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[k.trim()] ?? 0), 0);
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = VK[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: m });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: m });
}
const mouse = async (x, y) => app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

/** Runs a command by its label through the action palette (Ctrl+Shift+A), like a user would. */
async function cmd(label, attempts = 3) {
  for (let i = 1; i < attempts; i++) {
    try {
      return await cmdOnce(label);
    } catch {
      await sleep(600);
    }
  }
  return cmdOnce(label);
}
async function cmdOnce(label) {
  if (await js(`return !!document.querySelector('.palette');`)) await press("Escape");
  // The SQL editor owns some shortcuts: run commands from outside it.
  await js(`document.activeElement?.blur?.();`);
  await press("a", "ctrl,shift");
  const ok = await js(`
    const input = await until(() => document.querySelector('.palette input'), 3000);
    if (!input) return false;
    setInput(input, ${JSON.stringify(label)});
    const item = await until(() => [...document.querySelectorAll('.pal-item')].find((b) => b.querySelector('.pal-label')?.textContent === ${JSON.stringify(label)}), 2000);
    if (!item) return false;
    item.click();
    await sleep(250);
    return true;
  `);
  if (!ok) {
    await press("Escape");
    throw new Error(`command not available: ${label}`);
  }
}

const still = async (name) => {
  if (!want(name)) return;
  await sleep(350);
  writeFileSync(join(out, `${name}.png`), await app.shot());
  console.log("still", name);
};

/** Records frames while `fn` runs (PNG, downscaled), then returns them with real per-frame delays. */
async function record(fn, { fps = 9, scale = 2 / 3 } = {}) {
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      frames.push({ image: await app.shot({ clip: { x: 0, y: 0, width: W, height: H, scale } }), t });
      const rest = 1000 / fps - (Date.now() - t);
      if (rest > 0) await sleep(rest);
    }
  })();
  await fn();
  await sleep(500);
  on = false;
  await loop;
  return frames.map((f, i) => ({ image: f.image, delay: i + 1 < frames.length ? frames[i + 1].t - f.t : 1600 }));
}

/** Types into the active SQL editor with real keystrokes (cps >= 400 pastes it at once). */
async function typeSql(text, cps = 38) {
  await js(`pane().querySelector('.cm-content').focus();`);
  await press("a", "ctrl");
  await press("Delete");
  if (cps >= 400) {
    await app.send("Input.insertText", { text });
    return;
  }
  for (const ch of text) {
    if (ch === "\n") {
      await press("Escape"); // close the completion popup so Enter is a line break
      await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await app.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    } else await app.send("Input.insertText", { text: ch });
    await sleep(1000 / cps);
  }
  await press("Escape");
}
async function runStatement() {
  await press("Enter", "ctrl");
  await js(`await sleep(150); await until(() => !pane().querySelector('.progress-bar') && pane().querySelector('.rtab.on')?.textContent.includes('Resultado'), 15000);`);
}
async function newConsole() {
  await press("l", "ctrl,shift");
  await js(`await until(() => pane()?.querySelector('.cm-content')); await sleep(300);`);
}

async function cleanSlate() {
  await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 15000);`);
  if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
  for (let i = 0; i < 30 && (await js(`return document.querySelectorAll('.tab').length;`)); i++) {
    await cmd("Cerrar pestaña");
    // A console with text or an edited table asks first: discard (the sample data is disposable).
    await js(`
      const b = await until(() => [...document.querySelectorAll('.modal button, .confirm button')].find((x) => /No guardar|Descartar|Cerrar sin/.test(x.textContent)), 400);
      b?.click(); await sleep(150);
    `);
  }
}
async function openPostgres() {
  await js(`
    const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
    if (!rowByText('events')) { dbl(conn); await until(() => rowByText('events'), 10000); }
    await sleep(200);
  `);
}
async function openEvents() {
  await js(`
    dbl(rowByText('events'));
    await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && pane().querySelector('.data-toolbar .muted.small')?.textContent.includes('filas') && !pane().querySelector('.progress-bar'), 10000);
  `);
}
async function filterKind(slow) {
  await js(`
    const pause = (ms) => sleep(${slow ? 1 : 0} * ms + 40);
    pane().querySelector('.tb-btn.filter').click();
    const ed = await until(() => document.querySelector('.filter-editor'));
    await pause(500);
    const sels = ed.querySelectorAll('select');
    sels[0].value = 'kind'; sels[0].dispatchEvent(new Event('change', { bubbles: true })); await pause(400);
    sels[1].value = 'in'; sels[1].dispatchEvent(new Event('change', { bubbles: true })); await pause(500);
    for (const label of ['click', 'view']) {
      [...document.querySelectorAll('.fe-value')].find((r) => r.querySelector('span').textContent === label).querySelector('input').click();
      await pause(350);
    }
    [...ed.querySelectorAll('button')].find((b) => b.textContent === 'Aplicar').click();
    await sleep(200);
    await until(() => !pane().querySelector('.data-toolbar .spin'), 8000);
  `);
}

const HERO_SQL = "-- Best customers by revenue\nSELECT c.id, c.first_name || ' ' || c.last_name AS customer, c.country, c.tier,\n       count(e.id) AS events, sum(e.amount) AS revenue, max(e.happened_at) AS last_seen\nFROM customers c\nJOIN events e ON e.customer_id = c.id\nGROUP BY c.id\nORDER BY revenue DESC NULLS LAST\nLIMIT 200;";
const DEMO_SQL = "SELECT kind, count(*) AS events, round(avg(amount), 2) AS avg_amount\nFROM events\nGROUP BY kind\nORDER BY events DESC;";

// The size emulation outlives this script unless it is cleared: always restore the real window size.
try {
// ---------------------------------------------------------------- demo GIF
if (want("demo")) {
  await cleanSlate();
  await app.send("Page.reload", {});
  await sleep(250);
  await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // Splash: Gib thinks, gets the idea and hops to the status bar.
  const frames = await record(async () => {
    await mouse(720, 300);
    await js(`await until(() => document.querySelector('.companion.landed'), 12000); await sleep(400);`);
  });
  await cleanSlate();
  await openPostgres();
  frames.push(...(await record(async () => {
    await sleep(500);
    await openEvents();
    await sleep(900);
    await filterKind(true);
    await sleep(1400);
    await newConsole();
    await typeSql(DEMO_SQL);
    await sleep(300);
    await runStatement();
    await sleep(1800);
  })));
  console.log("gif demo", writeGif(join(out, "demo.gif"), frames));
}

// ---------------------------------------------------------------- stills
await cleanSlate();
await openPostgres();
await newConsole();
await typeSql(HERO_SQL, 400);
await runStatement();
await mouse(1200, 140);
await still("hero");

if (want("light")) {
  await cmd("Tema: Celer Claro");
  await sleep(400);
  await still("light");
  await cmd("Tema: Celer Oscuro");
}

if (want("palette")) {
  await press("k", "ctrl");
  await js(`const i = await until(() => document.querySelector('.palette input')); setInput(i, 'ord'); await sleep(300);`);
  await still("palette");
  await press("Escape");
}

if (want("export")) {
  await cmd("Exportar resultado…");
  await js(`await until(() => document.querySelector('.format-card'));`);
  await still("export");
  await press("Escape");
  await sleep(250);
}

if (want("ai")) {
  await cmd("Asistente IA: preguntar o generar SQL");
  await js(`await until(() => document.querySelector('.ai-panel, .ai-setup')); await sleep(300);`);
  await still("ai");
  await cmd("Mostrar u ocultar el panel de valor");
}

if (want("table")) {
  await openEvents();
  if (!(await js(`return !!pane().querySelector('.chip');`))) await filterKind(false);
  await sleep(300);
  await still("table");
}

if (want("mcp")) {
  await cmd("Ajustes…");
  await js(`
    await until(() => document.querySelector('.settings-nav'));
    [...document.querySelectorAll('.settings-nav button')].find((b) => /MCP/.test(b.textContent))?.click();
    await sleep(400);
  `);
  await still("mcp");
  await press("Escape");
  await sleep(250);
}

if (want("guide")) {
  await cmd("Guía de inicio");
  await js(`await until(() => document.querySelector('.onboarding')); await sleep(1200);`);
  await still("guide");
  await press("Escape");
  await sleep(300);
}

} finally {
  await app.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
  app.close();
}
console.log("done");
