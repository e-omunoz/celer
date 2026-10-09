// Gib's animation lab, captured (needs the dev server: npm run dev, or GIB_LAB_URL=http://localhost:<port>).
//
// Grid check (regressions in the eyes, every pose × mood × activity, every size, every theme):
//   node dev/gib-lab-shots.mjs <outDir> --grid [themes=dark,light] [sizes=34,46,84] [t=0,900] [acc=cap,glasses]
// For each theme and size it captures the grid frozen at each time t (ms into the animations), with the lids shut
// (a blink) and with the gaze pushed to the four corners, and checks the geometry of every Gib in it: two eye whites,
// two pupils and two lids; the eyes inside the head group (they move with it); each pupil's centre inside its eye;
// each lid in sight; a blink closing the eye completely. Failures are listed and the exit code is 1.
//
// Contact sheets of one activity or mood at given moments (the original mode):
//   node dev/gib-lab-shots.mjs <outDir> [name=ms,ms,…] …
// e.g. node dev/gib-lab-shots.mjs %TEMP%\gib coffee-sip=0,1200,1900,3000 annoyed=0,110
// Every animation on the page is paused and moved to each time with the Web Animations API, so frames are exact.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

var BASE = (process.env.GIB_LAB_URL || "http://localhost:1420").replace(/\/$/, "");
const ALL_THEMES = ["dark", "light", "darcula", "contrast", "contrast-light", "fjord", "sand"];
// Every size Gib is drawn at in the app (see LAB_SIZES in src/gib/GibLab.tsx).
const ALL_SIZES = [34, 46, 72, 76, 84, 112, 120, 128, 150];

const [out, ...specs] = process.argv.slice(2);
if (!out) {
  console.error("usage: node dev/gib-lab-shots.mjs <outDir> --grid [themes=…] [sizes=…] [t=…] [acc=…] | <name=ms,…> …");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const browser = await headlessBrowser({ port: Number(process.env.GIB_CDP_PORT || 9444), width: 1600, height: 1000 });
const cdp = await connect(browser.port);
let failures = 0;
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (specs.includes("--grid")) await grid(Object.fromEntries(specs.filter((s) => s.includes("=")).map((s) => s.split("="))));
  else await sheets(specs);
} finally {
  cdp.close();
  browser.kill();
}
process.exit(failures ? 1 : 0);

async function open(hash) {
  // A new query string each time: a hash change alone would not load the page (and run the lab) again.
  await cdp.send("Page.navigate", { url: `${BASE}/?lab=${Date.now()}#${hash}` });
  // The lab is loaded on demand (src/main.tsx): wait for it (each probe short-lived, so one sent to the page being
  // replaced cannot hang), then for the moods' poses to settle in.
  const probe = () => Promise.race([cdp.js(`return !!document.querySelector('.giblab .gib');`).catch(() => false), sleep(1000).then(() => false)]);
  for (let i = 0; i < 100 && !(await probe()); i++) await sleep(200);
  await cdp.js(`await document.fonts.ready; await new Promise((r) => setTimeout(r, 900));`);
}

/**
 * Pauses every animation at `t` ms and waits two frames so the frame is painted. Transitions still under way (the
 * mood's pose settling in) are finished first: the frame shows where each mood ends up.
 */
async function freeze(t) {
  await cdp.js(`document.getAnimations().forEach((a) => { if (a instanceof CSSTransition) a.finish(); else { a.pause(); a.currentTime = ${t}; } }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`);
}

async function fullShot(file) {
  // The whole page in one image: the viewport grows to it (frozen animations do not move while it does).
  const dims = await cdp.js(`const lab = document.querySelector('.giblab'); return { w: lab.scrollWidth, h: lab.scrollHeight };`);
  const height = Math.min(dims.h, 16000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height, deviceScaleFactor: 1, mobile: false });
  // Headless Chromium now and then answers "Unable to capture screenshot" right after a resize: try again.
  for (let attempt = 0; ; attempt++) {
    await sleep(200 + attempt * 300);
    try {
      writeFileSync(file, await cdp.shot());
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await cdp.send("Page.bringToFront").catch(() => {});
    }
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
}

/** The geometry checks, run in the page over every cell of the grid. */
function CHECK(mode) {
  return `
  const fails = [];
  for (const cell of document.querySelectorAll('.lab-cell')) {
    const g = cell.querySelector('.gib');
    const tag = cell.dataset.pose + '/' + (cell.dataset.activity || cell.dataset.mood) + ' @' + cell.closest('[data-size]').dataset.size;
    const whites = g.querySelectorAll('.eye-white');
    const pupils = g.querySelectorAll('.pupil > circle:first-child');
    const lids = g.querySelectorAll('.lid > path:first-child');
    if (whites.length !== 2 || pupils.length !== 2 || lids.length !== 2) { fails.push(tag + ': ' + whites.length + ' eyes, ' + pupils.length + ' pupils, ' + lids.length + ' lids'); continue; }
    if (!g.querySelector('.g-head .eyes')) fails.push(tag + ': the eyes are not in the head group (they would not move with it)');
    for (const i of [0, 1]) {
      const e = whites[i].getBoundingClientRect(), p = pupils[i].getBoundingClientRect(), l = lids[i].getBoundingClientRect();
      if (!e.width) continue;
      const d = ((p.left + p.width / 2 - (e.left + e.width / 2)) / (e.width / 2)) ** 2 + ((p.top + p.height / 2 - (e.top + e.height / 2)) / (e.height / 2)) ** 2;
      if (d > 1.02) fails.push(tag + ': pupil ' + i + ' centre outside its eye (' + d.toFixed(2) + ')');
      // The lid's lower edge (the bottom of its box; the clip to the eye does not change the box).
      if (${mode === "blink"} && !cell.dataset.activity) {
        if (l.bottom < e.bottom - 0.03 * e.height) fails.push(tag + ': blink leaves the eye ' + Math.round((e.bottom - l.bottom) / e.height * 100) + '% open');
      } else if ((l.bottom - e.top) / e.height < 0.08) fails.push(tag + ': lid ' + i + ' out of sight');
    }
  }
  return fails;
`;
}

async function grid(opts) {
  const themes = (opts.themes || ALL_THEMES.join(",")).split(",");
  const sizes = (opts.sizes || ALL_SIZES.join(",")).split(",").map(Number);
  const times = (opts.t || "0,700,1600,2800,4400").split(",").map(Number);
  const extra = opts.acc ? `&acc=${opts.acc}` : "";
  const passes = [
    { name: "rest", query: "", times },
    { name: "blink", query: "&blink", times: [0] },
    ...[[9, 9], [-9, 9], [9, -9], [-9, -9]].map(([x, y]) => ({ name: `look${x}_${y}`, query: `&look=${x},${y}`, times: [0] })),
  ];
  for (const theme of themes) {
    for (const size of sizes) {
      for (const pass of passes) {
        await open(`giblab?grid&size=${size}&theme=${theme}${pass.query}${extra}`);
        for (const t of pass.times) {
          await freeze(t);
          const fails = await cdp.js(CHECK(pass.name));
          const file = join(out, `grid-${theme}-${size}-${pass.name}-${String(t).padStart(5, "0")}.png`);
          // Every frame of the rest pass, and the blink and gaze passes, are kept as the reference images.
          await fullShot(file);
          for (const fail of fails) console.log(`FAIL ${theme} ${pass.name} t=${t}: ${fail}`);
          failures += fails.length;
          console.log(`${fails.length ? "FAIL" : "ok  "} ${theme} ${size}px ${pass.name} t=${t} → ${file}`);
        }
      }
    }
  }
  console.log(failures ? `${failures} problem(s)` : "every pose, mood and activity: eyes and lids in place");
}

async function sheets(list) {
  const rows = [];
  const size = Number(process.env.GIB_SIZE || 200);
  for (const spec of list) {
    const [name, times = "0"] = spec.split("=");
    rows.push({ name, files: [] });
    const side = process.env.GIB_SIDE ? `&side=${process.env.GIB_SIDE}` : "";
    await open(`giblab?only=${name}&paused&size=${size}${side}`);
    const box = await cdp.js(`const f = document.querySelector('figure'); const r = f.getBoundingClientRect(); return { x: r.left - 70, y: r.top - 90, width: r.width + 140, height: r.height + 110 };`);
    for (const t of times.split(",").map(Number)) {
      await freeze(t);
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
}
