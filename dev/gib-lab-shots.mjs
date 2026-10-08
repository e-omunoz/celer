// Contact sheets of Gib's idle activities and moods, frozen at given moments (needs the dev server on :1420).
//   node dev/gib-lab-shots.mjs <outDir> [name=ms,ms,…] …
// e.g. node dev/gib-lab-shots.mjs %TEMP%\gib coffee-sip=0,1200,1900,3000 annoyed=0,110
// Every animation on the page is paused and moved to each time with the Web Animations API, so frames are exact.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

const rows = [];

const [out, ...specs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const size = Number(process.env.GIB_SIZE || 200);
const browser = await headlessBrowser({ width: 1600, height: 1000 });
const cdp = await connect(browser.port);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const spec of specs) {
    const [name, times = "0"] = spec.split("=");
    rows.push({ name, files: [] });
    const side = process.env.GIB_SIDE ? `&side=${process.env.GIB_SIDE}` : "";
    await cdp.send("Page.navigate", { url: `http://localhost:1420/#giblab?only=${name}&paused&size=${size}${side}` });
    await sleep(1500);
    await cdp.js(`location.reload()`).catch(() => {});
    await sleep(1800);
    const box = await cdp.js(`const f = document.querySelector('figure'); const r = f.getBoundingClientRect(); return { x: r.left - 70, y: r.top - 90, width: r.width + 140, height: r.height + 110 };`);
    for (const t of times.split(",").map(Number)) {
      await cdp.js(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t}; }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`);
      const png = await cdp.shot({ clip: { ...box, scale: 1 } });
      const file = join(out, `${name}-${String(t).padStart(5, "0")}.png`);
      writeFileSync(file, png);
      rows.at(-1).files.push({ file, t });
    }
    console.log(name, times);
  }
  // One sheet with a row per activity, to review everything at a glance.
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#1d1b19;color:#bbb;font:12px monospace}
    .row{display:flex;gap:6px;align-items:flex-start;padding:6px}.cell{display:flex;flex-direction:column;align-items:center}
    img{height:${Number(process.env.GIB_SHEET_H || 220)}px}</style>${rows
    .map((r) => `<div class="row">${r.files.map((f) => `<div class="cell"><img src="${pathToFileURL(f.file).href}"><span>${r.name} ${f.t}ms</span></div>`).join("")}</div>`)
    .join("")}`;
  const sheet = join(out, "sheet.html");
  writeFileSync(sheet, html);
  await cdp.send("Page.navigate", { url: pathToFileURL(sheet).href });
  await sleep(800);
  const dims = await cdp.js(`return { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.min(dims.w, 4000), height: Math.min(dims.h, 4000), deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  writeFileSync(join(out, "sheet.png"), await cdp.shot());
  console.log("sheet", join(out, "sheet.png"));
} finally {
  cdp.close();
  browser.kill();
}
