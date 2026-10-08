// Checks for src/fkLookupSql.ts: node --experimental-strip-types dev/fklookup-check.ts
import assert from "node:assert/strict";
import { lookupSql, pickLabelColumn } from "../src/fkLookupSql.ts";

const col = (name: string, kind: "text" | "number" | "date" = "text") => ({ name, kind });

// A name-like column wins; else something with "name" in it; else the first text column; numbers never.
assert.equal(pickLabelColumn([col("id", "number"), col("email"), col("nombre")], "id"), "nombre");
assert.equal(pickLabelColumn([col("id", "number"), col("notes"), col("company_name")], "id"), "company_name");
assert.equal(pickLabelColumn([col("id", "number"), col("notes"), col("ref")], "id"), "ref", "a code before free text");
assert.equal(pickLabelColumn([col("id", "number"), col("notes"), col("comments")], "id"), "notes", "else the first text column");
assert.equal(pickLabelColumn([col("id", "number"), col("email"), col("sku")], "id"), "sku");
assert.equal(pickLabelColumn([col("code"), col("total", "number")], "code"), null, "the key itself is not its label");
assert.equal(pickLabelColumn([col("id", "number"), col("alta", "date")], "id"), null);

// No text: the first rows ordered by the label.
assert.equal(lookupSql("postgres", "public.customers", '"id"', '"name"', ""), 'SELECT "id", "name" FROM public.customers ORDER BY "name" LIMIT 50');
// A search: key (as text) or label, any case.
assert.equal(
  lookupSql("postgres", "public.customers", '"id"', '"name"', " Ana "),
  `SELECT "id", "name" FROM public.customers WHERE LOWER("id"::text) LIKE '%ana%' OR LOWER("name") LIKE '%ana%' ORDER BY "name" LIMIT 50`,
);
assert.equal(lookupSql("mssql", "[dbo].[t]", "[id]", null, "7"), "SELECT TOP 50 [id] FROM [dbo].[t] WHERE LOWER(CAST([id] AS NVARCHAR(4000))) LIKE '%7%' ORDER BY [id]");
assert.equal(lookupSql("informix", "t", "id", "nombre", ""), "SELECT FIRST 50 id, nombre FROM t ORDER BY nombre");
assert.equal(lookupSql("mysql", "`t`", "`id`", null, "x"), "SELECT `id` FROM `t` WHERE LOWER(CAST(`id` AS CHAR)) LIKE '%x%' ORDER BY `id` LIMIT 50");
assert.equal(lookupSql("odbc", "t", "id", null, ""), "SELECT id FROM t ORDER BY id");
// Quotes in the search are literals, not SQL.
assert.match(lookupSql("sqlite", "t", '"id"', '"n"', "o'brien"), /LIKE '%o''brien%'/);
assert.match(lookupSql("mysql", "t", "id", "n", "a\\b"), /LIKE '%a\\\\b%'/, "MySQL backslashes are escaped");

console.log("fklookup-check: all good");
