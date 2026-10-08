// End-to-end checks against the running desktop app (start it with dev/run-desktop.ps1).
// Usage: node dev/e2e.mjs [outDir]   — prints one line per check and exits non-zero on failure.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9333;
const outDir = process.argv[2] || `${process.env.TEMP}\\celer-e2e`;
mkdirSync(outDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
// Uncaught exceptions and console errors in the page while the checks run: any of them fails the run
// (an exception inside a Solid update aborts the whole update, so the UI silently stops reacting).
const pageErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    pageErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
await new Promise((resolve) => (ws.onopen = resolve));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
await send("Runtime.enable");
const js = async (expression) => {
  const res = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
  return res.result.value;
};

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const pane = () => document.querySelector('.pane-host.active');
`;

let failures = 0;
async function check(name, body, verify) {
  const started = Date.now();
  try {
    const value = await js(HELPERS + body);
    const ok = verify(value);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${Date.now() - started} ms)  ${String(JSON.stringify(value)).slice(0, 300)}`);
    return value;
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}  ${err.message.slice(0, 300)}`);
    return null;
  }
}

await check("splash lands and app is ready", `return !!(await until(() => document.querySelector('.companion.landed') && document.querySelector('.app.ready'), 10000));`, (v) => v === true);

await check("official engine logos", `return [...document.querySelectorAll('.tree-row.conn .engine-icon')].map((s) => s.querySelector('title')?.textContent || (s.classList.contains('neutral') ? 'neutral' : '?'));`, (v) => Array.isArray(v) && v.includes("PostgreSQL"));

await check("connect PostgreSQL and auto-expand", `
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  dbl(conn);
  const events = await until(() => rowByText('events'), 10000);
  return { events: !!events, mariadbLogo: null };
`, (v) => v.events);

await check("open events table", `
  dbl(rowByText('events'));
  const ok = await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && !pane().querySelector('.progress-bar') && pane().querySelector('.data-toolbar .muted.small')?.textContent.includes('filas'), 10000);
  return pane().querySelector('.data-toolbar .muted.small')?.textContent;
`, (v) => typeof v === "string" && /500\+ filas/.test(v.replace(/\\s/g, " ")));

await check("filter: kind in (click, view) via the editor", `
  pane().querySelector('.tb-btn.filter').click();
  const ed = await until(() => document.querySelector('.filter-editor'));
  const sels = ed.querySelectorAll('select');
  sels[0].value = 'kind'; sels[0].dispatchEvent(new Event('change', { bubbles: true })); await sleep(30);
  sels[1].value = 'in'; sels[1].dispatchEvent(new Event('change', { bubbles: true })); await sleep(80);
  for (const label of ['click', 'view']) {
    const row = [...document.querySelectorAll('.fe-value')].find((r) => r.querySelector('span').textContent === label);
    row.querySelector('input').click(); await sleep(30);
  }
  [...ed.querySelectorAll('button')].find((b) => b.textContent === 'Aplicar').click();
  await sleep(150);
  await until(() => !pane().querySelector('.data-toolbar .spin'), 8000);
  return { chips: [...pane().querySelectorAll('.chip-body')].map((c) => c.textContent) };
`, (v) => v.chips.length === 1 && v.chips[0].includes("click") && v.chips[0].includes("view"));

await check("exact count with the filter", `
  [...pane().querySelectorAll('.data-toolbar button')].find((b) => b.textContent.trim() === 'Contar').click();
  const tag = await until(() => pane().querySelector('.tag.count'), 8000);
  return tag?.textContent;
`, (v) => typeof v === "string" && /100[.,]000 en total/.test(v));

await check("contains filter escapes % and _", `
  pane().querySelector('.tb-btn.filter').click();
  const ed = await until(() => document.querySelector('.filter-editor'));
  const sels = ed.querySelectorAll('select');
  sels[0].value = 'kind'; sels[0].dispatchEvent(new Event('change', { bubbles: true })); await sleep(30);
  sels[1].value = 'contains'; sels[1].dispatchEvent(new Event('change', { bubbles: true })); await sleep(50);
  const input = ed.querySelector('.field input');
  input.value = 'cl_ck'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); await sleep(30);
  [...ed.querySelectorAll('button')].find((b) => b.textContent === 'Aplicar').click();
  await sleep(200);
  await until(() => !pane().querySelector('.data-toolbar .spin'), 8000);
  return pane().querySelector('.data-toolbar .muted.small')?.textContent;
`, (v) => typeof v === "string" && v.replace(/\s/g, " ").startsWith("0 filas"));

await check("remove all filters", `
  [...pane().querySelectorAll('.filter-chips .link')].find((b) => b.textContent === 'Quitar todos').click();
  await sleep(200);
  await until(() => !pane().querySelector('.data-toolbar .spin'), 8000);
  return { chips: pane().querySelectorAll('.chip').length, rows: pane().querySelector('.data-toolbar .muted.small')?.textContent };
`, (v) => v.chips === 0 && /500\+/.test(v.rows));

await check("server-side sort from the header menu", `
  const grid = pane().querySelector('.grid-scroll');
  const r = grid.getBoundingClientRect();
  grid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 70, clientY: r.top + 14 }));
  const item = await until(() => [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Orden descendente')));
  item.click();
  await sleep(200);
  await until(() => !pane().querySelector('.data-toolbar .spin'), 8000);
  // read the first row through the record inspector
  grid.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 70, clientY: r.top + 30 + 12 }));
  window.dispatchEvent(new MouseEvent('mouseup'));
  await sleep(100);
  document.querySelector('.stripe-btn[title^="Asistente"]') && null;
  [...pane().querySelectorAll('.tb-icon')].find((b) => b.title.startsWith('Panel de valor')).click();
  await sleep(150);
  [...document.querySelectorAll('.inspector .seg button')].find((b) => b.textContent.includes('Registro')).click();
  await sleep(150);
  const first = document.querySelector('.record-field .record-value')?.textContent;
  return first;
`, (v) => v === "200000");

const exportsDir = outDir.replace(/\\/g, "\\\\");
const formats = ["csv", "tsv", "json", "sql", "markdown", "html", "xlsx"];
const exported = await check("export every format (streaming, 200k rows)", `
  const conns = await inv('list_connections');
  const pg = conns.find((c) => c.name === 'Postgres local');
  const out = {};
  for (const f of ${JSON.stringify(formats)}) {
    const ext = f === 'markdown' ? 'md' : f;
    const t = performance.now();
    const rows = await inv('export_query', { connId: pg.id, database: 'celer', sql: 'SELECT * FROM events ORDER BY id', exportId: 'e2e-' + f, options: { format: f, path: '${exportsDir}\\\\events.' + ext, delimiter: ',', header: true, bom: true, tableName: 'events_copy', nullText: '', sqlBatch: 100 } });
    out[f] = { rows, ms: Math.round(performance.now() - t) };
  }
  return out;
`, (v) => v && formats.every((f) => v[f]?.rows === 200000));
if (exported) {
  const head = (f) => readFileSync(`${outDir}\\events.${f}`, "utf8").slice(0, 160).replace(/\r?\n/g, "⏎");
  for (const f of ["csv", "tsv", "json", "sql", "md", "html"]) console.log(`      ${f.padEnd(4)} ${(statSync(`${outDir}\\events.${f}`).size / 1e6).toFixed(1)} MB  ${head(f)}`);
  console.log(`      xlsx ${(statSync(`${outDir}\\events.xlsx`).size / 1e6).toFixed(1)} MB  exists=${existsSync(`${outDir}\\events.xlsx`)}`);
}

await check("AI key lives in the OS credential store", `
  await inv('ai_key_set', { key: 'sk-ant-e2e-not-real' });
  const a = await inv('ai_key_status');
  const b = await inv('ai_key_get');
  await inv('ai_key_set', { key: '' });
  const c = await inv('ai_key_status');
  return { savedStatus: a, roundTrip: b === 'sk-ant-e2e-not-real', afterDelete: c };
`, (v) => v.savedStatus === true && v.roundTrip && v.afterDelete === false);

await check("MCP: defaults are safe and preview works", `
  const cfg = await inv('mcp_config_get');
  const preview = await inv('mcp_test_tool', { name: 'list_connections', args: {} });
  const info = await inv('mcp_client_info');
  return { enabled: cfg.enabled, levels: Object.values(cfg.connections).map((c) => c.level), preview: preview.text?.slice(0, 120), cmd: info.claudeCodeCommand };
`, (v) => v.enabled === false && v.levels.every((l) => l === "none"));

await check("read-only connection rejects a write hidden in a batch", `
  const saved = await inv('save_connection', { cfg: { id: '', name: 'e2e-readonly', kind: 'postgres', host: 'localhost', port: 54329, instance: '', database: 'celer', user: 'celer', password: 'celer', savePassword: false, integratedAuth: false, encryption: 'login', trustCert: true, informixMode: 'drda', odbcConnStr: '', extra: '', color: '', production: false, readOnly: true, folder: 'e2e', filePath: '' } });
  const s = await inv('open_session', { connId: saved.id, password: 'celer' });
  const results = {};
  for (const [name, sql] of [['plain', 'SELECT 1'], ['batch', 'SELECT 1; DELETE FROM events WHERE id < 0'], ['cte', 'WITH d AS (DELETE FROM events WHERE id < 0 RETURNING *) SELECT * FROM d'], ['string', "SELECT 'DELETE FROM x'"]]) {
    try { await inv('execute', { sessionId: s.sessionId, sql, fetch: 5 }); results[name] = 'ran'; } catch (e) { results[name] = 'blocked'; }
  }
  await inv('close_session', { sessionId: s.sessionId });
  await inv('delete_connection', { id: saved.id });
  return results;
`, (v) => v.plain === "ran" && v.batch === "blocked" && v.cte === "blocked" && v.string === "ran");

// Real keystrokes through CDP: caret right after the first ';' then Ctrl+Enter.
const key = async (k, mods = 0, code = k.length === 1 ? `Key${k.toUpperCase()}` : k, vk = { Enter: 13, Home: 36, End: 35 }[k] ?? k.toUpperCase().charCodeAt(0)) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
await js(HELPERS + `
  const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('Postgres local'));
  tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await sleep(200);
  pane().querySelector('.cm-content').focus();
`);
await key("a", 2);
await send("Input.insertText", { text: "SELECT 41 + 1 AS answer;\nSELECT 0 AS wrong;" });
await key("Home", 2);
await key("End");
await key("Enter", 2);
await check("Ctrl+Enter right after ';' runs that statement", `
  await until(() => pane().querySelector('.rtab.on')?.textContent.includes('Resultado'), 10000);
  [...pane().querySelectorAll('.rtab')].find((b) => b.textContent.includes('Salida')).click();
  await until(() => pane().querySelector('.out-entry'), 3000);
  const out = [...pane().querySelectorAll('.out-entry code')].map((c) => c.textContent);
  return out[out.length - 1] ?? "";
`, (v) => typeof v === "string" && v.includes("41 + 1"));
const relevant = pageErrors.filter((text) => !/Failed to load resource/.test(text));
console.log(`${relevant.length ? "FAIL" : "PASS"}  no uncaught errors in the page  ${JSON.stringify(relevant.slice(0, 5)).slice(0, 600)}`);
if (relevant.length) failures++;
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
ws.close();
process.exit(failures ? 1 : 0);
