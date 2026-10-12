// Drives the Celer desktop app (WebView2) through the Chrome DevTools Protocol for end-to-end checks.
// Start the app with dev\run-desktop.ps1 [-Slot n] (DevTools on 9333 + n).
// Usage: node dev/cdp.mjs [--slot n | --port p] [--window <label|title regex|index>] <command> …
//   windows                         every window of the app: index, Tauri label, title
//   eval [-h] "<js>" | -f <file>    evaluates as an async function body; -h puts dev/cdp-helpers.js in scope
//   shot <file.png> | seq <prefix> <count> <intervalMs> [reload]
//   click <x> <y> [count] | rclick <x> <y> | drag <x1> <y1> <x2> <y2> [steps] | type "<text>" | key <Key> [ctrl,shift,alt]
// The window defaults to the main one; a torn-off tab is its own window (`--window 'w-.*'` or its title).
import { readFileSync, writeFileSync } from "node:fs";
import { appPort, connect, sleep, windows } from "./cdp-lib.mjs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const slot = opt("--slot");
const port = Number(opt("--port") ?? appPort(slot));
const win = opt("--window");
const [cmd, ...args] = argv;

if (cmd === "windows") {
  console.log(JSON.stringify(await windows(port), null, 2));
  process.exit(0);
}

const app = await connect(port, { window: win === undefined ? undefined : /^\d+$/.test(win) ? Number(win) : win, timeout: win ? 5000 : 0 });
const send = app.send;
const modifiers = (list = "") => list.split(",").reduce((m, k) => m | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[k.trim()] ?? 0), 0);
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, ...extra });

if (cmd === "eval") {
  const helpers = args[0] === "-h" && args.shift();
  const code = args[0] === "-f" ? readFileSync(args[1], "utf8") : args[0];
  // An expression ("document.title") prints its value; code that is not one runs as a function body (`return …`).
  try {
    const value = await app.js(`return (${code}\n);`, { helpers: !!helpers }).catch((e) => {
      if (/^SyntaxError/.test(e.message)) return app.js(code, { helpers: !!helpers });
      throw e;
    });
    console.log(JSON.stringify(value, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else if (cmd === "shot") {
  writeFileSync(args[0], await app.shot());
  console.log("saved", args[0], app.label ?? "");
} else if (cmd === "seq") {
  // seq <prefix> <count> <intervalMs> [reload]: a timed series of screenshots (optionally after reloading the page)
  const [prefix, count = 6, interval = 400, reload] = args;
  if (reload === "reload") await send("Page.reload", {});
  for (let i = 0; i < Number(count); i++) {
    await sleep(Number(interval));
    writeFileSync(`${prefix}-${i}.jpg`, await app.shot({ format: "jpeg", quality: 70 }));
  }
  console.log("saved", count);
} else if (cmd === "click") {
  const [x, y, count = 1] = args.map(Number);
  for (let n = 1; n <= count; n++) {
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y, { button: "left", clickCount: n });
    await mouse("mouseReleased", x, y, { button: "left", clickCount: n });
  }
  console.log("clicked", x, y, count);
} else if (cmd === "rclick") {
  const [x, y] = args.map(Number);
  await mouse("mousePressed", x, y, { button: "right", clickCount: 1 });
  await mouse("mouseReleased", x, y, { button: "right", clickCount: 1 });
  console.log("right-clicked", x, y);
} else if (cmd === "drag") {
  // A real pointer drag (pressed, moved in steps, released): column reordering, tab tear-off, splitters.
  const [x1, y1, x2, y2, steps = 20] = args.map(Number);
  await mouse("mouseMoved", x1, y1);
  await mouse("mousePressed", x1, y1, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", x2, y2, { button: "left", buttons: 0, clickCount: 1 });
  console.log("dragged", x1, y1, "→", x2, y2);
} else if (cmd === "type") {
  await send("Input.insertText", { text: args[0] });
  console.log("typed");
} else if (cmd === "key") {
  const key = args[0];
  const codes = { Enter: 13, Escape: 27, Delete: 46, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, F2: 113, F5: 116, F6: 117, Backspace: 8 };
  const code = codes[key] ?? key.toUpperCase().charCodeAt(0);
  const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers: modifiers(args[1]) };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (key === "Enter" && !args[1]) await send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  console.log("key", key, args[1] ?? "");
} else {
  console.error(`unknown command: ${cmd ?? "(none)"} (see the header of dev/cdp.mjs)`);
  process.exitCode = 2;
}
app.close();
