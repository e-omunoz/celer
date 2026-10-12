// Quick checks for src/engineCompat.ts: node --experimental-strip-types dev/engine-compat-check.ts
import assert from "node:assert/strict";
import { compatibility, detectEngines, FEATURE_SUPPORT, guessEngines, guessText, isCompatible, needsEngineConfirm, unsupportedReason } from "../src/engineCompat.ts";

const engines = (sql: string) => detectEngines(sql).engines;

// Samples per engine: what each one alone writes.
const samples: [string, string[]][] = [
  // SQL Server
  ["SELECT TOP 10 * FROM dbo.orders ORDER BY id DESC", ["mssql"]],
  ["SELECT TOP (5) name FROM sys.tables", ["mssql"]],
  ["SELECT [Order Id], [name] FROM [dbo].[orders]", ["mssql"]],
  ["SELECT GETDATE(), ISNULL(total, 0) FROM orders", ["mssql"]],
  ["DECLARE @n int = 5; SELECT @@ROWCOUNT", ["mssql"]],
  ["SELECT 1\nGO\nSELECT 2", ["mssql"]],
  ["SELECT * FROM orders WITH (NOLOCK)", ["mssql"]],
  ["CREATE TABLE t (id uniqueidentifier, n nvarchar(40))", ["mssql"]],
  // PostgreSQL
  ["SELECT * FROM customers WHERE name ILIKE '%ana%'", ["postgres"]],
  ["SELECT id::text, created::date FROM orders LIMIT 5", ["postgres"]],
  ["SELECT DISTINCT ON (customer_id) * FROM orders", ["postgres"]],
  ["SELECT * FROM generate_series(1, 10)", ["postgres"]],
  ["SELECT relname FROM pg_class", ["postgres"]],
  ["CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql", ["postgres"]],
  ["SELECT data->>'x' FROM t WHERE data::jsonb ? 'k'", ["postgres"]],
  // MySQL / MariaDB
  ["SELECT `name` FROM `customers` LIMIT 10", ["mysql", "sqlite"]],
  ["CREATE TABLE t (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB", ["mysql"]],
  ["SHOW TABLES", ["mysql"]],
  ["SELECT DATE_FORMAT(created, '%Y') FROM orders", ["mysql"]],
  ["INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE n = n + 1", ["mysql"]],
  ["SELECT * FROM orders LIMIT 10, 20", ["mysql", "sqlite"]],
  // Informix
  ["SELECT FIRST 10 * FROM orders", ["informix"]],
  ["SELECT SKIP 10 FIRST 5 * FROM orders", ["informix"]],
  ["SELECT LIMIT 3 * FROM orders", ["informix"]],
  ["SELECT NVL(total, 0), TODAY FROM orders", ["informix"]],
  ["SELECT CURRENT YEAR TO SECOND FROM systables WHERE tabid = 1", ["informix"]],
  ["SELECT * FROM t WHERE name MATCHES 'A*'", ["informix"]],
  ["SELECT * FROM orders INTO TEMP tmp_orders", ["informix"]],
  // SQLite
  ["PRAGMA table_info(orders)", ["sqlite"]],
  ["SELECT name FROM sqlite_master WHERE type = 'table'", ["sqlite"]],
  ["SELECT strftime('%Y', created) FROM orders", ["sqlite"]],
  ["CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)", ["sqlite"]],
  // Several engines.
  ["SELECT * FROM orders ORDER BY id LIMIT 5", ["postgres", "mysql", "sqlite"]],
  ["SELECT IFNULL(a, 0), GROUP_CONCAT(b) FROM t", ["mysql", "sqlite"]],
  ["INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING", ["postgres", "sqlite"]],
  ["SELECT STRING_AGG(name, ', ') FROM t", ["postgres", "mssql"]],
  // Standard SQL: no engine.
  ["SELECT c.name, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name", []],
  ["UPDATE t SET a = 1 WHERE id = :id", []],
];
for (const [sql, want] of samples) assert.deepEqual(engines(sql), want, sql);

// Markers inside comments or strings do not count.
assert.deepEqual(engines("-- SELECT TOP 10\nSELECT 1"), []);
assert.deepEqual(engines("/* ILIKE */ SELECT 'GETDATE() TOP 5 `x`'"), []);
assert.deepEqual(engines("SELECT 'it''s TODAY' AS t"), []);
// Contradicting markers: the engines most of them point to.
assert.deepEqual(engines("SELECT TOP 5 GETDATE() FROM t WHERE x ILIKE 'a'"), ["mssql"]);
assert.ok(detectEngines("SELECT TOP 10 GETDATE()").hints.includes("TOP"));

// The guess: the user's choice, then the dialect, then the connection.
assert.deepEqual(guessEngines("SELECT TOP 1 1", { override: "postgres" }).engines, ["postgres"]);
assert.equal(guessEngines("SELECT TOP 1 1", { override: "generic" }).generic, true);
assert.deepEqual(guessEngines("SELECT TOP 1 1", { connKind: "postgres" }), { engines: ["mssql"], source: "sql", generic: false, hints: ["TOP"] });
assert.deepEqual(guessEngines("SELECT 1", { connKind: "informix" }), { engines: ["informix"], source: "connection", generic: false, hints: [] });
assert.deepEqual(guessEngines("SELECT 1", { connKind: "odbc" }).source, "none", "ODBC says nothing about the engine");
assert.deepEqual(guessEngines("SELECT 1").source, "none");

// Compatibility.
const top = guessEngines("SELECT TOP 1 * FROM t");
assert.equal(compatibility(top, "mssql"), "ok");
assert.equal(compatibility(top, "postgres"), "warn");
assert.equal(compatibility(top, "odbc"), "unknown", "ODBC can be any engine");
assert.equal(compatibility(top, undefined), "unknown");
assert.equal(compatibility(guessEngines("SELECT 1"), "postgres"), "ok", "standard SQL fits everywhere");
assert.equal(compatibility(guessEngines("x", { override: "generic" }), "informix"), "ok");
assert.ok(needsEngineConfirm(top, "postgres"));
assert.ok(needsEngineConfirm(guessEngines("SELECT 1", { override: "sqlite" }), "mssql"), "marked by hand");
assert.ok(!needsEngineConfirm(guessEngines("SELECT 1", { connKind: "sqlite" }), "mssql"), "only saved with another connection: no confirmation");
assert.ok(isCompatible(top, "mssql") && !isCompatible(top, "mysql") && isCompatible(top, "odbc"));
assert.match(guessText(top, "postgres"), /SQL Server.*detectado: TOP.*No coincide con PostgreSQL/);
assert.match(guessText(guessEngines("SELECT 1")), /SQL estándar/);

// Features per engine (one table).
assert.equal(unsupportedReason("plan", "informix"), "No disponible en Informix");
assert.equal(unsupportedReason("plan", "odbc"), "No disponible en ODBC genérico");
assert.equal(unsupportedReason("plan", "mssql"), null);
assert.equal(unsupportedReason("activity", "sqlite"), "No disponible en SQLite");
assert.equal(unsupportedReason("activity", "informix"), null);
assert.equal(unsupportedReason("er", "odbc"), "No disponible en ODBC genérico");
assert.equal(unsupportedReason("schemaCompare", "odbc"), "No disponible en ODBC genérico");
assert.equal(unsupportedReason("dataCompare", "odbc"), null);
assert.equal(unsupportedReason("analyze", "mysql", "8.4.11-MySQL Community"), "No disponible en MySQL (sí en MariaDB)");
assert.equal(unsupportedReason("analyze", "mysql", "11.4.3-MariaDB"), null);
assert.equal(unsupportedReason("analyze", "mssql"), "No disponible en SQL Server");
assert.equal(unsupportedReason("plan", undefined), null, "no connection: nothing to grey out");
for (const feature of Object.values(FEATURE_SUPPORT)) assert.ok(feature.engines.length && feature.label);

console.log("engine-compat-check: all good");
