// Several windows end to end: opens a console, moves its tab to a new window, drives that window and checks the
// main one let it go. A smoke test of the multi-window tooling (dev/cdp-lib.mjs) as much as of the feature.
//   node dev/windows-check.mjs [--slot n] [connection name, default "SQLite"]
import { appPort, connect, connectAll, sleep, windows } from "./cdp-lib.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--slot");
const port = appPort(at < 0 ? undefined : argv.splice(at, 2)[1]);
const conn = argv[0] ?? "SQLite";
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const main = await connect(port);
const errors = await main.watchErrors();
const before = await windows(port);
const opened = await main.js(`return await newConsole(${JSON.stringify(conn)})`, { helpers: true });
check(`console on ${conn} connected`, opened);
await main.js(`await runSql("SELECT 1 AS uno"); return true`, { helpers: true });
const title = await main.js(`return tabs().find((t) => t.active)?.title`, { helpers: true });
check("menu «Mover a una ventana nueva»", await main.js(`return await tabMenu(/^Mover a una ventana nueva/)`, { helpers: true }));

const known = new Set(before.map((w) => w.label));
let added = null;
for (let i = 0; i < 40 && !added; i++) {
  await sleep(250);
  added = (await windows(port)).find((w) => w.label && !known.has(w.label));
}
check("a new window appears", !!added, JSON.stringify(await windows(port)));
if (added) {
  const other = await connect(port, { window: added.label, timeout: 5000 });
  await sleep(800);
  const theirs = await other.js(`return tabs()`, { helpers: true });
  check("the new window has the tab", theirs.some((t) => t.title === title), JSON.stringify(theirs));
  const mine = await main.js(`return tabs()`, { helpers: true });
  check("the main window let it go", !mine.some((t) => t.title === title), JSON.stringify(mine));
  await other.js(`await runSql("SELECT 2 AS dos"); return true`, { helpers: true });
  check("the moved console still runs", !(await other.js(`return toasts().some((t) => t.kind === "error")`, { helpers: true })));
  check("connectAll sees both windows", Object.keys(await connectAll(port)).length >= 2);
  await other.js(`window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: ${JSON.stringify(added.label)} }).catch(() => {}); return true`).catch(() => {});
  other.close();
}
check("no uncaught errors in the main window", !errors.length, errors.join(" | "));
main.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
