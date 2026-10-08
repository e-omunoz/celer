// SQL Server's plan reader (it needs a real DOMParser): loads src/plan.ts from the dev server (:1420) in a
// headless browser and reads dev/fixtures/plans/mssql-join.xml.   node dev/plan-mssql-check.mjs
import { readFileSync } from "node:fs";
import { connect, headlessBrowser, sleep } from "./cdp-lib.mjs";

const xml = readFileSync(new URL("./fixtures/plans/mssql-join.xml", import.meta.url), "utf8");
const browser = await headlessBrowser({ port: 9445 });
const cdp = await connect(browser.port);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 400)}`}`);
  if (!ok) failed++;
};
try {
  await cdp.send("Page.navigate", { url: "http://localhost:1420/#giblab" });
  await sleep(1500);
  const plan = await cdp.js(`
    const { parseMssqlPlan, flatten } = await import('/src/plan.ts');
    const plan = parseMssqlPlan(${JSON.stringify(xml)});
    return { root: plan.root.op, nodes: flatten(plan.root).map((n) => ({ op: n.op, target: n.target, rows: n.rows, cost: n.cost, warnings: n.warnings, details: n.details.map((d) => d[0]) })), rootWarnings: plan.root.warnings };
  `);
  check("the operator tree reads (Hash Match → join → two scans)", plan.nodes.length === 4 && plan.root === "Hash Match (Aggregate)", JSON.stringify(plan.nodes.map((n) => n.op)));
  check("operators keep their own table only", plan.nodes[0].target === "" && plan.nodes[1].target === "" && plan.nodes[3].target.startsWith("dbo.pedidos") || plan.nodes[3].target.startsWith("pedidos"), JSON.stringify(plan.nodes.map((n) => n.target)));
  check("rows and cost", plan.nodes[3].rows === 15000 && plan.nodes[0].cost === 1.27, JSON.stringify(plan.nodes[3]));
  check("the missing index suggestion is a warning", plan.rootWarnings.some((w) => /sugiere un índice en dbo\.pedidos \(estado, cliente_id\).*71 %/.test(w)), JSON.stringify(plan.rootWarnings));
  check("columns without statistics are flagged", plan.nodes[1].warnings.some((w) => /estadísticas/.test(w)), JSON.stringify(plan.nodes[1].warnings));
  check("the predicate is a detail", plan.nodes[3].details.includes("Predicado"), JSON.stringify(plan.nodes[3].details));
} finally {
  cdp.close();
  browser.kill();
}
process.exit(failed ? 1 : 0);
