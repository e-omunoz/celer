// Quick checks for src/sqlContext.ts: node --experimental-strip-types dev/sqlcontext-check.ts
import assert from "node:assert/strict";
import { expectAt, findTable, identifierAt, isConnectiveKeyword, maskSql, matchTier, rankOptions, referencedTables, splitOptions, tablesInScope } from "../src/sqlContext.ts";

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
assert.equal(expectAt("INSERT INTO events ("), "column");
assert.equal(expectAt("INSERT INTO sales.orders (id, "), "column");
assert.equal(expectAt("UPDATE events SET "), "column");
assert.equal(expectAt("SELECT * FROM events GROUP BY "), "column");

// #219: the tables in scope at the caret, which completion offers first.
const catalog = [
  { schema: "dbo", name: "clientes", columns: ["cliente_id", "nombre", "pais"] },
  { schema: "dbo", name: "pedidos", columns: ["pedido_id", "cliente_id", "total"] },
  { schema: "informix", name: "articulos", columns: ["articulo_id", "descripcion"] },
  { schema: "celer", name: "lineas", columns: ["pedido_id", "articulo_id", "cantidad"] },
];
const scope = (sql: string, schema = "dbo") => {
  const caret = sql.indexOf("|");
  const text = sql.replace("|", "");
  return tablesInScope(text, caret < 0 ? text.length : caret, catalog, schema).map((r) => `${r.table.name}:${r.alias}`);
};
// Aliases, quoted names, schema/owner/database qualification, Informix database[@server]:owner.table.
assert.deepEqual(scope("SELECT * FROM clientes c JOIN pedidos p ON p.cliente_id = c.cliente_id WHERE |"), ["clientes:c", "pedidos:p"]);
assert.deepEqual(scope('SELECT * FROM "clientes" AS c WHERE |'), ["clientes:c"]);
assert.deepEqual(scope("SELECT * FROM [dbo].[pedidos] p WHERE |"), ["pedidos:p"]);
assert.deepEqual(scope("SELECT * FROM celerdemo.dbo.clientes c WHERE |"), ["clientes:c"]);
assert.deepEqual(scope("SELECT * FROM `celer`.`lineas` l WHERE |", "celer"), ["lineas:l"]);
assert.deepEqual(scope("SELECT * FROM informix.articulos a WHERE |", "informix"), ["articulos:a"]);
assert.deepEqual(scope("SELECT * FROM celerdemo:informix.articulos a WHERE |", "informix"), ["articulos:a"]);
assert.deepEqual(scope("SELECT * FROM celerdemo@ol_informix:informix.articulos WHERE |", "informix"), ["articulos:articulos"]);
// The FROM can come after the caret; UPDATE … SET; INSERT INTO t (…).
assert.deepEqual(scope("SELECT | FROM clientes c"), ["clientes:c"]);
assert.deepEqual(scope("UPDATE pedidos SET | WHERE pedido_id = 1"), ["pedidos:pedidos"]);
assert.deepEqual(scope("INSERT INTO pedidos (|"), ["pedidos:pedidos"]);
// A subquery's tables count inside it (then the outer query's, for a correlated reference), not outside it.
assert.deepEqual(scope("SELECT * FROM clientes c WHERE c.cliente_id IN (SELECT cliente_id FROM pedidos p WHERE |)"), ["pedidos:p", "clientes:c"]);
assert.deepEqual(scope("SELECT * FROM clientes c WHERE | AND c.cliente_id IN (SELECT cliente_id FROM pedidos p)"), ["clientes:c"]);
assert.deepEqual(scope("SELECT * FROM clientes c WHERE EXISTS (SELECT 1 FROM pedidos p WHERE p.cliente_id = c.cliente_id AND |"), ["pedidos:p", "clientes:c"]);
// A derived table or CTE the catalog does not know: every table of the statement, as before.
assert.deepEqual(scope("WITH x AS (SELECT * FROM pedidos) SELECT * FROM x WHERE |"), ["pedidos:pedidos"]);
// Words in strings and comments are not tables; nothing named → nothing in scope.
assert.deepEqual(scope("SELECT * FROM clientes WHERE nombre = 'from pedidos' -- join lineas\n AND |"), ["clientes:clientes"]);
assert.deepEqual(scope("SELECT |"), []);
assert.equal(maskSql("a 'b''c' d -- e\nf /* g */ h $$ i $$").length, "a 'b''c' d -- e\nf /* g */ h $$ i $$".length);
assert.equal(maskSql("x = 'it''s (' and \"a(b\" -- )\n").replace(/\s+/g, " "), "x = ' ' and \"a(b\" ");

// Ordering: the query's columns (group 0) before table names (group 1), and before keywords whatever the case typed.
const opts = [
  { option: { label: "cliente_id" }, group: 0 },
  { option: { label: "nombre" }, group: 0 },
  { option: { label: "pedido_id" }, group: 0 },
  { option: { label: "c" }, group: 0 },
  { option: { label: "clientes" }, group: 1 },
  { option: { label: "lineas" }, group: 1 },
];
const order = (typed: string) => rankOptions(opts, typed).map((r) => r.option.label);
assert.deepEqual(order("c"), ["c", "cliente_id", "clientes"]);
assert.deepEqual(order("C"), ["c", "cliente_id", "clientes"]);
assert.deepEqual(order(""), ["cliente_id", "nombre", "pedido_id", "c", "clientes", "lineas"]);
assert.deepEqual(order("id"), ["cliente_id", "pedido_id"]);
assert.deepEqual(order("ne"), ["lineas"]);
assert.equal(order("x").length, 0);
assert.deepEqual(matchTier("cliente_id", "ID"), { tier: 2, from: 8, to: 10 });
assert.deepEqual(matchTier("ClienteId", "id"), { tier: 2, from: 7, to: 9 });
assert.equal(matchTier("nombre", "o"), null);

// Split (#228): only columns matching at the start or at a word start go above keywords; "AN" must not put
// quantity (a match in the middle) or a table name before AND.
const split = (typed: string) => {
  const s = splitOptions([{ option: { label: "id" }, group: 0 }, { option: { label: "quantity" }, group: 0 }, { option: { label: "an_code" }, group: 0 }, { option: { label: "orders" }, group: 0 }, { option: { label: "plans" }, group: 1 }], typed);
  return { first: s.first.map((r) => r.option.label), rest: s.rest.map((o) => o.label) };
};
assert.deepEqual(split("AN"), { first: ["an_code"], rest: ["quantity", "plans"] });
assert.deepEqual(split("an"), { first: ["an_code"], rest: ["quantity", "plans"] });
// A whole keyword typed (OR, NOT, IN): no column goes above it, not even one starting with it (#228).
assert.deepEqual(split("OR"), { first: [], rest: ["orders", "plans"] });
assert.deepEqual(split("or"), { first: [], rest: ["orders", "plans"] });
assert.deepEqual(split("ord"), { first: ["orders"], rest: ["plans"] });
assert.equal(isConnectiveKeyword("Not"), true);
assert.equal(isConnectiveKeyword("id"), false);
assert.equal(isConnectiveKeyword("nota"), false);
assert.deepEqual(split("code"), { first: ["an_code"], rest: ["plans"] });
assert.deepEqual(split(""), { first: ["id", "quantity", "an_code", "orders"], rest: ["plans"] });
console.log("sqlContext: all checks passed");
