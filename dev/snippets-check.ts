// Quick checks for src/snippets.ts: node --experimental-strip-types dev/snippets-check.ts
import assert from "node:assert/strict";
import { allSnippets, bindParams, builtinSnippets, findParams, hasUnfilteredWrite, paramLiteral, paramNames, unfilteredWrites } from "../src/snippets.ts";

const names = (sql: string, dialect?: string) => findParams(sql, dialect).map((p) => p.name);

// Named parameters.
assert.deepEqual(names("SELECT * FROM t WHERE id = :id AND kind = :kind", "postgres"), ["id", "kind"]);
assert.deepEqual(names("SELECT x::int, a[1:2], b[i:j] FROM t", "postgres"), [], "casts and slices are not parameters");
assert.deepEqual(names("SELECT * FROM stores:customer WHERE id = :id", "informix"), ["id"], "Informix db:table is not a parameter");
assert.deepEqual(names("SELECT ':not', \":nor\" -- :neither\n/* :nope */ FROM t WHERE a = :yes", "postgres"), ["yes"], "strings, identifiers and comments are skipped");
assert.deepEqual(names("SET @x := 1", "mysql"), [], ":= is an assignment");
assert.deepEqual(names("SELECT * FROM t WHERE d > ${desde} AND d < ${hasta}", "sqlite"), ["desde", "hasta"]);
assert.deepEqual(names("SELECT * FROM t WHERE a = ? AND b = ?", "mysql"), ["?1", "?2"]);
assert.deepEqual(names("SELECT data ? 'key' FROM t", "postgres"), [], "? is a jsonb operator in PostgreSQL");
assert.deepEqual(names("SELECT 'a?' FROM t WHERE x = ?", "sqlite"), ["?1"]);
assert.deepEqual(paramNames(findParams("SELECT :a, :b, :a", "postgres")), ["a", "b"], "a repeated parameter is asked once");

// Literals.
assert.equal(paramLiteral("42", false), "42");
assert.equal(paramLiteral("-3.5", false), "-3.5");
assert.equal(paramLiteral("null", false), "null");
assert.equal(paramLiteral("O'Brien", false), "'O''Brien'");
assert.equal(paramLiteral("a\\b", false, "mysql"), "'a\\\\b'");
assert.equal(paramLiteral("now() - interval '1 day'", true), "now() - interval '1 day'", "raw SQL goes as is");
assert.equal(paramLiteral("007", false), "007", "digits stay numbers");

// Binding keeps everything else intact, every occurrence is replaced.
const sql = "SELECT * FROM t WHERE a = :a AND b = :b OR a2 = :a -- :a";
assert.equal(bindParams(sql, findParams(sql, "postgres"), { a: "1", b: "x" }, {}, "postgres"), "SELECT * FROM t WHERE a = 1 AND b = 'x' OR a2 = 1 -- :a");
const q = "SELECT * FROM t WHERE a = ? AND b = ?";
assert.equal(bindParams(q, findParams(q, "mysql"), { "?1": "5", "?2": "z" }, {}, "mysql"), "SELECT * FROM t WHERE a = 5 AND b = 'z'");

// Writes without WHERE.
assert.equal(hasUnfilteredWrite("DELETE FROM t", "postgres"), true);
assert.equal(hasUnfilteredWrite("delete from t where id = 1", "postgres"), false);
assert.equal(hasUnfilteredWrite("UPDATE t SET a = 1", "postgres"), true);
assert.equal(hasUnfilteredWrite("UPDATE t SET a = 'where'", "postgres"), true, "a WHERE inside a string does not count");
assert.equal(hasUnfilteredWrite("SELECT 1; DELETE FROM t; SELECT 2", "postgres"), true);
assert.equal(hasUnfilteredWrite("DELETE FROM t LIMIT 10", "mysql"), false, "bounded on purpose");
assert.equal(hasUnfilteredWrite("DELETE TOP (10) FROM t", "mssql"), false, "bounded on purpose");
assert.equal(hasUnfilteredWrite("SELECT * FROM t", "postgres"), false);
const text = "SELECT 1;\n-- delete everything\nDELETE FROM t;";
const [w] = unfilteredWrites(text, "postgres");
assert.equal(text.slice(w.from, w.to), "DELETE", "the keyword itself is marked, not a word in a comment");

// Templates.
const pg = builtinSnippets("postgres");
assert.ok(pg.find((s) => s.name === "top")!.body.includes("LIMIT"));
assert.ok(builtinSnippets("mssql").find((s) => s.name === "top")!.body.startsWith("SELECT TOP"));
assert.ok(builtinSnippets("informix").find((s) => s.name === "top")!.body.startsWith("SELECT FIRST"));
const merged = allSnippets("postgres", [{ name: "sel", description: "mío", body: "SELECT 1" }, { name: "", description: "", body: "x" }]);
assert.equal(merged.filter((s) => s.name === "sel").length, 1, "a user template replaces the built-in one");
assert.equal(merged.find((s) => s.name === "sel")!.description, "mío");
assert.ok(!merged.some((s) => s.name === ""), "empty templates are ignored");

console.log("snippets-check: all good");
