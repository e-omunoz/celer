# Area: connections (lifecycle, pool, reconnection, form)

Code: `src-tauri/src/session.rs`, `guard.rs`, `probe.rs`, `drivers.rs`, `store.rs`, `migrate.rs` (DBeaver/JDBC import),
`lib.rs` commands; UI `src/connForm.ts`, `src/connWatch.ts`, `src/connStatus.ts`, `src/connManage.ts`,
`src/components/ConnectionDialog.tsx`, `LinkDot.tsx`, `Sidebar.tsx`; checks `dev/connform-check.ts`,
`dev/explorer-check.ts`, `dev/migrate-check.ts`, `dev/disconnect-check.mjs`; guide sections in `docs/GUIA.md`.

## Check
- Connect/disconnect/reconnect for every engine; background connect of consoles; one round trip less on connect.
- Idle check after > 1 min, wake from sleep and network change; TCP keepalive set on every engine that supports it.
- The rule "never reconnect in silence with a transaction, #temp tables or session SET": verify every path in
  `guard.rs` — writes never repeated, pending COMMIT fails, lost state reported in the console.
- Transient retry on connect (bounded, with backoff, cancellable; does not retry auth failures).
- Pool: sessions reused per database, no leak when tabs close or move windows, side sessions (row count, table viewer).
- Timeouts: connect, login, query; what the UI shows while waiting; cancel during connect.
- Step-by-step test report: correct step marked failed, messages actionable (DNS, port closed, TLS, auth, database
  missing, driver missing).
- Form: JDBC URL parsing for every engine, validation per field, fields shown per engine, password handling
  (OS credential store, never in `connections.json`, never in logs/exports), duplicate with password, import/export
  without passwords, DBeaver passwords only on request.
- Read-only and production flags enforced in the Rust core, not only the UI.
- State dots/tab states always match reality (kill the server mid-session, wrong password, server restart).
