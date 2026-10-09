// Prints, as JSON, the connections the migration assistant makes of the samples in dev/fixtures/migrate (DBeaver with
// its saved credentials, and DbVisualizer), for src-tauri/src/engine_tests.rs `imported_connections_connect`, which
// opens each one against the engines of dev/wsl/compose.yml.
//   node --experimental-strip-types dev/migrate-sample.ts
import { readFileSync } from "node:fs";
import { applyDbeaverCredentials, parseDbeaver, parseDbVisualizer } from "../src/migrateParse.ts";

const at = (path: string) => new URL(`./fixtures/migrate/${path}`, import.meta.url);
const sourcePath = "DBeaverData/workspace6/General/.dbeaver/data-sources.json";
const dbeaver = parseDbeaver({ tool: "dbeaver", project: "General", path: sourcePath, text: readFileSync(at(sourcePath), "utf8") });
const withCredentials = await applyDbeaverCredentials(dbeaver, sourcePath, readFileSync(at("DBeaverData/workspace6/General/.dbeaver/credentials-config.json")).toString("hex"));
const dbvis = parseDbVisualizer({ tool: "dbvisualizer", project: "config230", path: "dbvis.xml", text: readFileSync(at(".dbvis/config230/dbvis.xml"), "utf8") });
// DbVisualizer passwords are not imported: Celer asks for them; the same ones as DBeaver's here.
const asked = dbvis.map((c) => ({ ...c, cfg: { ...c.cfg, password: withCredentials.find((d) => d.cfg.kind === c.cfg.kind && d.cfg.port === c.cfg.port && d.cfg.informixMode === c.cfg.informixMode)?.cfg.password ?? "" } }));
console.log(JSON.stringify([...withCredentials, ...asked].map((c) => ({ tool: c.tool, ...c.cfg }))));
