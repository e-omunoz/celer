# Celer's patches to tiberius 0.13.0

This is tiberius 0.13.0 as published on crates.io (MIT or Apache-2.0, both licence files kept here), used through
`[patch.crates-io]` in `src-tauri/Cargo.toml`. Upstream tests, examples, CI files and dev-dependencies are left out.

Why: tiberius reads the TDS INFO tokens (PRINT, RAISERROR with severity 10 or less, warnings such as "Null value is
eliminated by an aggregate") and only logs them, so a client cannot show them. Celer shows them in the Output area,
as SSMS does (issue #67).

What changed (each spot is marked `Celer:` in the source):
- `src/tds/stream/query.rs`: `QueryItem::Info(ServerMessage)`, a new item yielded in stream order for every INFO
  token; `ServerMessage` (number, state, class, message, server, procedure, line). `forward_to_metadata` stops at an
  INFO token too, so a message sent before the first result (`PRINT 'a'; SELECT 1`) is not skipped.
  `into_results`, `into_first_result`, `into_row` and `into_row_stream` ignore the new items.
- `src/result.rs`: `ExecuteResult::messages()` with the INFO tokens of an `execute`; `ServerMessage` re-exported.
- `src/tds/codec/token/token_info.rs`: comment only (the fields are now read).
- `Cargo.toml`: test, example and dev-dependency sections removed.

To move to a newer tiberius: replace this folder with the new crate, apply the same changes, and run
`cargo test --lib mssql` with `CELER_MSSQL_TEST` set (the engine test `mssql_engine` checks PRINT and RAISERROR).
