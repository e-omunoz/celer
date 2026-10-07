// Minimal Chrome DevTools Protocol client shared by the media and test scripts.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects to the first page target on a DevTools port (the desktop app's WebView2 or a browser). */
export async function connect(port) {
  let targets = [];
  for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`No page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  await new Promise((resolve) => (ws.onopen = resolve));
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const js = async (expression) => {
    const res = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  const shot = async (opts = {}) => Buffer.from((await send("Page.captureScreenshot", { format: "png", ...opts })).data, "base64");
  return { send, on, js, shot, close: () => ws.close() };
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
