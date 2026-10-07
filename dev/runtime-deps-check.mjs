// Runtime checks for network/driver dependencies on the running app (start it with CELER_FAKE_VERSION set
// below the latest release): update check + verified download from GitHub, and a MariaDB/MySQL query.
import { connect } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const r = await app.js(`
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const out = {};
  try {
    const info = await inv('update_check');
    out.update = { current: info.current, latest: info.latest, available: info.available, kind: info.installKind, asset: info.assetName };
    if (info.available && info.assetUrl) {
      const t = performance.now();
      out.download = await inv('update_download', { url: info.assetUrl, name: info.assetName, sumsUrl: info.sumsUrl });
      out.downloadMs = Math.round(performance.now() - t);
    }
  } catch (e) { out.updateError = String(e); }
  try {
    const conns = await inv('list_connections');
    const maria = conns.find((c) => c.kind === 'mysql');
    const s = await inv('open_session', { connId: maria.id, password: null });
    const res = await inv('execute', { sessionId: s.sessionId, sql: 'SELECT VERSION() AS v, 1 + 1 AS two', fetch: 5 });
    out.mysql = res.results[0].rows[0];
    await inv('close_session', { sessionId: s.sessionId });
  } catch (e) { out.mysqlError = String(e); }
  return out;
`);
console.log(JSON.stringify(r, null, 2));
app.close();
process.exit(0);
