// Checks for what a console export reads and writes (src/sql.ts exportStatement, uniqueNames):
//   node --experimental-strip-types dev/export-check.ts
import assert from "node:assert/strict";
import { exportStatement, fromTableOf, isReadOnly, resultToText, selectionExportLead, uniqueNames } from "../src/sql.ts";
import type { ColumnInfo } from "../src/types.ts";

// A script: only the SELECT behind the result on show, never its writes.
const script = "create table t(x int); insert into t values (1); select count(*) from t;";
assert.equal(exportStatement(script, "postgres", 0, 1), "select count(*) from t");
const three = "select 1; insert into t values (2); select 2; -- fin\nselect 3";
assert.equal(exportStatement(three, "postgres", 0, 3), "select 1");
assert.equal(exportStatement(three, "postgres", 2, 3), "-- fin\nselect 3");
// Results that do not match the reads (an INSERT … RETURNING grid): not guessed.
assert.equal(exportStatement("insert into t values (1) returning x; select 1", "postgres", 0, 2), null);
// A single statement that writes is refused.
assert.equal(exportStatement("delete from t", "postgres", 0, 1), null);
assert.equal(exportStatement("with d as (delete from t returning *) select * from d", "postgres", 0, 1), null);
assert.equal(exportStatement("select 1;", "postgres", 0, 1), "select 1");
assert.equal(exportStatement("  ", "postgres", 0, 1), null);

assert.ok(isReadOnly("SELECT * FROM t WHERE note = 'into'", "postgres"));
assert.ok(isReadOnly("show tables", "mysql"));
assert.ok(!isReadOnly("select * into copia from t", "postgres"));
assert.ok(!isReadOnly("select * from t into outfile '/tmp/x'", "mysql"));
assert.ok(!isReadOnly("set search_path = x", "postgres"));
assert.ok(!isReadOnly("drop table t", "postgres"));

// JSON keys: columns that share a name all appear.
assert.deepEqual(uniqueNames(["id", "name", "id", "id"]), ["id", "name", "id_2", "id_3"]);
assert.deepEqual(uniqueNames(["id", "id", "id_2"]), ["id", "id_3", "id_2"]);
const joined = resultToText(
  { columns: [{ name: "id", typeName: "int", kind: "number" }, { name: "id", typeName: "int", kind: "number" }] as ColumnInfo[], rows: [[1, 2]], hasMore: false, rowsAffected: null },
  "json",
);
assert.deepEqual(JSON.parse(joined), [{ id: 1, id_2: 2 }]);

// «Exportar selección…» lead (#236): singular for one row, and only the selected columns unless they are all.
assert.equal(selectionExportLead(1, 4, 4), "Se exporta la fila seleccionada, con todas las columnas de la rejilla, en su orden, tal como está cargada (sin volver a ejecutar la consulta).");
assert.equal(selectionExportLead(1, 1, 4), "Se exporta la fila seleccionada, con la columna seleccionada, tal como está cargada (sin volver a ejecutar la consulta).");
assert.ok(selectionExportLead(3, 2, 4).startsWith("Se exportan las 3 filas seleccionadas, con las 2 columnas seleccionadas, en el orden de la rejilla, tal como están cargadas"));
// INSERT target table (#238): the top-level FROM of the statement, quotes kept.
assert.equal(fromTableOf("SELECT * FROM pedidos WHERE id < 3", "postgres"), "pedidos");
assert.equal(fromTableOf('SELECT * FROM "Ventas 2024"', "postgres"), '"Ventas 2024"');
assert.equal(fromTableOf('SELECT * FROM public . "Clientes" c', "postgres"), 'public."Clientes"');
assert.equal(fromTableOf("SELECT extract(year FROM fecha) AS y, id FROM pedidos", "postgres"), "pedidos");
assert.equal(fromTableOf("SELECT * FROM `order`", "mysql"), "`order`");
assert.equal(fromTableOf("SELECT * FROM [dbo].[Order Lines]", "mssql"), "[dbo].[Order Lines]");
assert.equal(fromTableOf("SELECT 'from x' AS a, b /* from y */ FROM real_t", "postgres"), "real_t");
assert.equal(fromTableOf("SELECT * FROM (SELECT 1) s", "postgres"), null);
assert.equal(fromTableOf("SELECT 1", "postgres"), null);
assert.equal(fromTableOf(exportStatement("SELECT * FROM pedidos; SELECT * FROM clientes;", "postgres", 1, 2)!, "postgres"), "clientes");
console.log("export-check: ok");
