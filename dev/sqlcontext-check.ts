// Quick checks for src/sqlContext.ts: node --experimental-strip-types dev/sqlcontext-check.ts
import assert from "node:assert/strict";
import { expectAt, findTable, identifierAt, referencedTables } from "../src/sqlContext.ts";

const tables = [
  { schema: "public", name: "customers", columns: ["id", "first_name", "country"] },
  { schema: "public", name: "events", columns: ["id", "customer_id", "kind"] },
  { schema: "sales", name: "orders", columns: ["id", "customer_id", "status"] },
  { schema: "sales", name: "Mixed", columns: ["Id"] },
];

const names = (sql: string) => referencedTables(sql, tables, "public").map((r) => `${r.table.schema}.${r.table.name}:${r.alias}`);
assert.deepEqual(names("SELECT * FROM events e JOIN customers c ON c.id = e.customer_id WHERE "), ["public.events:e", "public.customers:c"]);
assert.deepEqual(names("select * from events, sales.orders o where"), ["public.events:events", "sales.orders:o"]);
assert.deepEqual(names("UPDATE customers SET country = 'ES' WHERE id = 1"), ["public.customers:customers"]);
assert.deepEqual(names('SELECT * FROM sales."Mixed" m'), ["sales.Mixed:m"]);
assert.deepEqual(names("SELECT * FROM events WHERE kind = 'x'"), ["public.events:events"]);
assert.deepEqual(names("SELECT * FROM events LEFT JOIN customers ON true"), ["public.events:events", "public.customers:customers"]);

assert.equal(expectAt("SELECT * FROM "), "table");
assert.equal(expectAt("SELECT * FROM events JOIN "), "table");
assert.equal(expectAt("SELECT * FROM events, "), "table");
assert.equal(expectAt("SELECT "), "column");
assert.equal(expectAt("SELECT a, "), "column");
assert.equal(expectAt("SELECT * FROM events WHERE "), "column");
assert.equal(expectAt("INSERT INTO "), "table");

assert.equal(findTable(tables, ["orders"], "public")?.schema, "sales");
assert.equal(findTable(tables, ["SALES", "ORDERS"], "public")?.name, "orders");
assert.equal(identifierAt("select * from sales.orders o", 18)?.parts.join("."), "sales.orders");
assert.equal(identifierAt('from sales."Mixed" m', 10)?.parts.join("."), "sales.Mixed");
console.log("sqlContext: all checks passed");
