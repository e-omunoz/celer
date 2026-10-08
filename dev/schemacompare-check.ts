// Checks for src/schemaCompare.ts: node --experimental-strip-types dev/schemacompare-check.ts
import assert from "node:assert/strict";
import { compareCounts, compareSchemas, normalizeType, syncScript, type SchemaTable } from "../src/schemaCompare.ts";

const col = (name: string, typeName: string, nullable = true, primaryKey = false) => ({ name, typeName, nullable, primaryKey });

// Types: case, spaces and synonyms.
assert.equal(normalizeType("INT4"), "integer");
assert.equal(normalizeType("character varying(120)"), "varchar(120)");
assert.equal(normalizeType("VARCHAR ( 120 )"), "varchar(120)");
assert.equal(normalizeType("numeric(10, 2)"), "numeric(10,2)");
assert.equal(normalizeType("decimal(10,2)"), "numeric(10,2)");
assert.equal(normalizeType("timestamp without time zone"), "timestamp");
assert.equal(normalizeType("int4[]"), "integer[]");
assert.notEqual(normalizeType("varchar(100)"), normalizeType("varchar(120)"));

const source: SchemaTable[] = [
  { name: "customers", columns: [col("id", "integer", false, true), col("name", "varchar(120)", false), col("email", "text"), col("vip", "boolean")] },
  { name: "orders", columns: [col("id", "int4", false, true), col("total", "numeric(10,2)")] },
  { name: "invoices", columns: [col("id", "integer", false, true)] },
];
const target: SchemaTable[] = [
  { name: "Customers", columns: [col("id", "integer", false, true), col("name", "varchar(100)", false), col("email", "text", false), col("legacy_code", "text")] },
  { name: "orders", columns: [col("id", "integer", false, true), col("total", "decimal(10, 2)")] },
  { name: "audit_log", columns: [col("id", "bigint", false, true)] },
];
const diffs = compareSchemas(source, target);
assert.deepEqual(compareCounts(diffs), { different: 1, onlySource: 1, onlyTarget: 1, same: 1 });
assert.deepEqual(diffs.map((d) => `${d.status}:${d.name}`), ["different:customers", "only-source:invoices", "only-target:audit_log", "same:orders"], "differences first");
const customers = diffs[0];
assert.equal(customers.targetName, "Customers", "matched in another case");
assert.deepEqual(customers.columns.map((c) => `${c.change}:${c.name}`), ["type:name", "nullable:email", "only-source:vip", "only-target:legacy_code"]);

// The script for PostgreSQL: new table from the source DDL, new column, type and NOT NULL changes; drops commented.
const pg = syncScript(diffs, { dialect: "postgres", schema: "public", sourceDialect: "postgres", sourceDdl: { invoices: "CREATE TABLE public.invoices (id integer PRIMARY KEY)" } });
assert.match(pg, /CREATE TABLE public\.invoices \(id integer PRIMARY KEY\);/);
assert.match(pg, /ALTER TABLE "public"\."Customers" ALTER COLUMN "name" TYPE varchar\(120\);/);
assert.match(pg, /ALTER TABLE "public"\."Customers" ALTER COLUMN "email" DROP NOT NULL;/);
assert.match(pg, /ALTER TABLE "public"\."Customers" ADD COLUMN "vip" boolean;/);
assert.match(pg, /^-- Solo en el destino \(borraría sus datos\): ALTER TABLE "public"\."Customers" DROP COLUMN "legacy_code";$/m);
assert.match(pg, /^-- DROP TABLE "public"\."audit_log";$/m);
assert.ok(!/^(DROP |ALTER TABLE .* DROP COLUMN)/m.test(pg), "nothing destructive runs uncommented");

// The source's DDL moves to the target schema (its table and its references to sibling tables), quoted or not.
const moved = syncScript(compareSchemas([{ name: "f", columns: [] }], []), {
  dialect: "postgres",
  schema: "sc_b",
  sourceDialect: "postgres",
  sourceSchema: "sc_a",
  sourceDdl: { f: 'CREATE TABLE "sc_a"."f" (\n  id int REFERENCES sc_a.clientes(id),\n  note text DEFAULT \'x\'\n)' },
});
assert.match(moved, /CREATE TABLE "sc_b"\."f" \(\n {2}id int REFERENCES "sc_b"\.clientes\(id\),/);
assert.ok(!/sc_a/.test(moved), moved);
// Same schema name on both sides (two connections): left as it is.
assert.match(syncScript(compareSchemas([{ name: "f", columns: [] }], []), { dialect: "postgres", schema: "public", sourceDialect: "postgres", sourceSchema: "public", sourceDdl: { f: 'CREATE TABLE "public"."f" ()' } }), /CREATE TABLE "public"\."f" \(\);/);
// SQL Server: ADD without COLUMN, ALTER COLUMN with the nullability; a NOT NULL addition is flagged.
const ms = syncScript(compareSchemas([{ name: "t", columns: [col("id", "int", false), col("code", "nvarchar(10)", false)] }], [{ name: "t", columns: [col("id", "bigint", false)] }]), { dialect: "mssql", schema: "dbo", sourceDialect: "mssql", sourceDdl: {} });
assert.match(ms, /ALTER TABLE \[dbo\]\.\[t\] ALTER COLUMN \[id\] int NOT NULL;/);
assert.match(ms, /-- code es NOT NULL: con filas en la tabla hará falta un DEFAULT\nALTER TABLE \[dbo\]\.\[t\] ADD \[code\] nvarchar\(10\) NOT NULL;/);
// MySQL: MODIFY COLUMN. SQLite: explains instead of an impossible ALTER; no schema prefix.
assert.match(syncScript(compareSchemas([{ name: "t", columns: [col("a", "varchar(20)", false)] }], [{ name: "t", columns: [col("a", "varchar(10)", false)] }]), { dialect: "mysql", schema: "shop", sourceDialect: "mysql", sourceDdl: {} }), /ALTER TABLE `shop`\.`t` MODIFY COLUMN `a` varchar\(20\) NOT NULL;/);
const lite = syncScript(compareSchemas([{ name: "t", columns: [col("a", "TEXT")] }], [{ name: "t", columns: [col("a", "INTEGER")] }]), { dialect: "sqlite", schema: "main", sourceDialect: "sqlite", sourceDdl: {} });
assert.match(lite, /-- SQLite no cambia el tipo de una columna con ALTER: a INTEGER → TEXT/);
// Another engine's DDL is flagged; equal schemas say so.
assert.match(syncScript(compareSchemas([{ name: "n", columns: [] }], []), { dialect: "mysql", schema: "", sourceDialect: "postgres", sourceDdl: { n: "CREATE TABLE n ()" } }), /-- Definición de PostgreSQL: revísala antes de ejecutarla en MySQL/);
assert.match(syncScript(compareSchemas(source.slice(1, 2), target.slice(1, 2)), { dialect: "postgres", schema: "public", sourceDialect: "postgres", sourceDdl: {} }), /misma estructura/);
console.log("schemacompare-check: all good");
