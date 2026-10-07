// Walks the start-up guide's spotlight tour and checks, for every step, that the bubble is fully inside the
// window and doesn't cover the spotlight. Usage: node dev/tour-check.mjs [outPrefix] [width] [height]
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const [prefix, width = "1440", height = "900"] = process.argv.slice(2);
const app = await connect(process.env.CDP_PORT || 9333);
await app.send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
`;
const js = (code) => app.js(H + code);
try {
  await js(`await until(() => document.querySelector('.companion.landed'), 15000);`);
  // Open the guide (it may already be open on a first run) and go to the tour.
  await js(`
    if (!document.querySelector('.onboarding')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  `);
  const toTour = await js(`
    await until(() => document.querySelector('.onboarding'), 3000);
    for (let i = 0; i < 6 && !document.querySelector('.tour-bubble'); i++) {
      const tour = [...document.querySelectorAll('.onboarding button')].find((b) => /recorrido/i.test(b.textContent) && !/saltar/i.test(b.textContent));
      if (tour) { tour.click(); await sleep(500); break; }
      const nextBtn = [...document.querySelectorAll('.onb-actions .btn.primary')].pop();
      if (!nextBtn) break;
      nextBtn.click(); await sleep(350);
    }
    return !!(await until(() => document.querySelector('.tour-bubble'), 3000));
  `);
  if (!toTour) throw new Error("could not reach the tour (is the guide open? run the 'Guía de inicio' command)");
  for (let step = 0; step < 7; step++) {
    await sleep(700);
    const r = await js(`
      const b = document.querySelector('.tour-bubble').getBoundingClientRect();
      const s = document.querySelector('.tour-spot').getBoundingClientRect();
      const inside = b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
      const overlap = Math.max(0, Math.min(b.right, s.right) - Math.max(b.left, s.left)) * Math.max(0, Math.min(b.bottom, s.bottom) - Math.max(b.top, s.top));
      const gib = document.querySelector('.companion .gib')?.getBoundingClientRect();
      const gibInSpot = gib ? gib.left >= s.left - 1 && gib.top >= s.top - 1 && gib.right <= s.right + 1 && gib.bottom <= s.bottom + 1 : null;
      return { title: document.querySelector('.tour-head b').textContent, inside, overlapPx: Math.round(overlap), bubble: [b.left, b.top, b.right, b.bottom].map(Math.round), spot: [s.left, s.top, s.right, s.bottom].map(Math.round), gibInSpot };
    `);
    console.log(`${r.inside && r.overlapPx === 0 ? "ok  " : "BAD "} ${String(step + 1)}. ${r.title.padEnd(18)} bubble ${r.bubble.join(",")}  spot ${r.spot.join(",")}${r.title === "Gib" ? `  gib fully in spot: ${r.gibInSpot}` : ""}${r.overlapPx ? `  overlap ${r.overlapPx}px²` : ""}`);
    if (prefix) writeFileSync(`${prefix}-${step + 1}.png`, await app.shot());
    if (step < 6) await js(`[...document.querySelectorAll('.tour-actions .btn.primary')].pop().click();`);
  }
} finally {
  await app.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
  app.close();
}
