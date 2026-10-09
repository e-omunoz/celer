// Pinning and comparing query results (#119) in the desktop app (dev/run-desktop.ps1), on every connection named in
// CONNS (comma-separated, as in the explorer; default "Postgres local"): a seeded table rc_check is read in a
// console, the result pinned, the table changed and the query run again; the pinned result keeps its rows and the
// comparison shows one changed row, one only in A and one only in B, matched by the primary key found for the table.
// «Solo diferencias» and the CSV export are checked, and the first connection's result is compared with each other
// connection's (cross-engine: 12.50 / 12.5, true / 1, dates written differently are equal).
// Usage: CONNS="Postgres local,MySQL,MariaDB,SQL Server,Informix DRDA,Informix JDBC,SQLite,ODBC pg" node dev/result-compare-check.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const CONNS = (process.env.CONNS || "Postgres local").split(",").map((s) => s.trim()).filter(Boolean);
const app = await connect(process.env.CDP_PORT || 9333);
const out = resolve(import.meta.dirname, "..", "review-out", "result-compare");
mkdirSync(out, { recursive: true });
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const connRow = (name) => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.querySelector('.tree-name')?.textContent === name || e.textContent.includes(name));
  const menuItem = (re) => until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 4000);
  const pane = () => document.querySelector('.pane-host.active');
  const conn = async (name) => (await inv('list_connections')).find((x) => x.name === name);
  const sql = async (name, text) => {
    const c = await conn(name);
    const s = await inv('open_session', { connId: c.id, password: null });
    try { return await inv('execute', { sessionId: s.sessionId, sql: text, fetch: 100 }); } finally { await inv('close_session', { sessionId: s.sessionId }); }
  };
  const report = () => {
    const v = pane()?.querySelector('.compare-view');
    if (!v) return null;
    return { sides: [...v.querySelectorAll('.compare-side b')].map((b) => b.textContent), chips: [...v.querySelectorAll('.compare-chip')].map((c) => c.textContent), key: v.querySelector('.compare-keys .btn')?.textContent ?? '', notes: [...v.querySelectorAll('.compare-note')].map((n) => n.textContent) };
  };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 500)}`}`);
  if (!ok) failed++;
};
async function key(k, mods = 0) {
  const vk = { Enter: 13, Escape: 27 }[k] ?? k.toUpperCase().charCodeAt(0);
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}

/** The table and its rows in each dialect (boolean and date types differ). */
function seed(kind) {
  const bool = { postgres: "boolean", mysql: "boolean", mssql: "bit", informix: "boolean", sqlite: "boolean" }[kind] ?? "boolean";
  const t = { postgres: "true", mysql: "1", mssql: "1", informix: "'t'", sqlite: "1" }[kind] ?? "1";
  const f = { postgres: "false", mysql: "0", mssql: "0", informix: "'f'", sqlite: "0" }[kind] ?? "0";
  const date = (iso) => (kind === "informix" ? `DATE('${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}')` : `'${iso}'`);
  return [
    kind === "mssql" ? "IF OBJECT_ID('rc_check') IS NOT NULL DROP TABLE rc_check" : kind === "informix" ? "DROP TABLE IF EXISTS rc_check" : "DROP TABLE IF EXISTS rc_check",
    `CREATE TABLE rc_check (id int NOT NULL PRIMARY KEY, nombre varchar(40), saldo decimal(10,2), activo ${bool}, alta date)`,
    `INSERT INTO rc_check VALUES (1, 'Ana', 12.50, ${t}, ${date("2024-03-15")})`,
    `INSERT INTO rc_check VALUES (2, 'Luis', 0, ${f}, ${date("2023-01-02")})`,
    `INSERT INTO rc_check VALUES (3, 'Mia', NULL, NULL, NULL)`,
  ];
}

async function runInConsole(text) {
  await js(`pane().querySelector('.cm-content').focus();`);
  await key("a", 2);
  await app.send("Input.insertText", { text });
  await key("Enter", 2);
  await js(`await sleep(200); await until(() => !pane().querySelector('.tb-btn.stop') && pane().querySelector('.grid-canvas'), 30000); await sleep(400);`);
}

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await key("Escape");

const consoles = [];
for (const name of CONNS) {
  const kind = await js(`return (await conn(${JSON.stringify(name)}))?.kind ?? null;`);
  if (!kind) {
    check(`${name}: connection exists`, false, "not found");
    continue;
  }
  const seeded = await js(`
    try { for (const s of ${JSON.stringify(seed(kind))}) { try { await sql(${JSON.stringify(name)}, s); } catch (e) { if (!/^DROP|^IF/.test(s)) throw e; } } return 'ok'; } catch (e) { return String(e); }
  `);
  check(`${name} (${kind}): rc_check seeded`, seeded === "ok", seeded);
  if (seeded !== "ok") continue;
  // A console of this connection (its explorer menu), the table read and pinned.
  await js(`
    const row = connRow(${JSON.stringify(name)});
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }));
    (await menuItem(/^Nueva consola$/))?.click();
    await until(() => pane()?.querySelector('.cm-content'));
    await sleep(500);
  `);
  await runInConsole("SELECT id, nombre, saldo, activo, alta FROM rc_check ORDER BY id");
  const tabId = await js(`return document.querySelector('.tab.active, .tab.on')?.dataset.id ?? null;`);
  consoles.push({ name, kind, tabId });
  await js(`[...pane().querySelectorAll('.results-head .tb-icon')].find((b) => /^Fijar resultado/.test(b.title)).click(); await sleep(300);`);
  const pinned = await js(`return [...pane().querySelectorAll('.rtab.pinned')].map((t) => t.textContent);`);
  check(`${name}: «Fijar resultado» adds a pinned result with its rows`, pinned.length === 1 && /Fijado 1\s*3/.test(pinned[0]), JSON.stringify(pinned));
  // The data changes; the query runs again: a new result, the pinned one unchanged.
  const changed = await js(`
    try {
      await sql(${JSON.stringify(name)}, "UPDATE rc_check SET nombre = 'Luisa' WHERE id = 2");
      await sql(${JSON.stringify(name)}, "DELETE FROM rc_check WHERE id = 3");
      await sql(${JSON.stringify(name)}, "INSERT INTO rc_check (id, nombre) VALUES (4, 'Nora')");
      return 'ok';
    } catch (e) { return String(e); }
  `);
  check(`${name}: table changed`, changed === "ok", changed);
  await runInConsole("SELECT id, nombre, saldo, activo, alta FROM rc_check ORDER BY id");
  const after = await js(`
    const pin = [...pane().querySelectorAll('.rtab.pinned')][0];
    return { pin: pin?.textContent ?? '', current: [...pane().querySelectorAll('.rtab')].find((t) => /Resultado/.test(t.textContent))?.textContent ?? '' };
  `);
  check(`${name}: re-run keeps the pinned result's rows`, /Fijado 1\s*3/.test(after.pin) && /Resultado 1\s*3/.test(after.current), JSON.stringify(after));
  // «Comparar con…» → the pinned result.
  const r = await js(`
    [...pane().querySelectorAll('.results-head .tb-icon')].find((b) => /^Comparar con/.test(b.title)).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 600, clientY: 300 }));
    (await menuItem(/^Fijado 1/))?.click();
    await until(() => report()?.chips.length);
    await sleep(1500); // the primary key is looked up on the console's session
    return report();
  `);
  check(`${name}: counts (1 equal, 1 changed, 1 only in B, 1 only in A)`, JSON.stringify(r?.chips) === JSON.stringify(["1 iguales", "1 cambiadas", "1 solo en B", "1 solo en A"]), JSON.stringify(r));
  check(`${name}: matched by the table's primary key`, /^\s*Clave: id \(clave primaria\)/i.test(r?.key ?? "") || /Clave: (id|ID) \(clave primaria\)/.test(r?.key ?? ""), r?.key);
  const only = await js(`
    pane().querySelector('.compare-only input').click();
    await sleep(300);
    const r = report();
    window.__celerNextSavePath = ${JSON.stringify(resolve(out, `diff-${kind}-${consoles.length}.csv`))};
    [...pane().querySelectorAll('.compare-bar .btn')].find((b) => /Exportar/.test(b.textContent)).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 700, clientY: 300 }));
    (await menuItem(/a CSV/))?.click();
    await sleep(800);
    return r;
  `);
  check(`${name}: «Solo diferencias» keeps the counts`, JSON.stringify(only?.chips) === JSON.stringify(r?.chips), JSON.stringify(only));
  let csv = "";
  try {
    csv = readFileSync(resolve(out, `diff-${kind}-${consoles.length}.csv`), "utf8");
  } catch {}
  const lines = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
  check(`${name}: exported CSV has the 3 differing rows with their state and the old value`, lines.length === 4 && /^estado,id,nombre/.test(lines[0]) && /nombre \(antes\)/.test(lines[0]) && lines.some((l) => /^cambiada,2,Luisa,.*Luis$/.test(l)) && lines.some((l) => /^solo en Fijado 1,3,Mia/.test(l)) && lines.some((l) => /^solo en Resultado 1,4,Nora/.test(l)), csv);
  await js(`pane().querySelector('.compare-view .icon-btn[title="Cerrar la comparación"]').click(); await sleep(200);`);
  await app.send("Page.captureScreenshot", { format: "png" }).catch(() => {});
}

// Across engines: the first console's current result against each other console's (same rows after the changes).
const [first, ...rest] = consoles;
for (const other of rest) {
  const r = await js(`
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.dataset.id === ${JSON.stringify(first.tabId)});
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await sleep(300);
    [...pane().querySelectorAll('.results-head .rtab')].find((t) => /Resultado 1/.test(t.textContent))?.click();
    await sleep(200);
    [...pane().querySelectorAll('.results-head .tb-icon')].find((b) => /^Comparar con/.test(b.title)).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 600, clientY: 300 }));
    const items = await until(() => [...document.querySelectorAll('.menu .menu-item')].length && [...document.querySelectorAll('.menu .menu-item')]);
    // The group of the other console, then its «Resultado 1».
    const at = items.findIndex((b) => b.disabled && b.textContent.includes(${JSON.stringify(other.name)}));
    const pick = items.slice(at + 1).find((b) => /^Resultado 1/.test(b.textContent));
    pick?.click();
    await until(() => report()?.chips.length);
    await sleep(1500);
    const r = report();
    pane().querySelector('.compare-view .icon-btn[title="Cerrar la comparación"]')?.click();
    return r;
  `);
  check(`${first.name} vs ${other.name}: the same rows read from two engines are equal`, JSON.stringify(r?.chips) === JSON.stringify(["3 iguales", "0 cambiadas", "0 solo en B", "0 solo en A"]), JSON.stringify(r));
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
app.close();
process.exit(failed ? 1 : 0);
