// Checks for src/importFormats.ts: node --experimental-strip-types dev/import-check.ts
import assert from "node:assert/strict";
import { detectDelimiter, importFormat, parseCsv, parseJsonRows } from "../src/importFormats.ts";

// CSV.
assert.deepEqual(parseCsv('a;b\r\n"x;1";"he said ""hi"""\n', ";"), [["a", "b"], ["x;1", 'he said "hi"']]);
assert.deepEqual(parseCsv('a,b\n"line\nbreak",2', ","), [["a", "b"], ["line\nbreak", "2"]]);
assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");

// JSON: an array of objects; the header is every key in order of appearance, missing keys are empty.
const objects = parseJsonRows('[{"id":1,"name":"Ana","tags":["a"]},{"id":2,"active":true,"name":null}]');
assert.equal(objects.objects, true);
assert.deepEqual(objects.rows, [
  ["id", "name", "tags", "active"],
  ["1", "Ana", '["a"]', ""],
  ["2", "", "", "true"],
]);
// An array of arrays stays as it is (the header checkbox decides).
assert.deepEqual(parseJsonRows("[[1,2],[3,null]]"), { rows: [["1", "2"], ["3", ""]], objects: false });
// An object holding the rows.
assert.deepEqual(parseJsonRows('{"count":1,"data":[{"x":"y"}]}').rows, [["x"], ["y"]]);
// A single object is one row.
assert.deepEqual(parseJsonRows('{"x":1}').rows, [["x"], ["1"]]);
// JSON Lines, with a BOM.
assert.deepEqual(parseJsonRows('\uFEFF{"a":1}\n{"a":2,"b":"z"}\n').rows, [["a", "b"], ["1", ""], ["2", "z"]]);
// Big integers arrive exactly as written (not rounded by a JavaScript number); strings and decimals as they are.
assert.deepEqual(parseJsonRows('[{"id": 9007199254740993, "n": "12345678901234567890", "x": 1.12345678901234567, "e": 1e300}]').rows[1], ["9007199254740993", "12345678901234567890", "1.1234567890123457", "1e+300"]);
assert.deepEqual(parseJsonRows('[[-12345678901234567, 5]]').rows[0], ["-12345678901234567", "5"]);
// Not JSON, or not rows.
assert.throws(() => parseJsonRows("{nope"), /no es JSON válido/);
assert.throws(() => parseJsonRows("[1,2,3]"), /objetos o listas/);
assert.throws(() => parseJsonRows('"text"'), /lista de filas/);

// Formats by extension.
assert.equal(importFormat("C:\\d\\clientes.XLSX"), "sheet");
assert.equal(importFormat("/tmp/a.ods"), "sheet");
assert.equal(importFormat("a.ndjson"), "json");
assert.equal(importFormat("a.tsv"), "csv");
assert.equal(importFormat("noext"), "csv");

console.log("import-check: all good");
