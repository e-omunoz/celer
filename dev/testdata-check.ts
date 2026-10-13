// Checks for the test data generator (src/testData.ts, src/testDataSql.ts): inference, ranges, uniqueness,
// determinism, value lists, NULL ratio, Spanish data, patterns, CHECK reading, outputs.
//   node --experimental-strip-types dev/testdata-check.ts
import assert from "node:assert/strict";
import { importStatements } from "../src/importFormats.ts";
import {
  buildModel,
  cif,
  createGenerator,
  exportText,
  inferSettings,
  insertStatements,
  nif,
  normName,
  parseList,
  parsePattern,
  patternVariety,
  previewRows,
  problems,
  scriptText,
  slug,
  validCif,
  validIban,
  validNif,
  fitText,
  iban,
  type GenSettings,
  type ModelInput,
  type TableModel,
} from "../src/testData.ts";
import { catalogQueries, checkClauses, effectiveDialect, enumValues, parentKeysSql, readCatalog, readChecks, statsSql, typeInfo } from "../src/testDataSql.ts";
import type { DbKind, TableColumn } from "../src/types.ts";
import type { SheetCell } from "../src/importFormats.ts";

const col = (name: string, typeName: string, kind: TableColumn["kind"], extra: Partial<TableColumn> = {}): TableColumn => ({ name, typeName, kind, nullable: true, primaryKey: false, identity: false, default: null, ...extra });

// ---------------------------------------------------------------- types
assert.deepEqual(typeInfo(col("a", "character varying(80)", "text"), "postgres"), { family: "text", maxLength: 80, bytes: false });
assert.deepEqual(typeInfo(col("a", "numeric(10,2)", "number"), "postgres"), { family: "decimal", precision: 10, scale: 2 });
assert.equal(typeInfo(col("a", "numeric", "number"), "postgres").scale, 2, "NUMERIC without precision: 2 decimals");
assert.deepEqual(typeInfo(col("a", "int(10) unsigned", "number"), "mysql"), { family: "int", min: "0", max: "4294967295" });
assert.deepEqual(typeInfo(col("a", "tinyint", "number"), "mssql"), { family: "int", min: "0", max: "255" });
assert.equal(typeInfo(col("a", "tinyint(1)", "bool"), "mysql").family, "bool");
assert.equal(typeInfo(col("a", "bit", "bool"), "mssql").family, "bool");
assert.equal(typeInfo(col("a", "nvarchar(max)", "text"), "mssql").maxLength, undefined, "NVARCHAR(MAX): no limit");
assert.deepEqual(typeInfo(col("a", "varchar(12)", "text"), "informix"), { family: "text", maxLength: 12, bytes: true });
assert.ok(typeInfo(col("a", "byte", "binary"), "informix").noLiteral, "Informix BYTE takes no literal");
assert.equal(typeInfo(col("a", "datetime year to second", "date"), "informix").family, "datetime");
assert.equal(typeInfo(col("a", "datetime hour to minute", "date"), "informix").family, "time");
assert.equal(typeInfo(col("a", "datetime2", "date"), "mssql").family, "datetime");
assert.equal(typeInfo(col("a", "int4", "other"), "odbc").family, "int", "ODBC names: int4");
assert.equal(typeInfo(col("a", "bytea", "other"), "odbc").family, "binary");
assert.deepEqual(typeInfo(col("a", "varbinary(32)", "binary"), "mssql"), { family: "binary", maxLength: 32, fixed: false });
assert.deepEqual(enumValues("enum('nuevo','it''s','b\\'c')"), ["nuevo", "it's", "b'c"]);
assert.equal(enumValues("varchar(10)"), null);
assert.equal(effectiveDialect("odbc", "PostgreSQL 17.2"), "postgres");
assert.equal(effectiveDialect("odbc", "Microsoft SQL Server 16.0"), "mssql");
assert.equal(effectiveDialect("odbc", "Acme DB 1.0"), "odbc");
assert.equal(effectiveDialect("mysql", "PostgreSQL"), "mysql", "only ODBC is looked through");

// ---------------------------------------------------------------- CHECK constraints as each engine writes them
const cols = ["prioridad", "puntos", "importe", "estado", "notas"];
// PostgreSQL (pg_get_constraintdef).
let read = readChecks(["CHECK (((prioridad)::text = ANY ((ARRAY['baja'::character varying, 'media'::character varying, 'alta'::character varying])::text[])))", "CHECK (((puntos >= 0) AND (puntos <= 100)))", "CHECK ((importe > (0)::numeric))"], cols);
assert.deepEqual(read.rules.prioridad, { values: ["baja", "media", "alta"] });
assert.deepEqual(read.rules.puntos, { min: 0, max: 100, minOpen: undefined, maxOpen: undefined });
assert.equal(read.rules.importe.min, 0);
assert.equal(read.rules.importe.minOpen, true);
assert.deepEqual(read.unknown, []);
// SQL Server (IN becomes ORs, numbers in parentheses).
read = readChecks(["([prioridad]='alta' OR [prioridad]='media' OR [prioridad]='baja')", "([puntos]>=(0) AND [puntos]<=(100))"], cols);
assert.deepEqual(read.rules.prioridad.values, ["alta", "media", "baja"]);
assert.equal(read.rules.puntos.max, 100);
// MySQL (charset introducers), MariaDB, Informix, SQLite.
read = readChecks(["(`prioridad` in (_utf8mb4'baja',_utf8mb4'media',_utf8mb4'alta'))", "(`puntos` between 0 and 100)"], cols);
assert.deepEqual(read.rules.prioridad.values, ["baja", "media", "alta"]);
assert.deepEqual([read.rules.puntos.min, read.rules.puntos.max], [0, 100]);
read = readChecks(["`prioridad` in ('baja','media','alta')", "json_valid(`notas`)"], cols);
assert.deepEqual(read.rules.prioridad.values, ["baja", "media", "alta"]);
assert.deepEqual(read.unknown, [], "json_valid says nothing new");
read = readChecks(["(prioridad IN ('baja' ,'media' ,'alta' ))", "((puntos >= 0 ) AND (puntos <= 100 ) )"], cols);
assert.deepEqual(read.rules.prioridad.values, ["baja", "media", "alta"]);
assert.equal(read.rules.puntos.max, 100);
// Reversed comparison, NOT IN and a function: a range, then two columns Celer does not read.
read = readChecks(["0 <= puntos", "estado NOT IN ('x')", "char_length(notas) > 3"], cols);
assert.equal(read.rules.puntos.min, 0);
assert.deepEqual(read.unknown.sort(), ["estado", "notas"]);
assert.deepEqual(checkClauses("CREATE TABLE t (a TEXT CHECK (a IN ('x', ')')), b INT, CHECK (b BETWEEN 1 AND 5))"), ["a IN ('x', ')')", "b BETWEEN 1 AND 5"]);

// Informix keeps a CHECK in 32-character pieces: trailing blanks of a middle piece are part of the text.
{
  const facts = readCatalog(
    [
      { part: "check", rows: [["c1", "", 1, "(prioridad IN ('baja' ,'media'"], ["c1", "", 2, " ,'alta' ))"]] },
      { part: "unique", rows: [["u1", "codigo", 1, ""], ["pk", "id", 1, ""], ["u2", "a", 1, ""], ["u2", "b", 2, ""], ["expr", "", 1, ""]] },
    ],
    "informix",
  );
  assert.equal(facts.checks[0].text, "(prioridad IN ('baja' ,'media'   ,'alta' ))");
  assert.deepEqual(facts.uniques, [["codigo"], ["id"], ["a", "b"]], "an expression index is not a column key");
}

// Generic ODBC says neither identity nor CHAR length: the engine's catalog tells the first, the name does the rest.
{
  const columns = [col("id", "int4", "other", { nullable: false, primaryKey: true }), col("nif", "bpchar", "other")];
  const facts = readCatalog([{ part: "auto", rows: [["", "id", 1, ""]] }], "postgres");
  const mm = buildModel({ dialect: "postgres", qualified: "t", table: "t", columns, quoted: ["id", "nif"], catalog: facts, fks: [] });
  assert.deepEqual(inferSettings(mm).map((x) => x.kind), ["skip", "nif"]);
}

// MySQL 8 shows a CHECK's quotes escaped in information_schema.
{
  const facts = readCatalog([{ part: "check", rows: [["c", "", 0, "(`prioridad` in (_utf8mb4\\'baja\\',_utf8mb4\\'alta\\'))"]] }], "mysql");
  assert.deepEqual(readChecks(facts.checks.map((c) => c.text), cols).rules.prioridad.values, ["baja", "alta"]);
}

// The catalog SQL names the table in each dialect.
for (const d of ["postgres", "mysql", "mssql", "sqlite", "informix"] as DbKind[]) {
  const q = catalogQueries(d, { database: "celer", schema: d === "informix" ? "informix" : "public", name: "o'k", qualified: "[o'k]" }, "MariaDB 11.4");
  assert.ok(q.length >= 2, d);
  assert.ok(q.every((part) => part.sql.includes("o''k")), `${d}: the table name is quoted`);
}
assert.deepEqual(catalogQueries("odbc", { database: "", schema: "", name: "t", qualified: "t" }), []);
assert.match(parentKeysSql("mssql", "p", ["[id]"], 10), /^SELECT TOP 10 \[id\] FROM p WHERE \[id\] IS NOT NULL ORDER BY 1$/);
assert.match(parentKeysSql("informix", "p", ["id", "k"], 10), /^SELECT FIRST 10 id, k FROM p WHERE id IS NOT NULL AND k IS NOT NULL ORDER BY 1, 2$/);
assert.match(parentKeysSql("postgres", "p", ['"id"'], 10), /LIMIT 10$/);
assert.equal(statsSql("t", ['"id"']), 'SELECT COUNT(*), MAX("id") FROM t');

// ---------------------------------------------------------------- a table like the engines' test table
function model(dialect: DbKind = "postgres", over: Partial<ModelInput> = {}): TableModel {
  const columns = [
    col("id", "integer", "number", { nullable: false, primaryKey: true, identity: true }),
    col("codigo", "character varying(12)", "text", { nullable: false }),
    col("nombre", "character varying(40)", "text", { nullable: false }),
    col("apellidos", "character varying(60)", "text"),
    col("email", "character varying(120)", "text"),
    col("parent_id", "integer", "number", { nullable: false }),
    col("estado", "celer_td_estado", "text", { nullable: false }),
    col("prioridad", "character varying(10)", "text", { nullable: false }),
    col("puntos", "integer", "number"),
    col("alta", "date", "date", { nullable: false }),
    col("momento", "timestamp without time zone", "date"),
    col("importe", "numeric(10,2)", "number", { nullable: false }),
    col("activo", "boolean", "bool", { nullable: false }),
    col("notas", "text", "text"),
    col("foto", "bytea", "binary"),
    col("nif", "character(9)", "text"),
    col("telefono", "character varying(20)", "text"),
    col("ciudad", "character varying(40)", "text"),
    col("cp", "character varying(5)", "text"),
  ];
  return buildModel({
    dialect,
    qualified: "public.celer_td_child",
    table: "celer_td_child",
    columns,
    quoted: columns.map((c) => `"${c.name}"`),
    catalog: {
      uniques: [["id"], ["codigo"], ["email"]],
      checks: [
        { name: "c1", column: "", text: "CHECK (((prioridad)::text = ANY ((ARRAY['baja'::character varying, 'media'::character varying, 'alta'::character varying])::text[])))" },
        { name: "c2", column: "", text: "CHECK (((puntos >= 0) AND (puntos <= 100)))" },
      ],
      enums: { estado: ["nuevo", "enviado", "entregado"] },
    },
    stats: [0, null, null, null],
    fks: [{ name: "fk_parent", columns: ["parent_id"], target: { database: "celer", schema: "public", name: "celer_td_parent", kind: "table" }, targetColumns: ["id"], rows: [[1], [2], [3], [5], [8]] }],
    ...over,
  });
}

const m = model();
const s = inferSettings(m, "es");
const kinds = Object.fromEntries(m.columns.map((c, i) => [c.col.name, s[i].kind]));
assert.deepEqual(kinds, {
  id: "skip",
  codigo: "pattern",
  nombre: "firstName",
  apellidos: "lastName",
  email: "expression",
  parent_id: "fk",
  estado: "list",
  prioridad: "list",
  puntos: "integer",
  alta: "date",
  momento: "datetime",
  importe: "price",
  activo: "boolean",
  notas: "lorem",
  foto: "binary",
  nif: "nif",
  telefono: "phone",
  ciudad: "city",
  cp: "postalCode",
});
const at = (name: string) => m.columns.findIndex((c) => c.col.name === name);
assert.equal(s[at("email")].template, "{nombre|slug}.{apellidos|slug}{#}@example.com", "a unique e-mail from the row's name");
assert.equal(s[at("estado")].values, "nuevo\nenviado\nentregado", "native enum");
assert.equal(s[at("prioridad")].values, "baja\nmedia\nalta", "CHECK IN");
assert.deepEqual([s[at("puntos")].min, s[at("puntos")].max], ["0", "100"], "CHECK BETWEEN narrows the range");
assert.equal(s[at("notas")].nullPct, 10, "nullable columns get some NULLs");
assert.equal(s[at("codigo")].nullPct, 0);
assert.deepEqual(problems(m, s, 10_000), []);

// More inference: names in Spanish and English, types.
{
  const columns = [
    col("FechaNacimiento", "date", "date"),
    col("first_name", "varchar(30)", "text"),
    col("last_name", "varchar(30)", "text"),
    col("full_name", "varchar(80)", "text"),
    col("Contact_Email", "varchar(100)", "text"),
    col("zip_code", "varchar(10)", "text"),
    col("country", "char(2)", "text"),
    col("company_name", "varchar(80)", "text"),
    col("vat_number", "varchar(12)", "text"),
    col("iban", "varchar(34)", "text"),
    col("website", "varchar(200)", "text"),
    col("username", "varchar(30)", "text"),
    col("password_hash", "varchar(60)", "text"),
    col("price", "decimal(8,2)", "number"),
    col("qty", "int", "number"),
    col("status", "varchar(20)", "text"),
    col("guid", "uniqueidentifier", "text"),
    col("payload", "jsonb", "text"),
    col("cif", "char(9)", "text"),
    col("age", "smallint", "number"),
    col("sexo", "char(1)", "text"),
    col("ip_address", "varchar(45)", "text"),
    col("hora", "time", "date"),
    col("created_at", "text", "text"),
    col("id_externo", "bigint", "number", { nullable: false }),
  ];
  const mm = buildModel({ dialect: "mssql", qualified: "dbo.t", table: "people", columns, quoted: columns.map((c) => `[${c.name}]`), catalog: { uniques: [["id_externo"]], checks: [], enums: {} }, stats: [41, 5, 30, 1234], fks: [] });
  const ss = inferSettings(mm, "en");
  const got = Object.fromEntries(mm.columns.map((c, i) => [c.col.name, ss[i].kind]));
  assert.equal(got.FechaNacimiento, "date");
  assert.deepEqual([ss[0].min, ss[0].max], ["1950-01-01", "2005-12-31"], "birth dates are of adults");
  assert.equal(got.first_name, "firstName");
  assert.equal(got.last_name, "lastName");
  assert.equal(got.full_name, "fullName");
  assert.equal(got.Contact_Email, "expression");
  assert.equal(got.zip_code, "postalCode");
  assert.equal(got.country, "country");
  assert.equal(got.company_name, "company");
  assert.equal(got.vat_number, "nif");
  assert.equal(got.iban, "iban");
  assert.equal(got.website, "url");
  assert.equal(got.username, "username");
  assert.equal(got.password_hash, "password");
  assert.equal(got.price, "price");
  assert.equal(got.qty, "quantity");
  assert.equal(got.status, "status");
  assert.equal(got.guid, "uuid");
  assert.equal(got.payload, "json");
  assert.equal(got.cif, "cif");
  assert.equal(got.age, "integer");
  assert.equal(got.sexo, "pattern");
  assert.equal(got.ip_address, "ip");
  assert.equal(got.hora, "time");
  assert.equal(got.created_at, "date", "a date kept as text");
  assert.equal(got.id_externo, "sequence");
  assert.equal(ss[columns.length - 1].start, "1235", "a unique integer continues after the largest value");
  // Its rows are valid.
  const gen = createGenerator(mm, ss, 7, "en");
  for (let i = 0; i < 300; i++) {
    const row = gen.next();
    assert.match(String(row[4] ?? "x@y"), /@/);
    assert.ok(row[6] === null || String(row[6]).length === 2, "country in two letters");
    assert.ok(row[8] === null || validNif(String(row[8])), `nif ${row[8]}`);
    assert.ok(row[9] === null || validIban(String(row[9])), `iban ${row[9]}`);
    assert.ok(row[12] === null || String(row[12]).startsWith("$2b$10$") && String(row[12]).length === 60, "bcrypt-like hash fits 60");
    assert.ok(row[18] === null || validCif(String(row[18])), `cif ${row[18]}`);
    assert.ok(row[20] === null || row[20] === "M" || row[20] === "F", "sex in English: M / F");
    assert.equal(row[24], 1235 + i, "sequence");
  }
}

// ---------------------------------------------------------------- determinism
const rowsOf = (mm: TableModel, ss: GenSettings[], seed: number, n: number, locale: "es" | "en" = "es") => {
  const gen = createGenerator(mm, ss, seed, locale);
  return Array.from({ length: n }, () => gen.next());
};
assert.deepEqual(rowsOf(m, s, 42, 500), rowsOf(m, s, 42, 500), "same seed and settings: same rows");
assert.notDeepEqual(rowsOf(m, s, 42, 50), rowsOf(m, s, 43, 50), "another seed: other rows");
// Changing one column's generator leaves the others as they were.
{
  const changed = s.map((x, i) => (i === at("notas") ? { ...x, kind: "constant" as const, value: "x" } : x));
  const a = rowsOf(m, s, 9, 100);
  const b = rowsOf(m, changed, 9, 100);
  for (const name of ["codigo", "parent_id", "importe", "alta"]) assert.deepEqual(a.map((r) => r[at(name)]), b.map((r) => r[at(name)]), name);
}

// ---------------------------------------------------------------- the rows respect the table
{
  const rows = rowsOf(m, s, 1234, 10_000);
  const codes = new Set<string>();
  const emails = new Set<string>();
  let nulls = 0;
  for (const row of rows) {
    assert.equal(row[at("id")], null, "identity left to the server");
    const code = String(row[at("codigo")]);
    assert.match(code, /^[A-Z]{3}-\d{4}$/);
    assert.ok(!codes.has(code), `unique codigo ${code}`);
    codes.add(code);
    const email = row[at("email")];
    if (email !== null) {
      assert.ok(!emails.has(String(email)), `unique email ${email}`);
      emails.add(String(email));
      assert.ok(String(email).length <= 120);
    }
    assert.ok([1, 2, 3, 5, 8].includes(row[at("parent_id")] as number), "FK takes parent keys only");
    assert.ok(["nuevo", "enviado", "entregado"].includes(String(row[at("estado")])));
    assert.ok(["baja", "media", "alta"].includes(String(row[at("prioridad")])));
    const puntos = row[at("puntos")];
    if (puntos === null) nulls++;
    else assert.ok(Number(puntos) >= 0 && Number(puntos) <= 100);
    const importe = String(row[at("importe")]);
    assert.match(importe, /^\d{1,8}\.\d{2}$/, "decimal(10,2)");
    assert.equal(typeof row[at("activo")], "boolean");
    const alta = row[at("alta")] as { d: string };
    assert.match(alta.d, /^202[0-5]-\d{2}-\d{2}$/);
    const foto = row[at("foto")];
    assert.ok(foto === null || /^0x[0-9A-F]{8,32}$/.test(String(foto)), `binary ${foto}`);
    const n = row[at("nif")];
    assert.ok(n === null || validNif(String(n)), `nif ${n}`);
    const name = String(row[at("nombre")]);
    assert.ok(name.length <= 40 && name.length > 1);
    const cp = row[at("cp")];
    assert.ok(cp === null || /^\d{5}$/.test(String(cp)), `cp ${cp}`);
  }
  // About 10% NULLs in a nullable column (seeded: always the same count).
  assert.ok(nulls > 800 && nulls < 1200, `null ratio ${nulls}`);
  // Spanish data: names and cities from the Spanish lists, e-mails from the same row's name.
  const row = rows[0];
  assert.match(String(row[at("email")] ?? `${slug(String(row[at("nombre")]))}.x`), new RegExp(`^${slug(String(row[at("nombre")])).replace(/\./g, "\\.")}`));
}

// Unique columns that run out: a clear error, before and while generating.
{
  const ss = s.map((x) => ({ ...x }));
  ss[at("codigo")] = { ...ss[at("codigo")], pattern: "[AB]\\d" };
  const p = problems(m, ss, 100);
  assert.ok(p.some((x) => x.error && x.column === at("codigo") && /20 valores distintos/.test(x.text)), JSON.stringify(p));
  assert.throws(() => rowsOf(m, ss, 1, 100), /es única/);
}
// Problems: a NOT NULL column left out, a NULL-only required column, an empty parent, a bad pattern, an unknown column.
{
  const ss = s.map((x) => ({ ...x }));
  ss[at("nombre")] = { ...ss[at("nombre")], kind: "skip" };
  ss[at("alta")] = { ...ss[at("alta")], kind: "null" };
  ss[at("codigo")] = { ...ss[at("codigo")], pattern: "[A-" };
  ss[at("email")] = { ...ss[at("email")], template: "{nope}@x" };
  const p = problems(m, ss, 10).map((x) => x.text);
  assert.ok(p.some((t) => /«nombre» es obligatoria/.test(t)), p.join("\n"));
  assert.ok(p.some((t) => /«alta» no admite NULL/.test(t)));
  assert.ok(p.some((t) => /corchete/.test(t)));
  assert.ok(p.some((t) => /\{nope\}/.test(t)));
  const empty = model("postgres", { fks: [{ name: "fk_parent", columns: ["parent_id"], target: { database: "", schema: "public", name: "celer_td_parent", kind: "table" }, targetColumns: ["id"], rows: [] }] });
  const pe = problems(empty, inferSettings(empty), 10);
  const parent = pe.find((x) => x.parent);
  assert.ok(parent && parent.error && /celer_td_parent, que está vacía/.test(parent.text), JSON.stringify(pe));
  assert.equal(previewRows(empty, inferSettings(empty), 1, "es").error.includes("vacía"), true);
  assert.equal(problems(m, s, 0)[0].text, "Indica cuántas filas generar");
  assert.ok(problems(m, s, 2_000_000).some((x) => x.error));
}

// ---------------------------------------------------------------- generators one by one
{
  const one = (typeName: string, kind: TableColumn["kind"], settings: Partial<GenSettings>, n = 200, dialect: DbKind = "postgres", extra: Partial<TableColumn> = {}) => {
    const c = col("x", typeName, kind, { nullable: false, ...extra });
    const mm = buildModel({ dialect, qualified: "t", table: "t", columns: [c], quoted: ["x"], catalog: { uniques: extra.primaryKey ? [["x"]] : [], checks: [], enums: {} }, fks: [] });
    const ss: GenSettings[] = [{ ...inferSettings(mm)[0], ...settings }];
    return rowsOf(mm, ss, 5, n).map((r) => r[0]);
  };
  // Pattern.
  for (const v of one("varchar(20)", "text", { kind: "pattern", pattern: "[A-Z]{3}-\\d{4}" })) assert.match(String(v), /^[A-Z]{3}-\d{4}$/);
  for (const v of one("varchar(20)", "text", { kind: "pattern", pattern: "(ES|PT)-\\d{2}[a-c]?" })) assert.match(String(v), /^(ES|PT)-\d{2}[a-c]?$/);
  assert.equal(patternVariety(parsePattern("[A-Z]{3}-\\d{4}")), 26 ** 3 * 10 ** 4);
  assert.throws(() => parsePattern("(ab"), /paréntesis/);
  // Sequence, with step; bigints stay exact.
  assert.deepEqual(one("bigint", "number", { kind: "sequence", start: "9007199254740990", step: "2" }, 4), [9007199254740990, "9007199254740992", "9007199254740994", "9007199254740996"]);
  // Integer range and its type limit.
  for (const v of one("smallint", "number", { kind: "integer", min: "-5", max: "5" })) assert.ok(Number(v) >= -5 && Number(v) <= 5);
  assert.throws(() => one("smallint", "number", { kind: "integer", min: "0", max: "70000" }), /no cabe/);
  // Decimal scale.
  for (const v of one("numeric(6,3)", "number", { kind: "decimal", min: "-1", max: "1" })) assert.match(String(v), /^-?\d\.\d{3}$/);
  // Constant, list with weights.
  assert.deepEqual(one("varchar(5)", "text", { kind: "constant", value: "abcdefgh" }, 2), ["abcde", "abcde"], "cut to the column");
  assert.deepEqual(parseList("a *3\nb\n\n c *0.5"), [{ value: "a", weight: 3 }, { value: "b", weight: 1 }, { value: " c", weight: 0.5 }]);
  const weighted = one("varchar(5)", "text", { kind: "list", values: "a *9\nb" }, 2000);
  const as = weighted.filter((v) => v === "a").length;
  assert.ok(as > 1650 && as < 1950, `weights: ${as} of 2000`);
  // Dates and times within their range.
  for (const v of one("date", "date", { kind: "date", min: "2024-02-01", max: "2024-02-29" })) assert.match((v as { d: string }).d, /^2024-02-(0[1-9]|[12]\d)$/);
  for (const v of one("time", "date", { kind: "time", min: "09:00", max: "09:59:59" })) assert.match((v as { t: string }).t, /^09:\d{2}:\d{2}$/);
  // SQL Server DATETIME: ISO with T (its text form depends on the session's language otherwise).
  for (const v of one("datetime", "date", { kind: "datetime" }, 5, "mssql")) assert.match((v as { d: string }).d, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  for (const v of one("datetime year to second", "date", { kind: "date" }, 5, "informix")) assert.match((v as { d: string }).d, / 00:00:00$/);
  // UUID v4, binary of a fixed size, Informix bytes.
  for (const v of one("uuid", "text", { kind: "uuid" })) assert.match(String(v), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const v of one("binary(4)", "binary", { kind: "binary" }, 20, "mssql")) assert.match(String(v), /^0x[0-9A-F]{8}$/);
  for (const v of one("varchar(6)", "text", { kind: "fullName" }, 50, "informix")) assert.ok(new TextEncoder().encode(String(v)).length <= 6, `bytes: ${v}`);
  assert.equal(fitText("Peña Núñez", { family: "text", maxLength: 6, bytes: true }), "Peña");
  // Unique text adds the row number once values repeat; a unique boolean cannot reach 10 rows.
  const statuses = one("varchar(20)", "text", { kind: "status" }, 300, "postgres", { primaryKey: true });
  assert.equal(new Set(statuses).size, 300);
  // NULL ratio: 0 % and 100 % of a nullable column.
  const nullable = (pct: number) => {
    const c = col("x", "int", "number");
    const mm = buildModel({ dialect: "postgres", qualified: "t", table: "t", columns: [c], quoted: ["x"], catalog: { uniques: [], checks: [], enums: {} }, fks: [] });
    return rowsOf(mm, [{ ...inferSettings(mm)[0], nullPct: pct }], 3, 200).filter((r) => r[0] === null).length;
  };
  assert.equal(nullable(0), 0);
  assert.equal(nullable(100), 200);
  // SQL Server and Informix: a unique nullable column takes one NULL at most.
  {
    const c = col("x", "varchar(30)", "text");
    const mm = buildModel({ dialect: "mssql", qualified: "t", table: "t", columns: [c], quoted: ["x"], catalog: { uniques: [["x"]], checks: [], enums: {} }, fks: [] });
    const rows = rowsOf(mm, [{ ...inferSettings(mm)[0], kind: "email", nullPct: 50 }], 3, 200);
    assert.equal(rows.filter((r) => r[0] === null).length, 1);
  }
  // MySQL compares text without case or accents: "García" and "garcia" are the same key.
  {
    const c = col("x", "varchar(10)", "text");
    const mm = buildModel({ dialect: "mysql", qualified: "t", table: "t", columns: [c], quoted: ["x"], catalog: { uniques: [["x"]], checks: [], enums: {} }, fks: [], existingValues: { x: ["ABC"] } });
    const rows = rowsOf(mm, [{ ...inferSettings(mm)[0], kind: "list", values: "abc\nAbc\nÁbc\nxyz" }], 3, 1);
    assert.deepEqual(rows, [["xyz"]], "existing values and their case / accent variants are taken");
  }
  // Composite keys: every combination once.
  {
    const columns = [col("a", "int", "number", { nullable: false, primaryKey: true }), col("b", "int", "number", { nullable: false, primaryKey: true })];
    const mm = buildModel({ dialect: "postgres", qualified: "t", table: "t", columns, quoted: ["a", "b"], catalog: { uniques: [], checks: [], enums: {} }, fks: [] });
    const ss = inferSettings(mm).map((x) => ({ ...x, kind: "integer" as const, min: "1", max: "5" }));
    const rows = rowsOf(mm, ss, 3, 22);
    assert.equal(new Set(rows.map((r) => r.join(","))).size, 22);
    assert.throws(() => rowsOf(mm, ss, 3, 26), /más combinaciones/);
  }
}

// Codes with their check digits.
assert.equal(nif(12345678), "12345678Z");
assert.ok(validNif("X1234567L"));
assert.equal(nif(1234567, true), "X1234567L");
assert.ok(validCif(cif("B", "1234567")) && validCif(cif("P", "1234567")));
assert.equal(cif("A", "5881850"), "A58818501");
assert.ok(validIban("ES91 2100 0418 4502 0005 1332"));
assert.ok(!validIban("ES92 2100 0418 4502 0005 1332"));
assert.equal(iban("GB", "NWBK60161331926819"), "GB29NWBK60161331926819");
assert.equal(normName("FechaAlta"), "fecha_alta");
assert.equal(normName("Código Postal"), "codigo_postal");

// ---------------------------------------------------------------- outputs: insert, script and export say the same
{
  const gen = createGenerator(m, s, 77, "es");
  const rows: SheetCell[][] = Array.from({ length: 1001 }, () => gen.next());
  const statements = insertStatements(m, gen, rows);
  assert.equal(statements.length, 3, "batched like the import: 500 rows per INSERT");
  assert.ok(!statements[0].includes('"id"'), "the identity column is not written");
  assert.match(statements[0], /^INSERT INTO public\.celer_td_child \("codigo", "nombre", /);
  assert.match(statements[0], /decode\('[0-9A-F]+', 'hex'\)|NULL/, "bytes as PostgreSQL bytes");
  // The import pipeline itself writes the same.
  const mapping = m.columns.map((_, i) => (gen.written.includes(i) ? i : -1));
  assert.deepEqual(statements, importStatements(rows, { qualified: m.qualified, columns: m.columns.map((c) => c.col), quoted: m.columns.map((c) => c.quoted), mapping, emptyAsNull: false }, "postgres"));
  const script = scriptText(m, statements, { rows: 1001, seed: 77, locale: "es" });
  assert.ok(script.includes(statements[1]) && script.trimEnd().endsWith(";"));
  // The same seed again: the script of a new generator is the insert of the first.
  const again = createGenerator(m, s, 77, "es");
  assert.deepEqual(insertStatements(m, again, Array.from({ length: 1001 }, () => again.next())), statements);
  const csv = exportText(m, gen, rows.slice(0, 3), "csv").split("\n");
  assert.equal(csv[0], "codigo,nombre,apellidos,email,parent_id,estado,prioridad,puntos,alta,momento,importe,activo,notas,foto,nif,telefono,ciudad,cp");
  assert.equal(csv[1].split(",")[0], rows[0][at("codigo")]);
  const json = JSON.parse(exportText(m, gen, rows.slice(0, 2), "json")) as Record<string, unknown>[];
  assert.equal(json[0].codigo, rows[0][at("codigo")]);
  assert.equal(json[0].alta, (rows[0][at("alta")] as { d: string }).d);
  assert.equal(json[0].activo, rows[0][at("activo")]);
  // Per dialect: SQL Server batches 900, Informix one INSERT per row; booleans as each engine takes them.
  const mm = model("mssql");
  const gm = createGenerator(mm, inferSettings(mm), 1, "es");
  const rm = Array.from({ length: 901 }, () => gm.next());
  assert.equal(insertStatements(mm, gm, rm).length, 2);
  const mi = model("informix");
  const gi = createGenerator(mi, inferSettings(mi), 1, "es");
  const si = insertStatements(mi, gi, [gi.next(), gi.next()]);
  assert.equal(si.length, 1);
  assert.equal(si[0].split(";\n").length, 2);
  assert.match(si[0], /MDY\(\d+, \d+, \d{4}\)/, "Informix DATE");
  assert.match(si[0], /'[tf]'/, "Informix BOOLEAN");
  // Every column left to the server: DEFAULT VALUES.
  const auto = buildModel({ dialect: "postgres", qualified: "t", table: "t", columns: [col("id", "integer", "number", { nullable: false, identity: true })], quoted: ['"id"'], catalog: { uniques: [], checks: [], enums: {} }, fks: [] });
  const ga = createGenerator(auto, inferSettings(auto), 1);
  assert.deepEqual(insertStatements(auto, ga, [ga.next()]), ["INSERT INTO t DEFAULT VALUES"]);
}

// ---------------------------------------------------------------- speed: 100,000 rows in well under the time of their INSERTs
{
  const started = performance.now();
  const gen = createGenerator(m, s, 3, "es");
  const rows: SheetCell[][] = [];
  for (let i = 0; i < 100_000; i++) rows.push(gen.next());
  insertStatements(m, gen, rows);
  const ms = performance.now() - started;
  assert.ok(ms < 15_000, `100,000 rows took ${ms} ms`);
}

console.log("testdata-check: all good");
