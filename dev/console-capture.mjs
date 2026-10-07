// Types into the active SQL editor and prints console errors/warnings the page logs meanwhile.
// Usage: node dev/console-capture.mjs "SELECT * FROM ev"
import { connect, sleep } from "./cdp-lib.mjs";

const text = process.argv[2] ?? "SELECT * FROM ev";
const app = await connect(process.env.CDP_PORT || 9333);
const logs = [];
app.on("Runtime.consoleAPICalled", (p) => logs.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`));
app.on("Runtime.exceptionThrown", (p) => logs.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
await app.send("Runtime.enable");
await app.js(`document.querySelector('.pane-host.active .cm-content')?.focus();`);
await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
for (const ch of text) await app.send("Input.insertText", { text: ch });
await sleep(600);
console.log(logs.length ? logs.join("\n") : "(no console output)");
console.log("options:", JSON.stringify(await app.js(`return [...document.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].slice(0, 5).map((e) => e.textContent);`)));
app.close();
process.exit(0);
