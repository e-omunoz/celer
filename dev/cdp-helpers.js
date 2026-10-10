// In-page helpers for driving the Celer UI through DevTools: `app.js(code, { helpers: true })` (dev/cdp-lib.mjs) or
// `node dev/cdp.mjs eval -h "<code>"`. Plain script (no imports): it is pasted in front of the evaluated code.
// They find things by what the user sees (connection names, button texts), so a check reads like the steps it takes.
/* eslint-disable no-unused-vars */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it returns something truthy (returned) or `ms` pass (null). */
const until = async (fn, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
};
const txt = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? null;
/** The active pane (console, table, diagram…) of this window. */
const pane = () => document.querySelector(".pane-host.active") || document.querySelector(".pane");
const button = (re, root = document) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent.trim()) || re.test(b.title || ""));
const dialog = () => document.querySelector(".dialog");
const connRow = (name) => [...document.querySelectorAll(".tree-row.conn")].find((e) => e.querySelector(".tree-name")?.textContent.trim() === name);

/** Scrolls the explorer until the connection row is rendered (the tree is virtualised) and returns it. */
const findConn = async (name) => {
  let row = connRow(name);
  if (!row) {
    let el = document.querySelector(".tree-row")?.parentElement;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    for (let y = 0; el && !row && y < el.scrollHeight; y += 200) {
      el.scrollTop = y;
      await sleep(80);
      row = connRow(name);
    }
  }
  if (row) {
    row.scrollIntoView({ block: "center" });
    await sleep(150);
  }
  return connRow(name);
};

/** Right-clicks a connection in the explorer and picks the menu item matching `re`. */
const menu = async (name, re) => {
  const row = await findConn(name);
  if (!row) return false;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 40, clientY: r.top + 8 }));
  const item = await until(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => re.test(b.textContent)), 2000);
  item?.click();
  await sleep(250);
  return !!item;
};

/** CodeMirror view of the active console. */
const view = () => {
  const el = pane()?.querySelector(".cm-content");
  return el?.cmTile?.view ?? el?.cmView?.view;
};
const setSql = (sql) => {
  const v = view();
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: sql }, selection: { anchor: 0 } });
};
/** Puts `sql` in the active console, runs it and waits for the run to end. */
const runSql = async (sql, ms = 20000) => {
  setSql(sql);
  await sleep(100);
  pane().querySelector(".tb-btn.run").click();
  await sleep(300);
  await until(() => !document.querySelector(".tab.on .tab-spinner"), ms);
  await sleep(400);
};
/** Opens a new console on a connection (connecting it) and waits until the connection is up. */
const newConsole = async (name, ms = 30000) => {
  const n = document.querySelectorAll(".tab").length;
  await menu(name, /^Nueva consola/);
  await until(() => document.querySelectorAll(".tab").length > n && view(), 8000);
  await until(() => connRow(name)?.classList.contains("connected"), ms);
  await sleep(500);
  return !!connRow(name)?.classList.contains("connected");
};
/** Tabs of this window: [{ title, active }]. */
const tabs = () => [...document.querySelectorAll(".tab")].map((t) => ({ title: txt(t.querySelector(".tab-title")) ?? txt(t), active: t.classList.contains("on") }));
const closeActive = () => document.querySelector(".tab.on .tab-close")?.click();
/** Visible toasts: [{ kind, text }]. */
const toasts = () => [...document.querySelectorAll(".toasts .toast")].map((t) => ({ kind: t.className.replace("toast", "").trim(), text: txt(t.querySelector(".toast-body")) }));

/** The open dialog: its text, footer buttons and the focused element. */
const dlgInfo = async (ms = 4000) => {
  const d = await until(() => dialog(), ms);
  return d ? { text: txt(d), buttons: [...d.querySelectorAll("footer button")].map(txt), focused: txt(document.activeElement) } : null;
};
/** Clicks the dialog button matching `re`. */
const answer = async (re) => {
  button(re, dialog())?.click();
  await sleep(1500);
};
const closeDialog = async () => {
  document.activeElement?.blur();
  for (const send of [() => dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), () => dialog()?.querySelector("button[title*=Cerrar], .dialog-close, header button")?.click()]) {
    if (!dialog()) return true;
    send();
    await sleep(200);
  }
  return !dialog();
};
/** Opens Ajustes on the section whose name starts with `section`. */
const openSettings = async (section) => {
  if (!dialog()) [...document.querySelectorAll("button")].find((b) => /^Ajustes/.test(b.title || ""))?.click();
  await until(() => dialog(), 3000);
  if (section) button(new RegExp("^" + section), dialog())?.click();
  await sleep(300);
};
/** Calls a Tauri command of the backend directly (for setup and assertions, not instead of the UI under test). */
const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
/**
 * Runs SQL on a saved connection in a session of its own (not the console's), to set up data or check what the UI
 * did: the result grid is a canvas, so its contents are read from the database, not the page.
 */
const sql = async (connName, text, fetch = 1000) => {
  const c = (await invoke("list_connections")).find((x) => x.name === connName);
  if (!c) throw new Error(`no connection named ${connName}`);
  const s = await invoke("open_session", { connId: c.id, password: null });
  try {
    return await invoke("execute", { sessionId: s.sessionId, sql: text, fetch });
  } finally {
    await invoke("close_session", { sessionId: s.sessionId });
  }
};
