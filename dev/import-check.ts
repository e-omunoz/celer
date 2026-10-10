// Checks for src/importFormats.ts: node --experimental-strip-types dev/import-check.ts
import assert from "node:assert/strict";
import { blankRow, cellDisplay, columnLetters, detectDelimiter, detectHeader, excelSerialDate, importFormat, importLiteral, importStatements, inferCell, parseCellRange, parseCsv, parseJsonRows, pastedCells, pastedValue, plainNumber } from "../src/importFormats.ts";

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

// ---- typed cells: what a sheet sends, a block pasted from Excel, the header row, a range, the SQL written
assert.equal(plainNumber(12.5), "12.5");
assert.equal(plainNumber(1e-7), "0.0000001");
assert.equal(plainNumber(-2.5e-8), "-0.000000025");
assert.equal(plainNumber(1.5e21), "1500000000000000000000");
assert.equal(plainNumber(42), "42");
assert.equal(excelSerialDate(45366), "2024-03-15");
assert.equal(excelSerialDate(45366.5), "2024-03-15 12:00:00");
assert.equal(cellDisplay({ d: "2024-03-15" }), "2024-03-15");
assert.equal(cellDisplay(null), "");
assert.equal(cellDisplay(true), "true");

assert.equal(inferCell("1.234,56"), 1234.56, "Spanish thousands and decimal comma");
assert.equal(inferCell("1,234.56"), 1234.56, "English thousands and decimal point");
assert.equal(inferCell("-12,5"), -12.5);
assert.equal(inferCell("12.5"), 12.5);
assert.equal(inferCell("1.234"), 1.234, "a lone dot group is a decimal, as Celer copies them");
assert.equal(inferCell("0.125"), 0.125);
assert.equal(inferCell("1.234.567"), 1234567, "several dot groups are thousands");
assert.equal(inferCell("007"), "007", "codes with leading zeros stay text");
assert.equal(inferCell("1234567890123456789"), "1234567890123456789", "long digit strings stay exact");
assert.deepEqual(inferCell("15/03/2024"), { d: "2024-03-15" });
assert.deepEqual(inferCell("5/3/2024 8:30"), { d: "2024-03-05 08:30:00" });
assert.deepEqual(inferCell("2024-03-15T10:20"), { d: "2024-03-15 10:20:00" });
assert.deepEqual(inferCell("8:30"), { t: "08:30:00" });
assert.equal(inferCell("VERDADERO"), true);
assert.equal(inferCell("falso"), false);
assert.equal(inferCell("  "), null);
assert.equal(inferCell("Ana Ruiz"), "Ana Ruiz");
assert.equal(inferCell("31/02/2024 x"), "31/02/2024 x");

const pasted = pastedCells("id\tnombre\talta\tsaldo\tactivo\r\n1\tAna\t15/03/2024\t12,50\tVERDADERO\r\n2\tLuis\t\t0\tFALSO\r\n");
assert.deepEqual(pasted, [
  ["id", "nombre", "alta", "saldo", "activo"],
  [1, "Ana", { d: "2024-03-15" }, 12.5, true],
  [2, "Luis", null, 0, false],
]);
assert.deepEqual(pastedCells('a\t"two\nlines"\n'), [["a", "two\nlines"]], "a quoted field keeps its line break");
assert.equal(pastedValue("15/03/2024", "date"), "2024-03-15");
assert.equal(pastedValue("1.234,5", "number"), "1234.5");
assert.equal(pastedValue("VERDADERO", "bool"), "true");
assert.equal(pastedValue("1", "bool"), "true");
assert.equal(pastedValue("", "number"), null);
assert.equal(pastedValue("1.234,5", "text"), "1.234,5", "text columns take the text as it is");
assert.equal(pastedValue("45366", "date"), "2024-03-15", "a serial number into a date column");

// Header detection: a title and a blank row above the header are skipped.
assert.deepEqual(detectHeader(pasted), { header: 0, start: 1 });
assert.deepEqual(detectHeader([["Informe de clientes", null, null], [null, null, null], ["id", "nombre", "alta"], [1, "Ana", { d: "2024-03-15" }]]), { header: 2, start: 3 });
assert.deepEqual(detectHeader([[1, "Ana", true], [2, "Luis", false]]), { header: -1, start: 0 }, "numbers in the first full row: no header");
assert.deepEqual(detectHeader([["Título", null], [1, "Ana"], [2, "Luis"]]), { header: -1, start: 1 }, "a title over data without header");
assert.deepEqual(detectHeader([["id", "id"], [1, 2]]), { header: -1, start: 0 }, "repeated names are not a header");
assert.deepEqual(detectHeader([["2024", "100"], [1, 2]]), { header: -1, start: 0 }, "numbers written as text are not a header");
assert.deepEqual(detectHeader([]), { header: -1, start: 0 });

// Cell ranges.
assert.deepEqual(parseCellRange("B3:F200"), { r1: 2, c1: 1, r2: 199, c2: 5 });
assert.deepEqual(parseCellRange(" b3 : f "), { r1: 2, c1: 1, r2: null, c2: 5 });
assert.deepEqual(parseCellRange("B:F"), { r1: 0, c1: 1, r2: null, c2: 5 });
assert.deepEqual(parseCellRange("$AA$10"), { r1: 9, c1: 26, r2: null, c2: null });
assert.equal(parseCellRange("F3:B2"), null, "backwards");
assert.equal(parseCellRange("hola"), null);
assert.equal(columnLetters(0), "A");
assert.equal(columnLetters(25), "Z");
assert.equal(columnLetters(26), "AA");
assert.equal(columnLetters(701), "ZZ");

// The SQL: typed values for each column kind, and per engine.
const col = (name: string, kind: string, typeName: string, nullable = true) => ({ name, kind, typeName, nullable, primaryKey: false, identity: false }) as never;
const cols = [col("id", "number", "int", false), col("nombre", "text", "varchar(40)"), col("alta", "date", "date"), col("saldo", "number", "numeric(10,2)"), col("activo", "bool", "boolean"), col("momento", "date", "datetime year to second")];
const target = { qualified: "t", columns: cols, quoted: ["id", "nombre", "alta", "saldo", "activo", "momento"], mapping: [0, 1, 2, 3, 4, 2], emptyAsNull: true };
const row = [7, "O'Neil", { d: "2024-03-15 10:20:00" }, 12.5, true];
assert.deepEqual(importStatements([row], target, "postgres"), ["INSERT INTO t (id, nombre, alta, saldo, activo, momento) VALUES\n(7, 'O''Neil', '2024-03-15', 12.5, TRUE, '2024-03-15 10:20:00')"]);
assert.deepEqual(importStatements([row], target, "mssql"), ["INSERT INTO t (id, nombre, alta, saldo, activo, momento) VALUES\n(7, N'O''Neil', N'2024-03-15', 12.5, 1, N'2024-03-15 10:20:00')"]);
assert.deepEqual(importStatements([row, [8, "B", null, null, null]], target, "informix"), [
  "INSERT INTO t (id, nombre, alta, saldo, activo, momento) VALUES (7, 'O''Neil', MDY(3, 15, 2024), 12.5, 't', '2024-03-15 10:20:00');\nINSERT INTO t (id, nombre, alta, saldo, activo, momento) VALUES (8, 'B', NULL, NULL, NULL, NULL)",
], "Informix: one INSERT per row (no multi-row VALUES), sent together");
assert.equal(importLiteral(45366, cols[2], "postgres", true), "'2024-03-15'", "a serial number into a date column");
assert.equal(importLiteral(1, cols[4], "mysql", true), "TRUE");
assert.equal(importLiteral(true, cols[3], "postgres", true), "1", "a boolean into a number column");
assert.equal(importLiteral(1e-7, cols[3], "postgres", true), "0.0000001", "no exponent");
assert.equal(importLiteral("", cols[1], "postgres", true), "NULL");
assert.equal(importLiteral("", cols[1], "postgres", false), "''");
assert.equal(importLiteral("2024-03-15", cols[2], "informix", true), "MDY(3, 15, 2024)", "ISO text into an Informix DATE too");
assert.equal(importLiteral({ t: "08:30:00" }, col("hora", "date", "time"), "postgres", true), "'08:30:00'");
assert.equal(importLiteral(null, cols[0], "postgres", true), "NULL");
assert.equal(importStatements(Array.from({ length: 1001 }, () => row), target, "postgres").length, 3, "500 rows per statement");
assert.equal(importStatements(Array.from({ length: 1001 }, () => row), target, "mssql").length, 2, "900 on SQL Server");
assert.ok(blankRow([null, "  ", 3], [0, 1, -1, -1, -1, -1]), "nothing in the mapped columns");
assert.ok(!blankRow([null, "x"], [0, 1]));

console.log("import-check: all good");
