// A GIF of Gib's idle routines for the README (needs the dev server on :1420 and the GIF tools of dev/gif.mjs):
//   node dev/gib-gif.mjs [out=docs/media/gib-idle.gif]
// Each routine is rendered from the dev-only Gib lab with its animations paused and stepped, so frames are exact.
import { join } from "node:path";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";
import { writeGif } from "./gif.mjs";

const out = process.argv[2] || join("docs", "media", "gib-idle.gif");
const SIZE = 150;
const STEP = 90;
// [activity or mood, from ms, to ms]: the moments worth watching of each routine.
const SEGMENTS = [
  ["yawn", 0, 2600],
  ["coffee-out", 0, 1500],
  ["coffee-in", 0, 1500],
  ["coffee-sip", 400, 3400],
  ["laptop", 0, 3000],
  ["juggle", 0, 2700],
  ["dance", 0, 2400],
  ["read", 600, 3000],
  ["annoyed", 0, 1300],
];

const browser = await headlessBrowser({ width: 900, height: 700 });
const cdp = await connect(browser.port);
const frames = [];
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  let box = null;
  for (const [name, from, to] of SEGMENTS) {
    await cdp.send("Page.navigate", { url: `http://localhost:1420/#giblab?only=${name}&paused&size=${SIZE}` });
    await sleep(1200);
    await cdp.js(`location.reload()`).catch(() => {});
    await sleep(1600);
    // Same crop for every routine (the first one's), without the caption.
    const here = await cdp.js(`
      document.querySelectorAll('figcaption').forEach((c) => (c.style.visibility = 'hidden'));
      const r = document.querySelector('figure .gib, figure svg').getBoundingClientRect();
      // Room above for juggling balls and the coffee steam, at the sides for the arms.
      return { x: Math.round(r.left - 70), y: Math.round(r.top - 60), width: Math.round(r.width + 140), height: Math.round(r.height + 80) };
    `);
    box ??= here;
    for (let t = from; t <= to; t += STEP) {
      await cdp.js(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t}; }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`);
      frames.push({ image: await cdp.shot({ clip: { ...box, scale: 1 } }), delay: STEP });
    }
    // A short rest between routines.
    frames.at(-1).delay = 450;
    console.log(name, from, to);
  }
  console.log("gif", writeGif(out, frames));
  // Optional: a few frames as PNG to review the crop (GIB_GIF_PEEK=dir).
  if (process.env.GIB_GIF_PEEK) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(process.env.GIB_GIF_PEEK, { recursive: true });
    for (const i of [0, 40, 60, 80, 110, 140, 170, 200, frames.length - 5]) if (frames[i]) writeFileSync(join(process.env.GIB_GIF_PEEK, `f${i}.png`), frames[i].image);
  }
} finally {
  cdp.close();
  browser.kill();
}
