// What Celer sends when a library script runs on a connection of each engine («Ejecutar en…»), for the Rust
// integration tests against real servers (src-tauri/src/engine_tests.rs, `library_*`). The test says the engine
// (stdin, JSON) and gets back the statements to run, each with the rows it must return. The script comes from a
// library export (.sql bundle) read back, so the same entry, with its declared parameter, runs on every engine.
//   node --experimental-strip-types dev/library-sql.ts < {"kind":"postgres"} > statements.json
import { readFileSync } from "node:fs";
import { exportBundle, parseSqlFile, schemaSetupSql, type LibraryScript } from "../src/libraryModel.ts";
import { bindParams, findParams } from "../src/snippets.ts";
import type { DbKind } from "../src/types.ts";
import { resolveVariables, substituteVariables } from "../src/variables.ts";

interface Statement {
  name: string;
  sql: string;
  rows?: number;
}

const { kind, schema, table } = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "")) as { kind: DbKind; schema?: string; table?: string };
const out: Statement[] = [];

/** The seeded check script (the test creates celer_lib_check with ids 1, 2 and 3 in the default schema). */
const saved: LibraryScript = {
  id: "check",
  name: "Comprobar celer_lib_check",
  sql: "-- Filas desde un id\nSELECT id, nombre\nFROM celer_lib_check\nWHERE id >= :minimo\nORDER BY id",
  connId: null,
  folder: "Comprobaciones",
  tags: ["check"],
  createdAt: 0,
  updatedAt: 0,
  description: "Las filas desde un id",
  engine: "generic",
  params: [{ name: "minimo", default: "2", description: "Primer id" }],
};
const [entry] = parseSqlFile("biblioteca.sql", exportBundle([saved]));

/** As runActive does: the prompt pre-filled with the declared defaults, accepted as they are. */
function bound(sql: string, defaults: Record<string, string>) {
  const refs = findParams(sql, kind);
  return bindParams(sql, refs, defaults, {}, kind);
}

const defaults = Object.fromEntries((entry.params ?? []).map((p) => [p.name, p.default]));

// «Ejecutar en…» with a schema (PostgreSQL: the test puts the table in one outside search_path): set first.
const setup = schemaSetupSql(kind, schema);
if (setup) out.push({ name: "library target schema", sql: setup });
out.push({ name: "library check script (declared default)", sql: bound(entry.sql, defaults), rows: 2 });
out.push({ name: "library check script (value typed)", sql: bound(entry.sql, { minimo: "3" }), rows: 1 });

// The same entry with variables: the table is a variable of each connection (raw SQL), the first id a global one;
// a string that looks like a variable stays as it is. Substituted as runActive does, before the parameters.
const withVars = "SELECT id, nombre\nFROM ${tabla}\nWHERE id >= ${desde} AND nombre <> '${desde}'\nORDER BY id";
const connVars = [{ name: "tabla", value: table ?? "celer_lib_check", raw: true }];
out.push({ name: "library script with variables", sql: substituteVariables(withVars, resolveVariables({ connection: connVars, global: [{ name: "desde", value: "2" }] }), kind).sql, rows: 2 });
// The console's own value wins over the global one.
out.push({
  name: "variables: the console's value first",
  sql: substituteVariables(withVars, resolveVariables({ console: [{ name: "desde", value: "3" }], connection: connVars, global: [{ name: "desde", value: "1" }] }), kind).sql,
  rows: 1,
});
// A variable without a value is asked for like a parameter (here "1" typed in the prompt).
const partial = substituteVariables(withVars, resolveVariables({ connection: connVars }), kind).sql;
out.push({ name: "variable without value, asked as a parameter", sql: bound(partial, { desde: "1" }), rows: 3 });

process.stdout.write(JSON.stringify(out, null, 1));
