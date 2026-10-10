// Minimal Chrome DevTools Protocol client shared by the media and test scripts.
// Every Celer window (main and torn-off ones) is its own page target on the same DevTools port: `windows()` lists
// them with their Tauri label, `connect(port, { window })` picks one and `connectAll(port)` opens them all.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-page helpers (dev/cdp-helpers.js), in scope with `js(code, { helpers: true })`. */
export const HELPERS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cdp-helpers.js"), "utf8");

/** DevTools port of `dev\run-desktop.ps1 -Slot n`: 9333 + n. `CDP_PORT` wins, then `CELER_SLOT`. */
export const appPort = (slot = process.env.CELER_SLOT ?? 0) => Number(process.env.CDP_PORT || 9333 + Number(slot));

async function pageTargets(port, tries = 50) {
  let targets = [];
  for (let i = 0; i < tries && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  return targets.filter((t) => t.type === "page");
}

async function open(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`DevTools socket of ${target.url} did not open`));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  /** Runs `expression` as the body of an async function; `{ helpers: true }` puts dev/cdp-helpers.js in scope. */
  const js = async (expression, { helpers = false } = {}) => {
    const body = helpers ? `${HELPERS}\n${expression}` : expression;
    const res = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  const shot = async (opts = {}) => Buffer.from((await send("Page.captureScreenshot", { format: "png", ...opts })).data, "base64");
  // Uncaught errors and console.error of this window from the call on; a check reads `errors` at its end.
  const errors = [];
  const watchErrors = async () => {
    on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    on("Runtime.consoleAPICalled", (p) => p.type === "error" && errors.push(p.args.map((a) => a.value ?? a.description ?? "").join(" ")));
    await send("Runtime.enable");
    return errors;
  };
  const label = await js("return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null").catch(() => null);
  return { send, on, js, shot, errors, watchErrors, label, title: target.title, url: target.url, close: () => ws.close() };
}

/** Every window on the port, in target order: { index, label, title, url } (label: Tauri window label, "main", …). */
export async function windows(port) {
  const out = [];
  for (const [index, t] of (await pageTargets(port)).entries()) {
    const c = await open(t).catch(() => null);
    out.push({ index, label: c?.label ?? null, title: t.title, url: t.url });
    c?.close();
  }
  return out;
}

/**
 * Connects to one window on a DevTools port (the desktop app's WebView2 or a browser). Without `window`: the main
 * window (label "main"), else the first page. `window` matches the Tauri label or the title: a RegExp, a string (a
 * regex source matched whole) or a 0-based index in target order. `timeout` (ms) waits for the window to appear,
 * e.g. a tab that was just torn off.
 */
export async function connect(port, { window, timeout = 0 } = {}) {
  const deadline = Date.now() + timeout;
  const re = window instanceof RegExp ? window : typeof window === "string" ? new RegExp(`^(?:${window})$`) : null;
  for (;;) {
    const targets = await pageTargets(port);
    if (!targets.length) throw new Error(`No page target on port ${port}`);
    if (typeof window === "number") {
      if (targets[window]) return open(targets[window]);
    } else {
      let first = null;
      for (const t of targets) {
        const c = await open(t).catch(() => null);
        if (!c) continue;
        const hit = re ? re.test(c.label ?? "") || re.test(c.title ?? "") : c.label === "main";
        if (hit) {
          first?.close();
          return c;
        }
        if (!re && !first) first = c;
        else c.close();
      }
      if (first) return first;
    }
    if (Date.now() >= deadline) throw new Error(`No window matching ${window} on port ${port}`);
    await sleep(250);
  }
}

/** Connects to every window on the port, keyed by Tauri label (or "#<index>" for a page without one). */
export async function connectAll(port) {
  const all = {};
  for (const [index, t] of (await pageTargets(port)).entries()) {
    const c = await open(t).catch(() => null);
    if (c) all[c.label ?? `#${index}`] = c;
  }
  return all;
}

/** Starts a headless Edge (or Chrome) with a throwaway profile and returns its DevTools port. */
export async function headlessBrowser({ port = 9444, width = 1440, height = 900 } = {}) {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const { existsSync } = await import("node:fs");
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) throw new Error("Edge/Chrome not found");
  const profile = mkdtempSync(join(tmpdir(), "celer-shot-"));
  const child = spawn(exe, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
  return { port, kill: () => child.kill() };
}
