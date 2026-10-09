// Quick checks for src/variables.ts: node --experimental-strip-types dev/variables-check.ts
import assert from "node:assert/strict";
import { findParams } from "../src/snippets.ts";
import {
  findVariables,
  migrateVariables,
  normalizeVariables,
  resolveVariables,
  serializeVariables,
  substituteVariables,
  upsertVariable,
  validVarName,
  variableAt,
  variableLiteral,
} from "../src/variables.ts";

// Names and the file.
assert.ok(validVarName("cliente_id") && validVarName("_x") && !validVarName("1a") && !validVarName("a-b") && !validVarName(""));
assert.deepEqual(normalizeVariables([{ name: "${a}", value: "1" }, { name: "a", value: "2" }, { name: "b c", value: "x" }, { name: "n", value: 5, raw: true, description: " Número " }, null]), [
  { name: "a", value: "1" },
  { name: "n", value: "5", raw: true, description: "Número" },
]);
const file = migrateVariables({ version: 1, global: [{ name: "pais", value: "ES" }], connections: { c1: [{ name: "pais", value: "PT" }], c2: [], c3: "x" }, owner: "keep" });
assert.deepEqual(file.global, [{ name: "pais", value: "ES" }]);
assert.deepEqual(file.connections, { c1: [{ name: "pais", value: "PT" }] }, "empty and invalid lists are dropped");
assert.deepEqual(file.extra, { owner: "keep" });
assert.deepEqual(migrateVariables(JSON.parse(JSON.stringify(serializeVariables(file, file.extra)))), file, "reads back the same");
assert.deepEqual(migrateVariables(null), { global: [], connections: {}, extra: {} });
assert.deepEqual(upsertVariable([{ name: "a", value: "1" }, { name: "b", value: "2" }], { name: "a", value: "9" }), [{ name: "a", value: "9" }, { name: "b", value: "2" }]);
assert.deepEqual(upsertVariable([{ name: "a", value: "1" }], { name: "c", value: "3" }), [{ name: "a", value: "1" }, { name: "c", value: "3" }]);
assert.deepEqual(upsertVariable([{ name: "a", value: "1" }, { name: "b", value: "2" }], { name: "b", value: "1" }, "a"), [{ name: "b", value: "1" }], "renamed onto another: it takes its place");

// Scopes: console > connection > global.
const resolved = resolveVariables({
  console: [{ name: "cliente", value: "42" }],
  connection: [{ name: "cliente", value: "7" }, { name: "esquema", value: "ventas", raw: true }],
  global: [{ name: "esquema", value: "public", raw: true }, { name: "pais", value: "ES" }],
});
assert.deepEqual([...resolved.values()].map((v) => `${v.name}=${v.value}@${v.scope}`), ["cliente=42@console", "esquema=ventas@connection", "pais=ES@global"]);
// The same script on another connection: that connection's values.
const other = resolveVariables({ connection: [{ name: "cliente", value: "1001" }], global: [{ name: "cliente", value: "0" }] });
assert.equal(substituteVariables("SELECT ${cliente}", other).sql, "SELECT 1001");

// Substitution: quoting, raw SQL, undefined names, strings and comments untouched.
const sql = "SELECT * FROM ${esquema}.pedidos WHERE cliente = ${cliente} AND pais = ${pais} AND nota <> '${pais}' -- ${pais}\n/* ${cliente} */ AND x = ${falta} AND y = ${falta}";
const out = substituteVariables(sql, resolved, "postgres");
assert.equal(out.sql, "SELECT * FROM ventas.pedidos WHERE cliente = 42 AND pais = 'ES' AND nota <> '${pais}' -- ${pais}\n/* ${cliente} */ AND x = ${falta} AND y = ${falta}");
assert.deepEqual(out.used.map((v) => v.name), ["esquema", "cliente", "pais"]);
assert.deepEqual(out.missing, ["falta"], "undefined names stay, once");
assert.deepEqual(findParams(out.sql, "postgres").map((p) => p.name), ["falta", "falta"], "and the parameters prompt still asks for them");
assert.equal(variableLiteral({ name: "x", value: "O'Neil" }), "'O''Neil'");
assert.equal(variableLiteral({ name: "x", value: "a\\b" }, "mysql"), "'a\\\\b'", "MySQL escapes the backslash");
assert.equal(variableLiteral({ name: "x", value: "007" }), "'007'", "leading zeros: text");
assert.equal(variableLiteral({ name: "x", value: "-1.5" }), "-1.5");
assert.equal(variableLiteral({ name: "x", value: "null" }), "null");
assert.equal(variableLiteral({ name: "x", value: "(1, 2)", raw: true }), "(1, 2)");

// No clash with each engine's own syntax.
const vars = resolveVariables({ global: [{ name: "id", value: "5" }] });
assert.equal(substituteVariables("SELECT $1, :id, ?, @id, @@ROWCOUNT, ${id}", vars, "postgres").sql, "SELECT $1, :id, ?, @id, @@ROWCOUNT, 5");
assert.equal(substituteVariables("SELECT $$ ${id} $$, ${id}", vars, "postgres").sql, "SELECT $$ ${id} $$, 5", "PostgreSQL dollar quotes are strings");
assert.equal(substituteVariables("SELECT `${id}`, ${id}", vars, "mysql").sql, "SELECT `${id}`, 5", "a quoted identifier is not code");
assert.equal(substituteVariables("SELECT [${id}], ${id}", vars, "mssql").sql, "SELECT [${id}], 5");
assert.equal(substituteVariables("SELECT ${id} # ${id}", vars, "mysql").sql, "SELECT 5 # ${id}", "MySQL # comments");
assert.equal(substituteVariables("SELECT ${id} FROM t { ${id} }", vars, "informix").sql, "SELECT 5 FROM t { ${id} }", "Informix: ${name} is code, {…} a comment");
assert.deepEqual(findParams("SELECT ${a} FROM t", "informix").map((p) => p.name), ["a"], "Informix finds ${name} as a parameter too");
for (const dialect of ["postgres", "mysql", "mssql", "sqlite", "informix", "odbc", undefined]) {
  assert.equal(substituteVariables("SELECT ${id} AS v", vars, dialect).sql, "SELECT 5 AS v", String(dialect));
}

// Where the caret is (hover, completion).
assert.deepEqual(variableAt("SELECT ${cliente} x", 9), { name: "cliente", from: 7, to: 17 });
assert.equal(variableAt("SELECT ${cliente} x", 18), null);
assert.equal(variableAt("SELECT '${cliente}'", 10), null, "not inside strings");
assert.deepEqual(findVariables("${a}${b}").map((r) => r.name), ["a", "b"]);

console.log("variables-check: all good");
