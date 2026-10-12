// The UI reorganisation (#111), submenus, the theme editor (#107) and F6 (#110), walked in a headless browser on the
// browser preview (demo SQLite backend, `npm run dev` or `npx vite preview`): top bar, «Importar conexiones ›»,
// explorer menus, «Generar SQL ›» / «Comparar ›», «Ver DDL» › «Abrir en consola», the cell menu's «Copiar como ›» and
// «Filtrar ›», the right panel's title, the settings groups, the theme editor (live preview, save and use, reopen,
// unsaved changes), F6 and the connection dialog's Entorno row.
// Usage: node dev/layout-check.mjs [url = http://localhost:1420/] [outDir for screenshots]
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

const url = process.argv[2] || "http://localhost:1420/";
const out = process.argv[3] || "";
if (out) mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT || 9491);
const browser = await headlessBrowser({ port, width: 1440, height: 900 });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 600)}`}`);
  if (!ok) failed++;
};
try {
  await sleep(1200);
  const app = await connect(port, { window: 0 });
  await app.send("Page.enable");
  await app.send("Page.navigate", { url });
  await sleep(2500);
  const errors = await app.watchErrors();
  const H = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
    const txt = (el) => el?.textContent.replace(/\\s+/g, " ").trim() ?? null;
    const panels = () => [...document.querySelectorAll('.menu')];
    const items = (level = 0) => [...(panels()[level]?.querySelectorAll(':scope > .menu-item') ?? [])];
    const labels = (level = 0) => items(level).map((b) => txt(b.querySelector('.menu-label')) + (b.classList.contains('has-sub') ? ' ›' : '') + (b.querySelector('kbd') ? ' [' + txt(b.querySelector('kbd')) + ']' : ''));
    const key = (k, target = document.activeElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const closeMenus = () => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  `;
  const js = (code) => app.js(H + code);
  const shot = async (name) => out && writeFileSync(`${out}/${name}.png`, await app.shot());
  await js(`await until(() => document.querySelector('.app.ready'), 15000); await sleep(800);`);
  // The guide may be open on a first run.
  await js(`for (let i = 0; i < 4 && document.querySelector('.onboarding'); i++) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.onboarding')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400); } const skip = [...document.querySelectorAll('.onboarding button')].find((b) => /saltar|cerrar|empezar/i.test(b.textContent)); skip?.click(); await sleep(500);`);
  await shot("00-start");

  // ---- #111: top bar without the explorer button; stripe toggles it
  const top = await js(`return { explorerBtn: [...document.querySelectorAll('.topbar .top-icon')].some((b) => /Explorador/.test(b.title)), stripe: !!document.querySelector('.stripe-btn[title^="Explorador"]'), variables: !!document.querySelector('.stripe-btn[title^="Variables"]') };`);
  check("top bar has no explorer button; the stripe has it and Variables", !top.explorerBtn && top.stripe && top.variables, JSON.stringify(top));

  // ---- #111: Nuevo › Importar conexiones submenu, keyboard operated
  const nuevo = await js(`
    [...document.querySelectorAll('.topbar .top-btn')].find((b) => /Nuevo/.test(b.textContent)).click();
    await until(() => panels().length);
    await sleep(200);
    const root = labels(0);
    // Keyboard: down to the submenu row, → opens it with its first item active, ← goes back.
    const menu = panels()[0];
    for (let i = 0; i < 6 && !items(0).find((b) => b.classList.contains('active') && b.classList.contains('has-sub')); i++) { key('ArrowDown', menu); await sleep(30); }
    key('ArrowRight', menu);
    await until(() => panels().length === 2);
    await sleep(150);
    const sub = labels(1);
    const subFocused = document.activeElement === panels()[1];
    const firstActive = txt(items(1).find((b) => b.classList.contains('active'))?.querySelector('.menu-label'));
    const r0 = panels()[0].getBoundingClientRect(), r1 = panels()[1].getBoundingClientRect();
    return { root, sub, subFocused, firstActive, beside: r1.left >= r0.right - 12 && r1.left <= r0.right + 4, inside: r1.right <= innerWidth && r1.bottom <= innerHeight };
  `);
  await shot("01-nuevo-importar");
  check("Nuevo has one «Importar conexiones ›»", nuevo.root.filter((l) => /Importar/.test(l)).length === 1 && nuevo.root.some((l) => /^Importar conexiones ›/.test(l)), JSON.stringify(nuevo.root));
  check("its submenu: fichero de Celer, DBeaver, DbVisualizer", JSON.stringify(nuevo.sub) === JSON.stringify(["Fichero de Celer…", "DBeaver…", "DbVisualizer…"]), JSON.stringify(nuevo.sub));
  check("→ opens the submenu with its first item active and the focus in it", nuevo.subFocused && nuevo.firstActive === "Fichero de Celer…", JSON.stringify(nuevo));
  check("the submenu sits beside its row, on screen", nuevo.beside && nuevo.inside, JSON.stringify(nuevo));
  const back = await js(`key('ArrowLeft', panels()[1]); await sleep(100); const one = panels().length === 1 && document.activeElement === panels()[0]; key('Escape', panels()[0]); await sleep(300); return { one, closed: panels().length === 0 };`);
  check("← closes the submenu back to its row; Esc closes the menu", back.one && back.closed, JSON.stringify(back));

  // ---- #111: explorer options and background menus
  const exp = await js(`
    if (!document.querySelector('.explorer')) document.querySelector('.stripe-btn[title^="Explorador"]').click();
    await until(() => document.querySelector('.explorer'));
    const opts = [...document.querySelectorAll('.explorer button')].find((b) => /Orden, exportar/.test(b.title || ''));
    let options = null;
    if (opts) { opts.click(); await until(() => panels().length); await sleep(150); options = labels(0); closeMenus(); await sleep(300); }
    const tree = document.querySelector('.explorer .tree') || document.querySelector('.explorer');
    const r = tree.getBoundingClientRect();
    tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.bottom - 20 }));
    await until(() => panels().length); await sleep(150);
    const background = labels(0);
    closeMenus(); await sleep(300);
    return { options, background };
  `);
  check("explorer options menu has «Importar conexiones ›»", (exp.options ?? []).some((l) => /^Importar conexiones ›/.test(l)), JSON.stringify(exp.options));
  check("the background menu no longer repeats the import", !exp.background.some((l) => /Importar/.test(l)), JSON.stringify(exp.background));

  // ---- #111: table menu (demo SQLite): Generar SQL ›, Comparar ›, Ver DDL once
  const tbl = await js(`
    const conn = document.querySelector('.tree-row.conn');
    if (conn && !conn.classList.contains('connected')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => document.querySelector('.tree-row.conn.connected'), 8000); }
    await sleep(800);
    const rowOf = () => [...document.querySelectorAll('.tree-row')].find((e) => /^(customers|clientes|orders|pedidos)$/.test(txt(e.querySelector('.tree-name')) ?? ''));
    for (let i = 0; i < 6 && !rowOf(); i++) {
      for (const e of [...document.querySelectorAll('.tree-row')]) if (e.querySelector('.twist') && !e.classList.contains('open') && !e.classList.contains('conn')) { e.querySelector('.twist')?.click(); }
      await sleep(600);
    }
    const row = rowOf();
    if (!row) return { found: false, rows: [...document.querySelectorAll('.tree-row .tree-name')].map(txt).slice(0, 30) };
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 8 }));
    await until(() => panels().length); await sleep(150);
    const root = labels(0);
    items(0).find((b) => /^Generar SQL/.test(txt(b))).click();
    await until(() => panels().length === 2); await sleep(150);
    const gen = labels(1);
    return { found: true, name: txt(row.querySelector('.tree-name')), root, gen };
  `);
  await shot("02-table-generar");
  if (!tbl.found) check("a demo table in the explorer", false, JSON.stringify(tbl.rows));
  else {
    check("table menu: open, structure, DDL, diagram on top", /^Abrir datos/.test(tbl.root[0]) && /^Abrir estructura/.test(tbl.root[1]) && /^Ver DDL/.test(tbl.root[2]), JSON.stringify(tbl.root));
    check("one «Ver DDL», no «DDL en consola»", tbl.root.filter((l) => /DDL/.test(l)).length === 1, JSON.stringify(tbl.root));
    check("«Generar SQL ›» with the eight entries", tbl.gen.length === 8 && /^SELECT/.test(tbl.gen[0]) && tbl.gen.some((l) => /^DROP TABLE/.test(l)), JSON.stringify(tbl.gen));
    check("«Comparar ›» on the table menu", tbl.root.some((l) => /^Comparar ›/.test(l)) && !tbl.root.some((l) => /comparar datos/i.test(l)), JSON.stringify(tbl.root));
    const cmp = await js(`closeMenus(); await sleep(300); const row = [...document.querySelectorAll('.tree-row')].find((e) => txt(e.querySelector('.tree-name')) === ${JSON.stringify(tbl.name)}); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 8 })); await until(() => panels().length); await sleep(150); const c = items(0).find((b) => /^Comparar/.test(txt(b))); c.dispatchEvent(new MouseEvent('mouseenter')); await until(() => panels().length === 2, 2000); await sleep(150); return labels(1);`);
    check("hovering «Comparar ›» opens its two entries", cmp.length === 2 && /para comparar datos/.test(cmp[0]) && /^Comparar datos con/.test(cmp[1]), JSON.stringify(cmp));
    await shot("03-table-comparar");
    // Ver DDL opens the DDL tab with «Abrir en consola».
    const ddl = await js(`closeMenus(); await sleep(300); const row = [...document.querySelectorAll('.tree-row')].find((e) => txt(e.querySelector('.tree-name')) === ${JSON.stringify(tbl.name)}); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 8 })); await until(() => panels().length); items(0).find((b) => /^Ver DDL/.test(txt(b))).click(); const btn = await until(() => [...document.querySelectorAll('.pane-host.active .ddl-actions button')].find((b) => /Abrir en consola/.test(b.textContent)), 6000); if (!btn) return { btn: false }; await until(() => !btn.disabled, 4000); const tabs = document.querySelectorAll('.tab').length; btn.click(); await sleep(800); return { btn: true, opened: document.querySelectorAll('.tab').length === tabs + 1, text: document.querySelector('.pane-host.active .cm-content')?.innerText.slice(0, 80) };`);
    check("the DDL tab's «Abrir en consola» opens the DDL in a console", ddl.btn && ddl.opened && /CREATE/i.test(ddl.text ?? ""), JSON.stringify(ddl));
  }

  // ---- #111: grid cell menu (run a query in the demo console)
  const grid = await js(`
    const row = [...document.querySelectorAll('.tree-row')].find((e) => /^(customers|clientes|orders|pedidos)$/.test(txt(e.querySelector('.tree-name')) ?? ''));
    if (row) { const rr = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rr.left + 40, clientY: rr.top + 8 })); await until(() => panels().length); items(0).find((b) => /^Abrir datos/.test(txt(b))).click(); }
    await sleep(500);
    [...document.querySelectorAll('.pane-host.active button')].find((b) => txt(b) === 'Datos')?.click();
    await until(() => document.querySelector('.pane-host.active .grid canvas'), 8000);
    await sleep(1200);
    const g = document.querySelector('.pane-host.active .grid');
    if (!g) return { grid: false, active: txt(document.querySelector('.tab.on')), section: [...document.querySelectorAll('.pane-host.active .sec-tab, .pane-host.active .seg button.on')].map(txt), html: document.querySelector('.pane-host.active')?.className };
    const r = g.getBoundingClientRect();
    g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 90, clientY: r.top + 45, button: 0, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 90, clientY: r.top + 45, button: 0 }));
    await sleep(100);
    g.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 90, clientY: r.top + 45 }));
    await until(() => panels().length); await sleep(150);
    const root = labels(0);
    const copyAs = items(0).find((b) => /^Copiar como/.test(txt(b)));
    copyAs?.click();
    await until(() => panels().length === 2, 2000); await sleep(150);
    const sub = labels(1);
    const filter = items(0).find((b) => /^Filtrar/.test(txt(b)));
    filter?.dispatchEvent(new MouseEvent('mouseenter'));
    await sleep(400);
    const filterSub = labels(1);
    return { grid: true, root, sub, filterSub };
  `);
  await shot("04-grid-copiar-como");
  if (grid.grid) {
    check("cell menu: Copiar, Copiar con cabeceras, Copiar como ›", /^Copiar \[/.test(grid.root[0]) && /^Copiar con cabeceras/.test(grid.root[1]) && /^Copiar como ›/.test(grid.root[2]), JSON.stringify(grid.root));
    check("«Copiar como ›»: CSV, JSON, Markdown, XML, INSERT, IN, WHERE", JSON.stringify(grid.sub) === JSON.stringify(["CSV", "JSON", "Markdown", "XML", "SQL INSERT", "Lista IN (…)", "WHERE"]), JSON.stringify(grid.sub));
    check("«Filtrar ›» on the cell menu of a table, with its five entries", grid.root.some((l) => /^Filtrar ›/.test(l)) && grid.filterSub.length === 5 && /^Por este valor/.test(grid.filterSub[0]), JSON.stringify(grid));
  } else check("a result grid in the demo console", false, JSON.stringify(grid));
  await js(`closeMenus(); await sleep(300);`);

  // ---- #111: right panel header
  const insp = await js(`
    document.querySelector('.stripe-btn[title^="Historial"]').click();
    await until(() => document.querySelector('.inspector')); await sleep(300);
    const history = { seg: !!document.querySelector('.inspector .toolwin-head .seg'), title: txt(document.querySelector('.inspector .inspector-title')) };
    document.querySelector('.stripe-btn[title^="Biblioteca"]').click(); await sleep(300);
    const library = txt(document.querySelector('.inspector .inspector-title'));
    return { history, library };
  `);
  await shot("05-inspector-title");
  check("right panel: a tool shows only its title", !insp.history.seg && insp.history.title === "Historial" && insp.library === "Biblioteca", JSON.stringify(insp));

  // ---- #107 + #111: settings grouped, theme editor section
  const st = await js(`
    document.querySelector('.stripe-btn[title^="Ajustes"]').click();
    await until(() => document.querySelector('.settings-nav')); await sleep(300);
    const groups = [...document.querySelectorAll('.settings-group')].map((g) => ({ label: txt(g.querySelector('.settings-group-label')), items: [...g.querySelectorAll('button')].map(txt) }));
    return groups;
  `);
  await shot("06-settings-groups");
  check("settings nav grouped General, Editor, Conexiones, IA y MCP", JSON.stringify(st.map((g) => g.label)) === JSON.stringify(["General", "Editor", "Conexiones", "IA y MCP"]), JSON.stringify(st));
  check("the theme editor sits in General", st[0]?.items.includes("Editor de tema"), JSON.stringify(st[0]));
  const te = await js(`
    [...document.querySelectorAll('.settings-nav button')].find((b) => txt(b) === 'Apariencia').click(); await sleep(300);
    [...document.querySelectorAll('.settings-body button')].find((b) => /Editor de tema/.test(b.textContent)).click();
    await until(() => document.querySelector('.theme-editor')); await sleep(500);
    const before = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    [...document.querySelectorAll('.te-groups button')].find((b) => /Superficies/.test(b.textContent)).click(); await sleep(200);
    const input = document.querySelector('.te-token .te-value');
    input.value = '#123456'; input.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
    const live = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const contrast = document.querySelectorAll('.te-contrast li').length;
    return { before, live, contrast, nav: txt(document.querySelector('.settings-nav button.on')) };
  `);
  await shot("07-theme-editor");
  check("the editor shows a changed colour live", te.live.toLowerCase() === "#123456", JSON.stringify(te));
  check("contrast checker lists its pairs", te.contrast >= 10, JSON.stringify(te));
  const saved = await js(`
    [...document.querySelectorAll('.te-foot button')].find((b) => /Guardar y usar/.test(b.textContent)).click(); await sleep(600);
    // Back to Apariencia: the custom theme is next to the built-in ones; reopen it in the editor.
    [...document.querySelectorAll('.settings-nav button')].find((b) => txt(b) === 'Apariencia').click(); await sleep(400);
    const card = document.querySelector('.theme-card.custom');
    const name = txt(card?.querySelector('.theme-card-pick > span:last-child'));
    card?.querySelector('.theme-card-edit')?.click();
    const reopened = await until(() => document.querySelector('.theme-editor'), 3000);
    await sleep(300);
    return { card: !!card, on: card?.classList.contains('on'), name, reopened: !!reopened, value: document.querySelector('.te-name')?.value };
  `);
  check("«Guardar y usar» adds a custom theme card in use, and it reopens in the editor", saved.card && saved.on && saved.reopened && saved.value === saved.name, JSON.stringify(saved));
  await shot("08-theme-reopened");
  // Leaving the section with unsaved changes asks first.
  const guard = await js(`
    const input = document.querySelector('.te-name'); input.value = 'Cambiado'; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    [...document.querySelectorAll('.settings-nav button')].find((b) => txt(b) === 'Editor').click();
    const ask = await until(() => [...document.querySelectorAll('.dialog')].find((d) => /Descartar los cambios/.test(d.textContent)), 2000);
    const still = !!document.querySelector('.theme-editor');
    if (ask) [...ask.querySelectorAll('button')].find((b) => /Cancelar|No/.test(b.textContent))?.click();
    await sleep(300);
    return { ask: !!ask, still, after: !!document.querySelector('.theme-editor') };
  `);
  check("leaving the editor with changes asks first", guard.ask && guard.still && guard.after, JSON.stringify(guard));
  // Search deep link and palette command.
  const deep = await js(`
    const search = document.querySelector('.settings-search input'); search.value = 'contraste'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
    const hit = [...document.querySelectorAll('.settings-result')].map(txt);
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    return hit;
  `);
  check("settings search finds the theme editor", deep.some((h) => /Editor de tema/.test(h)), JSON.stringify(deep));

  // ---- #110: F6 cycles panels; inert while a dialog is open
  const f6 = await js(`
    const fire = (shift = false) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: shift, bubbles: true }));
    fire(); await sleep(150);
    const withDialog = document.activeElement?.closest('[data-focus-region]')?.dataset.focusRegion ?? null;
    return { withDialog, dialog: !!document.querySelector('.dialog') };
  `);
  check("F6 does nothing while Ajustes is open", f6.dialog && f6.withDialog === null, JSON.stringify(f6));
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.dialog')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400); const x = document.querySelector('.dialog header .icon-btn'); x?.click(); await sleep(500);`);
  const cycle = await js(`
    const fire = (shift = false) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: shift, bubbles: true }));
    const where = () => document.activeElement?.closest('[data-focus-region]')?.dataset.focusRegion ?? null;
    const seen = [];
    for (let i = 0; i < 5; i++) { fire(); await sleep(120); seen.push(where()); }
    fire(true); await sleep(120); seen.push(where());
    return seen;
  `);
  check("F6 cycles the panels of a table tab (explorer › results › right panel) and Shift+F6 goes back", JSON.stringify(cycle.slice(0, 3).slice().sort()) === JSON.stringify(["explorer", "inspector", "results"]) && cycle[3] === cycle[0] && cycle[5] === cycle[3], JSON.stringify(cycle));

  // ---- connection dialog: the Entorno row
  const cd = await js(`
    [...document.querySelectorAll('.topbar .top-btn')].find((b) => /Nuevo/.test(b.textContent)).click();
    await until(() => panels().length); items(0).find((b) => /Nueva conexión/.test(txt(b))).click();
    await until(() => document.querySelector('.dialog')); await sleep(400);
    const g = document.querySelector('.dialog .env-group');
    return { group: !!g, env: !!g?.querySelector('.env-seg'), ro: /Solo lectura/.test(g?.textContent ?? ''), color: !!g?.querySelector('.env-color .swatches') };
  `);
  await shot("09-connection-entorno");
  check("connection dialog: environment, read-only and colour in one Entorno row", cd.group && cd.env && cd.ro && cd.color, JSON.stringify(cd));
  await js(`document.querySelector('.dialog header .icon-btn')?.click(); await sleep(300);`);

  check("no uncaught errors in the page", !errors.length, errors.join(" | "));
  app.close();
} catch (err) {
  console.log("FAIL exception", err?.stack ?? err);
  failed++;
} finally {
  browser.kill();
}
console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
