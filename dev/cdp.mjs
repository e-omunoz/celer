// Drives the Celer desktop app (WebView2) through the Chrome DevTools Protocol for end-to-end checks.
// Start the app with:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
// Usage: node dev/cdp.mjs eval "<js>" | shot <file.png> | click <x> <y> [count] | type "<text>" | key <Key> [ctrl,shift,alt]
const PORT = process.env.CDP_PORT || 9333;
const [cmd, ...args] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("No page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((resolve) => (ws.onopen = resolve));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const modifiers = (list = "") => list.split(",").reduce((m, k) => m | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[k.trim()] ?? 0), 0);

if (cmd === "eval") {
  const res = await send("Runtime.evaluate", { expression: args[0], awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(res.result.value ?? res.exceptionDetails ?? res.result, null, 2));
} else if (cmd === "shot") {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(args[0], Buffer.from(res.data, "base64"));
  console.log("saved", args[0]);
} else if (cmd === "seq") {
  // seq <prefix> <count> <intervalMs> [reload]: a timed series of screenshots (optionally after reloading the page)
  const [prefix, count = 6, interval = 400, reload] = args;
  const fs = await import("node:fs");
  if (reload === "reload") await send("Page.reload", {});
  for (let i = 0; i < Number(count); i++) {
    await new Promise((resolve) => setTimeout(resolve, Number(interval)));
    const res = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    fs.writeFileSync(`${prefix}-${i}.jpg`, Buffer.from(res.data, "base64"));
  }
  console.log("saved", count);
} else if (cmd === "click") {
  const [x, y, count = 1] = args.map(Number);
  for (let n = 1; n <= count; n++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: n });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: n });
  }
  console.log("clicked", x, y, count);
} else if (cmd === "rclick") {
  const [x, y] = args.map(Number);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
  console.log("right-clicked", x, y);
} else if (cmd === "type") {
  await send("Input.insertText", { text: args[0] });
  console.log("typed");
} else if (cmd === "key") {
  const key = args[0];
  const codes = { Enter: 13, Escape: 27, Delete: 46, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, F2: 113, F5: 116, Backspace: 8 };
  const code = codes[key] ?? key.toUpperCase().charCodeAt(0);
  const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers: modifiers(args[1]) };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (key === "Enter" && !args[1]) await send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  console.log("key", key, args[1] ?? "");
}
ws.close();
