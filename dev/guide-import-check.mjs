// The start-up guide survives the import assistant: open it from the "Conexión" step, close it, and the guide is
// back on the same step (it used to close for good). Needs the desktop app with CDP (dev/run-desktop.ps1 -Fresh).
import { connect } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const button = (re, root = document) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

const opened = await js(`
  await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 15000);
  if (!document.querySelector('.onboarding')) { document.querySelector('.topbar')?.click(); }
  await until(() => document.querySelector('.onboarding'), 4000);
  // Walk to the "Conexión" step.
  for (let i = 0; i < 4 && !document.querySelector('.onb-import'); i++) { button(/Empezar|Siguiente/, document.querySelector('.onboarding'))?.click(); await sleep(300); }
  return { guide: !!document.querySelector('.onboarding'), step: !!document.querySelector('.onb-import') };
`);
check("guide is on the Conexión step", opened.guide && opened.step, JSON.stringify(opened));

const during = await js(`
  document.querySelector('.onb-import').click();
  await until(() => document.querySelector('.migrate-dialog'), 4000);
  await until(() => !document.querySelector('.migrate-dialog .mig-empty h3')?.textContent.includes('Buscando'), 8000);
  return { dialog: !!document.querySelector('.migrate-dialog'), guideHidden: !document.querySelector('.onboarding') };
`);
check("import assistant opens and the guide steps aside", during.dialog && during.guideHidden, JSON.stringify(during));

const after = await js(`
  button(/Cerrar|Cancelar/, document.querySelector('.migrate-dialog')).click();
  await until(() => !document.querySelector('.migrate-dialog'), 3000);
  await sleep(200);
  return { guide: !!document.querySelector('.onboarding'), sameStep: !!document.querySelector('.onb-import') };
`);
check("closing it brings the guide back on the same step", after.guide && after.sameStep, JSON.stringify(after));

const esc = await js(`
  document.querySelector('.onb-import').click();
  await until(() => document.querySelector('.migrate-dialog'), 4000);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  const dialogGone = !document.querySelector('.migrate-dialog');
  if (!dialogGone) button(/Cerrar|Cancelar/, document.querySelector('.migrate-dialog'))?.click();
  await until(() => document.querySelector('.onboarding'), 3000);
  return { guide: !!document.querySelector('.onboarding') };
`);
check("Escape inside the assistant does not close the guide", esc.guide, JSON.stringify(esc));

app.close();
process.exit(failed ? 1 : 0);
