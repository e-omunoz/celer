// Renders an (animated) SVG to PNG stills at given times: node dev/render-svg.mjs <file.svg> <outPrefix> <ms,ms,...> [width] [height]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

const [file, prefix, times = "1000", width = 1280, height = 420] = process.argv.slice(2);
const browser = await headlessBrowser({ width: Number(width), height: Number(height) });
const cdp = await connect(browser.port);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
  const url = pathToFileURL(resolve(file)).href;
  await cdp.send("Page.navigate", { url });
  const start = Date.now();
  for (const [i, t] of times.split(",").map(Number).entries()) {
    await sleep(Math.max(0, t - (Date.now() - start)));
    // CLIP="x,y,w,h" zooms into a region (e.g. the mascot) to review poses.
    const clip = process.env.CLIP?.split(",").map(Number);
    writeFileSync(`${prefix}-${i}.png`, await cdp.shot(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 2 } } : {}));
  }
  console.log("ok");
} finally {
  cdp.close();
  browser.kill();
}
