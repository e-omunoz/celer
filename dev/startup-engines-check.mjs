// The connection startup script on MariaDB and SQLite (PostgreSQL: misc-check.mjs), through the desktop app's
// core (dev/run-desktop.ps1). Uses throwaway connections and deletes them afterwards.
import { connect } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const result = await app.js(`
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const out = {};
  const base = (await inv('list_connections'))[0];
  const make = async (cfg) => { const saved = await inv('save_connection', { cfg: { ...base, id: '', name: 'startup-check ' + cfg.kind, folder: '', production: false, readOnly: false, password: null, ...cfg } }); return saved.id ?? saved; };
  const one = async (connId, sql) => { const s = await inv('open_session', { connId, password: cfgPassword[connId] ?? null }); try { return (await inv('execute', { sessionId: s.sessionId, sql, fetch: 1 })).results[0].rows[0]; } finally { await inv('close_session', { sessionId: s.sessionId }); } };
  const cfgPassword = {};
  const ids = [];
  try {
    const maria = await make({ kind: 'mysql', host: '127.0.0.1', port: 33069, user: 'celer', database: '', password: 'celer', startupSql: "SET @celer_boot = 'si'; /*!40101 SET SESSION sql_mode = 'ANSI_QUOTES' */" });
    ids.push(maria); cfgPassword[maria] = 'celer';
    out.mariadb = await one(maria, "SELECT @celer_boot, @@SESSION.sql_mode");
    const lite = await make({ kind: 'sqlite', filePath: ':memory:', startupSql: "-- tabla de arranque\\nCREATE TEMP TABLE boot(x); INSERT INTO boot VALUES ('a;b')" });
    ids.push(lite);
    out.sqlite = await one(lite, "SELECT x FROM boot");
    const ro = await make({ kind: 'sqlite', filePath: ':memory:', readOnly: true, startupSql: "DELETE FROM t" });
    ids.push(ro);
    try { await inv('open_session', { connId: ro, password: null }); out.readOnly = 'opened'; } catch (e) { out.readOnly = String(e); }
  } catch (e) {
    out.error = String(e);
  } finally {
    for (const id of ids) await inv('delete_connection', { id }).catch((e) => { out.cleanup = String(e); });
  }
  return out;
`);
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(result)}`}`);
  if (!ok) failed++;
};
check("MariaDB runs it (variables and executable comments)", result.mariadb?.[0] === "si" && /ANSI_QUOTES/.test(result.mariadb?.[1] ?? ""));
check("SQLite runs it (comments, ; inside strings)", result.sqlite?.[0] === "a;b");
check("a read-only connection refuses a writing script", /solo lectura/.test(result.readOnly ?? ""));
check("no errors, throwaway connections removed", !result.error && !result.cleanup);
app.close?.();
process.exit(failed ? 1 : 0);
