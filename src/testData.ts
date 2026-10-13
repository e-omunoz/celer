// The test data generator (#172): rows of realistic, valid data for a table, from its columns and constraints.
// Each column gets a generator, inferred from its type and its name (Spanish and English), that the user may change;
// NOT NULL, lengths, precision, CHECK lists and ranges, native enums, unique keys and foreign keys (values taken
// from the referenced table) are respected. The same seed and settings always give the same rows: every column
// draws from its own stream, so changing one column's generator leaves the others as they were.
// The rows become the import's INSERT statements (importFormats.ts), a script, or CSV / JSON. Pure, so
// dev/testdata-check.ts tests it and dev/engine-sql.ts inserts its rows on every engine.
import { importStatements, type SheetCell } from "./importFormats.ts";
import { resultToText } from "./sql.ts";
import { LOCALES, LOREM, type Locale, type LocaleData, type Place } from "./testDataLocale.ts";
import { enumValues, readChecks, typeInfo, type CatalogFacts, type ColumnRule, type TypeInfo } from "./testDataSql.ts";
import type { Cell, ColKind, ColumnInfo, DbKind, ObjectRef, ResultSet, TableColumn } from "./types";

export type { Locale } from "./testDataLocale.ts";

/** Most rows one run generates. */
export const MAX_ROWS = 1_000_000;
/** Parent keys read for a foreign key (a sample when the parent is bigger). */
export const PARENT_SAMPLE = 50_000;
/** Existing values of a unique column read so new ones do not repeat them (only when the table is this small). */
export const EXISTING_SAMPLE = 50_000;

// ---------------------------------------------------------------- generators

export type GenKind =
  | "skip" | "null" | "constant" | "sequence" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "time" | "uuid" | "text"
  | "binary" | "json" | "firstName" | "lastName" | "fullName" | "email" | "phone" | "address" | "city" | "province" | "postalCode"
  | "country" | "company" | "product" | "nif" | "cif" | "iban" | "url" | "username" | "password" | "lorem" | "price" | "quantity"
  | "status" | "ip" | "list" | "pattern" | "expression" | "fk";

/** Every generator, as the dialog lists it (grouped). */
export const GENERATORS: { kind: GenKind; label: string; group: string }[] = [
  { kind: "skip", label: "No generar (lo pone el servidor)", group: "Especiales" },
  { kind: "null", label: "Siempre NULL", group: "Especiales" },
  { kind: "constant", label: "Constante", group: "Especiales" },
  { kind: "sequence", label: "Secuencia", group: "Especiales" },
  { kind: "list", label: "Lista de valores", group: "Especiales" },
  { kind: "pattern", label: "Patrón ([A-Z]{3}-\\d{4})", group: "Especiales" },
  { kind: "expression", label: "Expresión de otras columnas", group: "Especiales" },
  { kind: "fk", label: "Clave de la tabla referenciada", group: "Especiales" },
  { kind: "integer", label: "Entero", group: "Por tipo" },
  { kind: "decimal", label: "Decimal", group: "Por tipo" },
  { kind: "boolean", label: "Booleano", group: "Por tipo" },
  { kind: "date", label: "Fecha", group: "Por tipo" },
  { kind: "datetime", label: "Fecha y hora", group: "Por tipo" },
  { kind: "time", label: "Hora", group: "Por tipo" },
  { kind: "uuid", label: "UUID", group: "Por tipo" },
  { kind: "text", label: "Texto", group: "Por tipo" },
  { kind: "binary", label: "Binario (bytes aleatorios)", group: "Por tipo" },
  { kind: "json", label: "JSON", group: "Por tipo" },
  { kind: "firstName", label: "Nombre", group: "Personas" },
  { kind: "lastName", label: "Apellidos", group: "Personas" },
  { kind: "fullName", label: "Nombre completo", group: "Personas" },
  { kind: "email", label: "Correo electrónico", group: "Personas" },
  { kind: "phone", label: "Teléfono", group: "Personas" },
  { kind: "username", label: "Usuario", group: "Personas" },
  { kind: "password", label: "Contraseña (hash)", group: "Personas" },
  { kind: "nif", label: "NIF / DNI", group: "Personas" },
  { kind: "address", label: "Dirección", group: "Lugares" },
  { kind: "city", label: "Ciudad", group: "Lugares" },
  { kind: "province", label: "Provincia / estado", group: "Lugares" },
  { kind: "postalCode", label: "Código postal", group: "Lugares" },
  { kind: "country", label: "País", group: "Lugares" },
  { kind: "company", label: "Empresa", group: "Negocio" },
  { kind: "cif", label: "CIF", group: "Negocio" },
  { kind: "iban", label: "IBAN", group: "Negocio" },
  { kind: "product", label: "Producto", group: "Negocio" },
  { kind: "price", label: "Precio / importe", group: "Negocio" },
  { kind: "quantity", label: "Cantidad", group: "Negocio" },
  { kind: "status", label: "Estado", group: "Negocio" },
  { kind: "url", label: "URL", group: "Internet" },
  { kind: "ip", label: "Dirección IP", group: "Internet" },
  { kind: "lorem", label: "Descripción (lorem ipsum)", group: "Textos" },
];

export const generatorLabel = (kind: GenKind) => GENERATORS.find((g) => g.kind === kind)?.label ?? kind;

/** A column's generator and its parameters (text, as typed in the dialog). */
export interface GenSettings {
  kind: GenKind;
  /** Percentage of NULLs (nullable columns only). */
  nullPct: number;
  /** integer / decimal / date / datetime / time / price / quantity: range. */
  min: string;
  max: string;
  /** decimal: digits after the point. */
  scale: string;
  /** sequence. */
  start: string;
  step: string;
  /** constant. */
  value: string;
  /** list: one value per line, "valor *peso" for a weight. */
  values: string;
  /** pattern: [A-Z]{3}-\d{4}. */
  pattern: string;
  /** expression: text with {columna}, {columna|lower|upper|slug|initial} and {#} (row number). */
  template: string;
}

export const blankSettings = (kind: GenKind): GenSettings => ({ kind, nullPct: 0, min: "", max: "", scale: "", start: "", step: "", value: "", values: "", pattern: "", template: "" });

// ---------------------------------------------------------------- the table

export interface ParentKeys {
  /** Constraint name. */
  name: string;
  /** The columns of this table, in key order. */
  columns: string[];
  target: ObjectRef;
  targetColumns: string[];
  /** Keys read from the referenced table (a sample of PARENT_SAMPLE at most). */
  rows: Cell[][];
}

export interface TestColumn {
  /** The column, its kind made to agree with its type (ODBC names some types Celer reads only by name). */
  col: TableColumn;
  quoted: string;
  type: TypeInfo;
  /** A single-column unique key or index, or the primary key alone. */
  unique: boolean;
  /** Its foreign key (index in TableModel.fks) and position in it. */
  fk?: { key: number; part: number };
  /** Values allowed: a native enum, a CHECK … IN (…). */
  values?: string[];
  /** A CHECK range. */
  rule?: ColumnRule;
  /** A CHECK limits it in a way Celer does not read. */
  checkUnknown: boolean;
  /** The server fills it: identity, serial, computed, rowversion, a sequence default. */
  auto: boolean;
}

export interface TableModel {
  /** The SQL dialect the values are written in (an ODBC connection's engine, see effectiveDialect). */
  dialect: DbKind;
  qualified: string;
  /** The table's name, for messages. */
  table: string;
  columns: TestColumn[];
  /** Unique keys of several columns (column indexes). */
  uniqueSets: number[][];
  /** Rows already in the table (new unique text continues after them). */
  existing: number;
  /** Largest value of each column read (null: not read or empty). */
  maxima: (string | null)[];
  /** Values already in unique columns (column index → values), read when the table is small. */
  existingValues: Record<number, string[]>;
  fks: ParentKeys[];
}

export interface ModelInput {
  dialect: DbKind;
  qualified: string;
  table: string;
  columns: TableColumn[];
  quoted: string[];
  catalog: CatalogFacts;
  /** The statsSql row: COUNT(*), then MAX of each column of statsColumns(columns). */
  stats?: Cell[] | null;
  fks: ParentKeys[];
  /** Existing values of unique columns, by column name. */
  existingValues?: Record<string, Cell[]>;
}

const cellString = (cell: Cell | undefined): string | null => (cell === null || cell === undefined ? null : String(cell));

/** Whether the column is written by the server, never by the generator by default. */
function serverFilled(col: TableColumn): boolean {
  return col.identity || /^\s*nextval\(/i.test(col.default ?? "") || /\b(identity|serial|autoincrement|auto_increment|rowversion)\b/i.test(col.typeName);
}

/** The columns whose MAX statsSql reads: integer ones (unique ones continue after it). */
export function statsColumns(columns: TableColumn[], dialect: DbKind): number[] {
  return columns.map((col, i) => ({ col, i })).filter(({ col }) => typeInfo(col, dialect).family === "int").map(({ i }) => i);
}

const KIND_OF: Partial<Record<TypeInfo["family"], ColKind>> = { int: "number", decimal: "number", float: "number", year: "number", bool: "bool", date: "date", datetime: "date", time: "date", binary: "binary", text: "text", char: "text", uuid: "text", json: "text", xml: "text" };

/** The table as the generator sees it, from what the catalog said. */
export function buildModel(input: ModelInput): TableModel {
  const { dialect, catalog } = input;
  const names = input.columns.map((c) => c.name);
  const indexOf = (name: string) => names.findIndex((n) => n === name || n.toLowerCase() === name.toLowerCase());
  const checks = readChecks(catalog.checks.map((c) => c.text), names);
  const pk = input.columns.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0);
  const sets = catalog.uniques.map((cols) => cols.map(indexOf)).filter((set) => set.length && set.every((i) => i >= 0));
  if (pk.length && !sets.some((set) => set.length === pk.length && pk.every((i) => set.includes(i)))) sets.push(pk);
  const single = new Set(sets.filter((set) => set.length === 1).map((set) => set[0]));
  const multi = sets.filter((set) => set.length > 1);
  const columns: TestColumn[] = input.columns.map((col, i) => {
    const type = typeInfo(col, dialect);
    const listed = catalog.enums[col.name] ?? enumValues(col.typeName) ?? undefined;
    const rule = checks.rules[col.name];
    const values = rule?.values?.length ? (listed ? rule.values.filter((v) => listed.includes(v)) : rule.values) : listed;
    return {
      col: { ...col, kind: KIND_OF[type.family] ?? col.kind },
      quoted: input.quoted[i] ?? col.name,
      type,
      unique: single.has(i),
      values: values?.length ? values : undefined,
      rule: rule && (rule.min !== undefined || rule.max !== undefined) ? rule : undefined,
      checkUnknown: checks.unknown.includes(col.name),
      auto: serverFilled(col) || (catalog.auto ?? []).some((name) => name.toLowerCase() === col.name.toLowerCase()),
    };
  });
  input.fks.forEach((fk, key) => {
    fk.columns.forEach((name, part) => {
      const i = indexOf(name);
      if (i >= 0 && !columns[i].fk) columns[i].fk = { key, part };
    });
  });
  const statsCols = statsColumns(input.columns, dialect);
  const maxima: (string | null)[] = input.columns.map(() => null);
  statsCols.forEach((col, k) => {
    maxima[col] = cellString(input.stats?.[k + 1]);
  });
  const existingValues: Record<number, string[]> = {};
  for (const [name, values] of Object.entries(input.existingValues ?? {})) {
    const i = indexOf(name);
    if (i >= 0) existingValues[i] = values.map((v) => cellString(v)).filter((v): v is string => v !== null);
  }
  return {
    dialect,
    qualified: input.qualified,
    table: input.table,
    columns,
    uniqueSets: multi,
    existing: Number(input.stats?.[0] ?? 0) || 0,
    maxima,
    existingValues,
    fks: input.fks,
  };
}

/**
 * The unique columns whose existing values are read before generating (so new values do not repeat them): only
 * when the table already has rows, and not more than EXISTING_SAMPLE.
 */
export function existingToRead(model: TableModel): { name: string; quoted: string }[] {
  if (model.existing <= 0 || model.existing > EXISTING_SAMPLE) return [];
  return model.columns.filter((c) => c.unique && !c.auto && !c.type.noLiteral).map((c) => ({ name: c.col.name, quoted: c.quoted }));
}

// ---------------------------------------------------------------- inference

/** A column name in lower case without accents, camelCase split: "FechaAlta" → "fecha_alta". */
export function normName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const has = (name: string, words: string) => new RegExp(`(^|_)(${words})($|_|\\d)`).test(name);

const W = {
  email: "e_?mail|email_address|correo|correo_electronico|mail",
  firstName: "first_?name|given_?name|forename|nombre_pila|nombre_de_pila",
  lastName: "apellidos?|apellido_?[12]|primer_apellido|segundo_apellido|last_?name|surname|family_?name",
  fullName: "nombre_completo|nombre_y_apellidos|full_?name|display_?name|contacto|contact_?name|persona|responsable|titular|autor|author",
  name: "nombre|name",
  phone: "telefono|tel|tlf|telf|movil|phone|mobile|celular|fax",
  address: "direccion|domicilio|address|addr|calle|street|via",
  city: "ciudad|city|localidad|municipio|poblacion|town",
  province: "provincia|province|region|comunidad|county",
  state: "state",
  postal: "cp|codigo_postal|cod_postal|postal_?code|zip|zip_?code|postcode",
  country: "pais|country|nacionalidad|nationality",
  company: "empresa|company|razon_social|compania|organizacion|organization|organisation|proveedor|supplier|vendor|fabricante|manufacturer|cliente_nombre",
  nie: "nie",
  nif: "nif|dni|documento|doc_identidad|tax_?id|vat_?id|vat_?number",
  cif: "cif",
  iban: "iban|cuenta|ccc|account_?number|bank_?account",
  url: "url|web|website|sitio_web|pagina_web|homepage|link|enlace",
  username: "usuario|username|user_?name|login|alias|nick|nickname|user",
  password: "password|contrasena|passwd|pwd|pass_?hash|password_?hash|hash|clave_acceso",
  lorem: "descripcion|description|desc|notas?|notes?|comentarios?|comments?|observaciones?|obs|texto|text|detalles?|details?|resumen|summary|bio|biografia|mensaje|message|contenido|content|body|cuerpo|motivo|reason",
  title: "titulo|title|asunto|subject|encabezado|headline|nombre_corto|etiqueta|label",
  status: "estado|status|situacion|fase|stage",
  product: "producto|product|articulo|item|article|modelo|model",
  code: "codigo|code|sku|ref|referencia|reference|matricula|serie|serial_?number|lote|batch",
  ip: "ip|ip_?address|direccion_ip",
  uuid: "uuid|guid",
  color: "color|colour",
  gender: "sexo|genero|gender",
  price: "precio|price|importe|amount|total|subtotal|coste|costo|cost|pvp|salario|salary|sueldo|saldo|balance|tarifa|fee|pago|payment|base_imponible|neto|bruto",
  quantity: "cantidad|quantity|qty|unidades|units|stock|existencias|numero_de|num_\\w+|count|piezas|bultos",
  age: "edad|age",
  percent: "porcentaje|percent|percentage|pct|descuento|discount|tasa|rate|iva|comision|commission",
  lat: "lat|latitud|latitude",
  lon: "lon|lng|long|longitud|longitude",
  year: "anio|ano|year|ejercicio",
  rating: "puntuacion|rating|score|valoracion|estrellas|stars|nota",
  flag: "activo|activa|active|enabled|habilitado|habilitada|visible|borrado|deleted|eliminado|baja|flag|is_\\w+|es_\\w+|has_\\w+|tiene_\\w+",
  birth: "nacimiento|fecha_nac|f_nac|birth|birthday|dob|cumpleanos|birth_?date",
  dated: "fecha|date|created|creado|creacion|updated|actualizado|modified|modificado|\\w+_at|\\w+_on|timestamp|vencimiento|due",
};

const LIST_COLORS: Record<Locale, string> = { es: "rojo\nazul\nverde\namarillo\nnegro\nblanco\ngris\nnaranja", en: "red\nblue\ngreen\nyellow\nblack\nwhite\ngray\norange" };
const LIST_GENDER: Record<Locale, string> = { es: "H\nM", en: "M\nF" };

function withRange(s: GenSettings, min: string, max: string): GenSettings {
  s.min = min;
  s.max = max;
  return s;
}

/** Clamps a range to what the column allows (its type, its CHECK). */
function fitRange(c: TestColumn, min: number, max: number): [number, number] {
  // A CHECK with both bounds is the range itself.
  const bounded = c.rule?.min !== undefined && c.rule?.max !== undefined;
  let lo = bounded ? -Infinity : min;
  let hi = bounded ? Infinity : max;
  if (c.type.min !== undefined) lo = Math.max(lo, Number(c.type.min));
  if (c.type.max !== undefined) hi = Math.min(hi, Number(c.type.max));
  if (c.type.family === "decimal" && c.type.precision !== undefined) {
    const limit = 10 ** ((c.type.precision ?? 12) - (c.type.scale ?? 0)) - 10 ** -(c.type.scale ?? 0);
    lo = Math.max(lo, -limit);
    hi = Math.min(hi, limit);
  }
  const step = c.type.family === "int" || c.type.family === "year" ? 1 : 10 ** -(c.type.scale ?? 2);
  if (c.rule?.min !== undefined) lo = Math.max(lo, c.rule.min + (c.rule.minOpen ? step : 0));
  if (c.rule?.max !== undefined) hi = Math.min(hi, c.rule.max - (c.rule.maxOpen ? step : 0));
  if (lo > hi) {
    // The default range falls outside what the column allows: the allowed range instead.
    lo = c.rule?.min !== undefined ? c.rule.min + (c.rule.minOpen ? step : 0) : c.type.min !== undefined ? Number(c.type.min) : hi;
    hi = c.rule?.max !== undefined ? c.rule.max - (c.rule.maxOpen ? step : 0) : Math.max(lo, hi);
  }
  return [lo, hi];
}

const numText = (n: number, scale = 0) => (scale > 0 ? n.toFixed(scale) : String(Math.round(n)));

/** The generator Celer proposes for one column. */
export function inferOne(model: TableModel, index: number, locale: Locale = "es"): GenSettings {
  const c = model.columns[index];
  const name = normName(c.col.name);
  const fam = c.type.family;
  const nullable = c.col.nullable;
  const keyish = c.unique || c.col.primaryKey || model.uniqueSets.some((set) => set.includes(index));
  const s = blankSettings("text");
  // Some NULLs in optional columns, none in keys.
  s.nullPct = nullable && !keyish && !c.fk ? 10 : 0;
  if (c.auto) return { ...s, kind: "skip", nullPct: 0 };
  if (c.type.noLiteral) return { ...s, kind: nullable || c.col.default ? (nullable ? "null" : "skip") : "null", nullPct: 0 };
  if (c.fk) return { ...s, kind: "fk", nullPct: nullable ? 10 : 0 };
  if (c.values?.length) return { ...s, kind: "list", values: c.values.join("\n") };
  const all = model.columns.map((col) => normName(col.col.name));
  const tableName = normName(model.table);
  const scale = c.type.scale ?? 2;
  switch (fam) {
    case "bool":
      return { ...s, kind: "boolean" };
    case "uuid":
      return { ...s, kind: "uuid" };
    case "json":
      return { ...s, kind: "json" };
    case "xml":
      return { ...s, kind: "pattern", pattern: "<item id=\"\\d{4}\">[a-z]{6}</item>" };
    case "binary":
      return { ...s, kind: "binary" };
    case "interval":
      return { ...s, kind: "constant", value: model.dialect === "postgres" ? "1 day" : "1" };
    case "date":
    case "datetime": {
      const birth = has(name, W.birth);
      const kind = fam === "date" ? "date" : "datetime";
      return withRange({ ...s, kind }, birth ? "1950-01-01" : "2020-01-01", birth ? "2005-12-31" : "2025-12-31");
    }
    case "time":
      return withRange({ ...s, kind: "time" }, "08:00:00", "20:00:00");
    case "year": {
      const [lo, hi] = fitRange(c, 1990, 2030);
      return withRange({ ...s, kind: "integer" }, numText(lo), numText(hi));
    }
    case "int": {
      if (keyish && model.uniqueSets.every((set) => !set.includes(index))) {
        const after = model.maxima[index];
        const start = after !== null && /^-?\d+$/.test(after) ? (BigInt(after) + 1n).toString() : String(Math.max(1, model.existing + 1));
        return { ...s, kind: "sequence", start, step: "1" };
      }
      const range = (lo: number, hi: number) => {
        const [a, b] = fitRange(c, lo, hi);
        return withRange({ ...s, kind: "integer" }, numText(a), numText(b));
      };
      if (has(name, W.phone)) return range(600000000, 799999999);
      if (has(name, W.age)) return range(18, 90);
      if (has(name, W.year)) return range(1990, 2030);
      if (has(name, W.percent)) return range(0, 100);
      if (has(name, W.rating)) return range(1, 5);
      if (has(name, W.price)) return { ...range(1, 1000), kind: c.rule ? "integer" : "price" };
      if (has(name, W.quantity)) return { ...range(1, 100), kind: c.rule ? "integer" : "quantity" };
      if (has(name, W.flag) || (c.type.max !== undefined && Number(c.type.max) <= 1)) return range(0, 1);
      return range(1, 1000);
    }
    case "decimal":
    case "float": {
      const range = (lo: number, hi: number, digits = scale, kind: GenKind = "decimal") => {
        const [a, b] = fitRange(c, lo, hi);
        return { ...withRange({ ...s, kind }, numText(a, digits), numText(b, digits)), scale: String(digits) };
      };
      if (has(name, W.lat)) return range(36, 43.5, Math.min(6, scale || 6));
      if (has(name, W.lon)) return range(-9, 3.3, Math.min(6, scale || 6));
      if (has(name, W.percent)) return range(0, 100);
      if (has(name, W.rating)) return range(0, 10, Math.min(scale, 1));
      if (has(name, W.quantity)) return range(1, 100);
      if (has(name, W.price)) return range(1, 1000, scale, c.rule ? "decimal" : "price");
      return range(0, 1000);
    }
    case "text":
    case "char": {
      const len = c.type.maxLength ?? Infinity;
      if (fam === "char" && len <= 3) {
        // A short fixed code: a country (ES / ESP), a sex, a status letter, or letters.
        if (has(name, W.country)) return { ...s, kind: "country" };
        if (has(name, W.status)) return { ...s, kind: "status" };
        return { ...s, kind: "pattern", pattern: len === 1 && has(name, W.gender) ? (locale === "es" ? "[HM]" : "[MF]") : `[A-Z]{${len}}` };
      }
      if (has(name, W.email)) {
        const first = all.find((n) => has(n, W.firstName) || n === "nombre" || n === "name");
        const last = all.find((n) => has(n, W.lastName));
        const full = all.find((n) => has(n, W.fullName));
        const ref = (n: string) => model.columns[all.indexOf(n)].col.name;
        // From the name columns of the same row when there are some: "ana.garcia@…".
        if (first && last) return { ...s, kind: "expression", template: `{${ref(first)}|slug}.{${ref(last)}|slug}${keyish ? "{#}" : ""}@${LOCALES[locale].domains[0]}` };
        if (full) return { ...s, kind: "expression", template: `{${ref(full)}|slug}${keyish ? "{#}" : ""}@${LOCALES[locale].domains[0]}` };
        return { ...s, kind: "email" };
      }
      if (has(name, W.firstName)) return { ...s, kind: "firstName" };
      if (has(name, W.lastName)) return { ...s, kind: "lastName" };
      if (has(name, W.fullName)) return { ...s, kind: "fullName" };
      if (has(name, W.uuid) && len >= 36) return { ...s, kind: "uuid" };
      if (has(name, W.ip)) return { ...s, kind: "ip" };
      if (has(name, W.phone)) return { ...s, kind: "phone" };
      if (has(name, W.postal)) return { ...s, kind: "postalCode" };
      if (has(name, W.city)) return { ...s, kind: "city" };
      if (has(name, W.province)) return { ...s, kind: "province" };
      if (has(name, W.state)) return { ...s, kind: all.some((n) => has(n, W.city) || has(n, W.address)) ? "province" : "status" };
      if (has(name, W.country)) return { ...s, kind: "country" };
      if (has(name, W.address)) return { ...s, kind: "address" };
      if (has(name, W.cif)) return { ...s, kind: "cif" };
      if (has(name, W.nie) || has(name, W.nif)) return { ...s, kind: "nif" };
      if (has(name, W.iban)) return { ...s, kind: "iban" };
      if (has(name, W.url)) return { ...s, kind: "url" };
      if (has(name, W.password)) return { ...s, kind: "password" };
      if (has(name, W.username)) return { ...s, kind: "username" };
      if (has(name, W.company)) return { ...s, kind: "company" };
      if (has(name, W.product)) return { ...s, kind: "product" };
      if (has(name, W.status)) return { ...s, kind: "status" };
      if (has(name, W.color)) return { ...s, kind: "list", values: LIST_COLORS[locale] };
      if (has(name, W.gender)) return { ...s, kind: "list", values: LIST_GENDER[locale] };
      if (has(name, W.code)) return { ...s, kind: "pattern", pattern: len >= 8 ? "[A-Z]{3}-\\d{4}" : `[A-Z0-9]{${Math.min(len, 6)}}` };
      // A date kept as text (SQLite, old schemas): a date all the same.
      if (len >= 10 && (has(name, W.birth) || has(name, W.dated))) {
        const birth = has(name, W.birth);
        return withRange({ ...s, kind: "date" }, birth ? "1950-01-01" : "2020-01-01", birth ? "2005-12-31" : "2025-12-31");
      }
      if (has(name, W.lorem) || has(name, W.title)) return { ...s, kind: "lorem" };
      if (has(name, W.name)) {
        if (all.some((n) => has(n, W.lastName))) return { ...s, kind: "firstName" };
        if (/(^|_)(producto|productos|product|products|articulo|articulos|item|items|catalogo|catalog)($|_)/.test(tableName)) return { ...s, kind: "product" };
        if (/(^|_)(empresa|empresas|company|companies|proveedor|proveedores|supplier|suppliers|fabricante|organizacion|cliente_empresa)($|_)/.test(tableName)) return { ...s, kind: "company" };
        return { ...s, kind: "fullName" };
      }
      return { ...s, kind: "text" };
    }
    default:
      if (/^inet|^cidr/i.test(c.col.typeName)) return { ...s, kind: "ip" };
      return { ...s, kind: nullable ? "null" : "text", nullPct: 0 };
  }
}

/** The generators Celer proposes for every column. */
export function inferSettings(model: TableModel, locale: Locale = "es"): GenSettings[] {
  return model.columns.map((_, i) => inferOne(model, i, locale));
}

// ---------------------------------------------------------------- random numbers

/** FNV-1a hash of a text (32 bits). */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small, fast, seedable generator (sfc32, seeded through splitmix32). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    let s = seed >>> 0;
    const mix = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    for (let i = 0; i < 12; i++) this.u32();
  }
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }
  /** An integer in [min, max] (both safe integers). */
  int(min: number, max: number): number {
    if (max <= min) return min;
    const span = max - min + 1;
    if (span <= 4294967296) return min + Math.floor(this.next() * span);
    return min + Math.floor((this.u32() * 4294967296 + this.u32()) % span);
  }
  /** An integer in [min, max], however big. */
  big(min: bigint, max: bigint): bigint {
    if (max <= min) return min;
    const span = max - min + 1n;
    let r = 0n;
    for (let bits = 0n; 1n << bits < span * 1024n; bits += 32n) r = (r << 32n) | BigInt(this.u32());
    return min + (r % span);
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** The stream of one part of the data (a column, a row's person…) for a seed. */
export const stream = (seed: number, label: string) => new Rng(hash32(`${seed >>> 0}:${label}`));

/** A new random seed (shown and editable in the dialog). */
export const randomSeed = () => 1 + Math.floor(Math.random() * 2_147_483_646);

// ---------------------------------------------------------------- text helpers

/** Text for an address or user name: lower case, no accents, words joined by ".". */
export function slug(text: string, joiner = "."): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, joiner)
    .replace(new RegExp(`^\\${joiner}+|\\${joiner}+$`, "g"), "");
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Text cut to what the column holds (characters, or bytes on Informix). */
export function fitText(text: string, type: TypeInfo): string {
  const max = type.maxLength;
  if (max === undefined || text.length === 0) return text;
  if (!type.bytes) return text.length > max ? text.slice(0, max).trimEnd() || text.slice(0, max) : text;
  if (utf8Length(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (utf8Length(out + ch) > max) break;
    out += ch;
  }
  return out.trimEnd() || out;
}

/** `base` + `suffix` within the column's length: the base is cut, the suffix (what makes it unique) kept. */
function fitWithSuffix(base: string, suffix: string, type: TypeInfo): string {
  const max = type.maxLength;
  if (max === undefined) return base + suffix;
  const room = max - (type.bytes ? utf8Length(suffix) : suffix.length);
  if (room <= 0) return fitText(suffix, type);
  return fitText(base, { ...type, maxLength: room }) + suffix;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- patterns

type PatNode = { k: "lit"; text: string } | { k: "set"; chars: string } | { k: "alt"; options: PatNode[][] } | { k: "rep"; node: PatNode; min: number; max: number };

const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const CLASSES: Record<string, string> = { d: DIGITS, w: UPPER + LOWER + DIGITS + "_", s: " ", l: LOWER, u: UPPER, a: UPPER + LOWER, x: "0123456789abcdef" };

/**
 * A regex-like pattern for codes: literals, [A-Z0-9] classes, \d \w \l (lower case) \u (upper case) \a (letter) \x
 * (hex), "." (letter or digit), groups with | alternatives and {n} {n,m} ? + * quantifiers.
 */
export function parsePattern(src: string): PatNode[] {
  let i = 0;
  const seq = (inGroup: boolean): PatNode[][] => {
    const options: PatNode[][] = [[]];
    while (i < src.length) {
      const c = src[i];
      if (c === ")" && inGroup) break;
      if (c === "|") {
        i++;
        options.push([]);
        continue;
      }
      let node: PatNode;
      if (c === "(") {
        i++;
        const inner = seq(true);
        if (src[i] !== ")") throw new Error("Falta cerrar un paréntesis en el patrón");
        i++;
        node = { k: "alt", options: inner };
      } else if (c === "[") {
        const end = src.indexOf("]", i + 2);
        if (end < 0) throw new Error("Falta cerrar un corchete en el patrón");
        let body = src.slice(i + 1, end);
        const negate = body.startsWith("^");
        if (negate) body = body.slice(1);
        let chars = "";
        for (let j = 0; j < body.length; j++) {
          if (body[j] === "\\" && j + 1 < body.length) {
            chars += CLASSES[body[j + 1]] ?? body[j + 1];
            j++;
          } else if (body[j + 1] === "-" && j + 2 < body.length) {
            const from = body.charCodeAt(j);
            const to = body.charCodeAt(j + 2);
            if (to < from) throw new Error(`Rango al revés en el patrón: ${body.slice(j, j + 3)}`);
            for (let code = from; code <= to; code++) chars += String.fromCharCode(code);
            j += 2;
          } else chars += body[j];
        }
        if (negate) chars = [...(UPPER + LOWER + DIGITS)].filter((ch) => !chars.includes(ch)).join("");
        if (!chars) throw new Error("Una clase [] vacía en el patrón");
        node = { k: "set", chars };
        i = end + 1;
      } else if (c === "\\") {
        const next = src[i + 1] ?? "\\";
        node = CLASSES[next] ? { k: "set", chars: CLASSES[next] } : { k: "lit", text: next };
        i += 2;
      } else if (c === ".") {
        node = { k: "set", chars: UPPER + DIGITS };
        i++;
      } else {
        node = { k: "lit", text: c };
        i++;
      }
      // Quantifier.
      const q = /^\{(\d+)(?:,(\d*))?\}|^[?+*]/.exec(src.slice(i));
      if (q) {
        i += q[0].length;
        if (q[0] === "?") node = { k: "rep", node, min: 0, max: 1 };
        else if (q[0] === "+") node = { k: "rep", node, min: 1, max: 4 };
        else if (q[0] === "*") node = { k: "rep", node, min: 0, max: 4 };
        else {
          const min = Number(q[1]);
          const max = q[2] === undefined ? min : q[2] === "" ? min + 4 : Number(q[2]);
          if (max < min || max > 1000) throw new Error(`Repetición no válida en el patrón: ${q[0]}`);
          node = { k: "rep", node, min, max };
        }
      }
      options[options.length - 1].push(node);
    }
    return options;
  };
  const top = seq(false);
  if (i < src.length) throw new Error("Hay un paréntesis de cierre de más en el patrón");
  return top.length === 1 ? top[0] : [{ k: "alt", options: top }];
}

function runPattern(nodes: PatNode[], rng: Rng): string {
  let out = "";
  const one = (node: PatNode) => {
    if (node.k === "lit") out += node.text;
    else if (node.k === "set") out += node.chars[Math.floor(rng.next() * node.chars.length)];
    else if (node.k === "alt") for (const n of rng.pick(node.options)) one(n);
    else for (let n = rng.int(node.min, node.max); n > 0; n--) one(node.node);
  };
  for (const node of nodes) one(node);
  return out;
}

/** How many different values a pattern can give (Infinity past 1e15). */
export function patternVariety(nodes: PatNode[]): number {
  const of = (node: PatNode): number => {
    if (node.k === "lit") return 1;
    if (node.k === "set") return new Set(node.chars).size;
    if (node.k === "alt") return node.options.reduce((sum, opt) => sum + opt.reduce((p, n) => p * of(n), 1), 0);
    let total = 0;
    for (let n = node.min; n <= node.max; n++) total += of(node.node) ** n;
    return total;
  };
  const v = nodes.reduce((p, n) => p * of(n), 1);
  return v > 1e15 ? Infinity : v;
}

// ---------------------------------------------------------------- Spanish codes

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** A DNI / NIF (8 digits and its check letter), or a NIE (X/Y/Z, 7 digits and the letter). */
export function nif(n: number, nie = false): string {
  if (nie) {
    const prefix = Math.floor(n / 10_000_000) % 3;
    const body = String(n % 10_000_000).padStart(7, "0");
    return `${"XYZ"[prefix]}${body}${NIF_LETTERS[(prefix * 10_000_000 + Number(body)) % 23]}`;
  }
  const body = n % 100_000_000;
  return `${String(body).padStart(8, "0")}${NIF_LETTERS[body % 23]}`;
}

/** Whether a NIF / NIE has its right check letter. */
export function validNif(value: string): boolean {
  const m = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(value);
  if (!m) return false;
  const n = Number(("XYZ".indexOf(m[1]) >= 0 && m[1] ? String("XYZ".indexOf(m[1])) : "") + m[2]);
  return NIF_LETTERS[n % 23] === m[3];
}

/** The control number (0-9) of a CIF's 7 digits. */
function cifControl(digits: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(digits[i]);
    if (i % 2 === 1) sum += d;
    else sum += Math.floor((d * 2) / 10) + ((d * 2) % 10);
  }
  return (10 - (sum % 10)) % 10;
}

/** A CIF: organisation letter, 7 digits and its control (a letter for P Q R S N W, else a digit). */
export function cif(letter: string, digits: string): string {
  const control = cifControl(digits);
  return `${letter}${digits}${"PQRSNW".includes(letter) ? "JABCDEFGHI"[control] : String(control)}`;
}

/** Whether a CIF's control is right (A B E H need a digit, P Q R S N W a letter, the others take either). */
export function validCif(value: string): boolean {
  const m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(value);
  if (!m) return false;
  const control = cifControl(m[2]);
  const digit = String(control);
  const letter = "JABCDEFGHI"[control];
  if ("PQRSNW".includes(m[1])) return m[3] === letter;
  if ("ABEH".includes(m[1])) return m[3] === digit;
  return m[3] === digit || m[3] === letter;
}

/** The remainder of a long number written as text, modulo 97 (IBAN check). */
function mod97(digits: string): number {
  let r = 0;
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
  return r;
}

const letterDigits = (text: string) => [...text].map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch)).join("");

/** An IBAN for a country and its BBAN (the account in the country's own format), with its check digits. */
export function iban(country: string, bban: string): string {
  const check = 98 - mod97(letterDigits(bban + country + "00"));
  return `${country}${String(check).padStart(2, "0")}${bban}`;
}

/** Whether an IBAN's check digits are right (spaces allowed). */
export function validIban(value: string): boolean {
  const s = value.replace(/\s+/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s)) return false;
  return mod97(letterDigits(s.slice(4) + s.slice(0, 4))) === 1;
}

/** The two control digits of a Spanish account (CCC): bank+branch, then the account number. */
function cccControl(bank: string, branch: string, account: string): string {
  const weights = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
  const digit = (ten: string) => {
    const d = 11 - (weights.reduce((sum, w, i) => sum + w * Number(ten[i]), 0) % 11);
    return d === 11 ? 0 : d === 10 ? 1 : d;
  };
  return `${digit(`00${bank}${branch}`)}${digit(account)}`;
}

// ---------------------------------------------------------------- the generator

export class TestDataError extends Error {
  /** The column it is about (index), when there is one. */
  column: number;
  constructor(message: string, column = -1) {
    super(message);
    this.column = column;
  }
}

interface Person {
  first: string;
  last1: string;
  last2: string;
  female: boolean;
}

interface RowCtx {
  /** The column's own stream. */
  rng: Rng;
  /** 1-based number of the row among the table's rows (existing ones first). */
  rowNo: number;
  /** 0-based index of the row in this run. */
  index: number;
  /** Retry number for this value (unique columns); from 3 on, a generator adds the row number. */
  attempt: number;
  row: SheetCell[];
  person(): Person;
  place(): Place;
  company(): string;
}

type ValueFn = (ctx: RowCtx) => SheetCell;

const pad2 = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;

function parseDate(text: string, what: string, column: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  if (!m) throw new TestDataError(`${what}: «${text}» no es una fecha (aaaa-mm-dd)`, column);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

function parseTime(text: string, what: string, column: number): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) throw new TestDataError(`${what}: «${text}» no es una hora (hh:mm:ss)`, column);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

function parseNumber(text: string, what: string, column: number): number {
  const t = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new TestDataError(`${what}: «${text}» no es un número`, column);
  return Number(t);
}

function parseBig(text: string, what: string, column: number): bigint {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) throw new TestDataError(`${what}: «${text}» no es un número entero`, column);
  return BigInt(t);
}

/** A list's values and weights ("valor *peso", one per line). */
export function parseList(text: string): { value: string; weight: number }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const m = /^(.*?)\s+\*(\d+(?:[.,]\d+)?)$/.exec(line);
      return m ? { value: m[1], weight: Number(m[2].replace(",", ".")) } : { value: line, weight: 1 };
    });
}

/** The {column} references of an expression. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(/\{([^{}|#]+)(?:\|[^{}]*)?\}/g)].map((m) => m[1].trim());
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const bigCell = (n: bigint): SheetCell => (n <= SAFE && n >= -SAFE ? Number(n) : n.toString());

/** The date/time text a column takes: SQL Server's DATETIME reads "aaaa-mm-dd hh:mm:ss" by language, "T" never. */
function dateTimeText(ms: number, dialect: DbKind, typeName: string): string {
  const iso = new Date(ms).toISOString();
  const sep = dialect === "mssql" && /^(datetime|smalldatetime)\b/i.test(typeName.trim()) ? "T" : " ";
  return `${iso.slice(0, 10)}${sep}${iso.slice(11, 19)}`;
}

/** Compiles one column's generator: throws TestDataError when its settings cannot work. */
function compile(model: TableModel, index: number, s: GenSettings, locale: Locale): ValueFn | null {
  const c = model.columns[index];
  const t = c.type;
  const L: LocaleData = LOCALES[locale];
  const col = c.col.name;
  const fit = (text: string) => fitText(text, t);
  const unique = (ctx: RowCtx) => ctx.attempt >= 3;
  const withNo = (ctx: RowCtx, base: string, sep = "") => (unique(ctx) ? fitWithSuffix(base, `${sep}${ctx.rowNo}`, t) : fit(base));
  const range = <T,>(lo: string, hi: string, parse: (text: string, what: string, column: number) => T, defLo: string, defHi: string): [T, T] => {
    const a = parse(lo.trim() || defLo, `«${col}», desde`, index);
    const b = parse(hi.trim() || defHi, `«${col}», hasta`, index);
    if (b < a) throw new TestDataError(`«${col}»: el final del rango es menor que el principio`, index);
    return [a, b];
  };
  const fullName = (p: Person) => (locale === "es" ? `${p.first} ${p.last1} ${p.last2}` : `${p.first} ${p.last1}`);
  const personOf = (ctx: RowCtx) => (ctx.attempt === 0 ? ctx.person() : newPerson(ctx.rng, L));
  const placeOf = (ctx: RowCtx) => (ctx.attempt === 0 ? ctx.place() : ctx.rng.pick(L.places));
  switch (s.kind) {
    case "skip":
      return null;
    case "null":
      return () => null;
    case "constant": {
      const value = s.value;
      if (t.family === "bool") return () => /^(1|true|t|s|si|sí|y|yes|verdadero)$/i.test(value.trim());
      return () => fit(value);
    }
    case "sequence": {
      const start = parseBig(s.start || "1", `«${col}», empieza en`, index);
      const step = parseBig(s.step || "1", `«${col}», incremento`, index);
      if (step === 0n) throw new TestDataError(`«${col}»: el incremento de la secuencia no puede ser 0`, index);
      if (t.family === "int" || t.family === "year" || t.family === "decimal" || t.family === "float") return (ctx) => bigCell(start + step * BigInt(ctx.index));
      return (ctx) => fit(String(start + step * BigInt(ctx.index)));
    }
    case "integer":
    case "quantity": {
      const [lo, hi] = range(s.min, s.max, parseBig, s.kind === "quantity" ? "1" : "0", s.kind === "quantity" ? "100" : "1000");
      if (t.min !== undefined && lo < BigInt(t.min)) throw new TestDataError(`«${col}»: ${lo} no cabe en ${c.col.typeName}`, index);
      if (t.max !== undefined && hi > BigInt(t.max)) throw new TestDataError(`«${col}»: ${hi} no cabe en ${c.col.typeName}`, index);
      const asText = t.family === "text" || t.family === "char";
      if (s.kind === "quantity") {
        // Small amounts are more common: a skew towards the start of the range.
        const a = Number(lo);
        const b = Number(hi);
        return (ctx) => {
          const v = a + Math.floor((b - a + 1) * ctx.rng.next() ** 2);
          return asText ? fit(String(v)) : v;
        };
      }
      return (ctx) => {
        const v = ctx.rng.big(lo, hi);
        return asText ? fit(v.toString()) : bigCell(v);
      };
    }
    case "decimal":
    case "price": {
      const scale = s.scale.trim() ? Math.max(0, Math.min(10, Math.floor(parseNumber(s.scale, `«${col}», decimales`, index)))) : t.scale ?? 2;
      const [lo, hi] = range(s.min, s.max, parseNumber, s.kind === "price" ? "1" : "0", s.kind === "price" ? "1000" : "1000");
      if (t.family === "decimal" && t.precision !== undefined) {
        const limit = 10 ** (t.precision - (t.scale ?? 0));
        if (Math.abs(lo) >= limit || Math.abs(hi) >= limit) throw new TestDataError(`«${col}»: el rango no cabe en ${c.col.typeName}`, index);
      }
      const digits = t.family === "int" || t.family === "year" ? 0 : Math.min(scale, t.family === "decimal" ? t.scale ?? scale : scale);
      if (s.kind === "price" && lo > 0) {
        // Prices spread evenly on a logarithmic scale: as many of 1-10 as of 100-1000.
        const a = Math.log(lo);
        const b = Math.log(hi);
        return (ctx) => Math.min(hi, Math.max(lo, Math.exp(a + (b - a) * ctx.rng.next()))).toFixed(digits);
      }
      const unit = 10 ** digits;
      const a = Math.ceil(lo * unit);
      const b = Math.floor(hi * unit);
      return (ctx) => (ctx.rng.int(a, b) / unit).toFixed(digits);
    }
    case "boolean":
      if (t.family === "int" || t.family === "decimal") return (ctx) => (ctx.rng.chance(0.5) ? 1 : 0);
      if (t.family === "text" || t.family === "char") return (ctx) => fit(ctx.rng.chance(0.5) ? (locale === "es" ? "S" : "Y") : "N");
      return (ctx) => ctx.rng.chance(0.5);
    case "date":
    case "datetime": {
      const [lo, hi] = range(s.min, s.max, parseDate, "2020-01-01", "2025-12-31");
      if (s.kind === "date" || t.family === "date") {
        const a = Math.floor(lo / DAY);
        const b = Math.floor(hi / DAY);
        // A date into a date-time column: at midnight (Informix wants every field of its qualifier).
        const tail = t.family === "datetime" ? (model.dialect === "mssql" && /^(datetime|smalldatetime)\b/i.test(c.col.typeName.trim()) ? "T00:00:00" : " 00:00:00") : "";
        return (ctx) => ({ d: new Date(ctx.rng.int(a, b) * DAY).toISOString().slice(0, 10) + tail });
      }
      const top = s.max.trim() && /\d{2}:\d{2}/.test(s.max) ? hi : hi + DAY - 1000;
      return (ctx) => ({ d: dateTimeText(lo + ctx.rng.int(0, Math.floor((top - lo) / 1000)) * 1000, model.dialect, c.col.typeName) });
    }
    case "time": {
      const [lo, hi] = range(s.min, s.max, parseTime, "00:00:00", "23:59:59");
      return (ctx) => {
        const v = ctx.rng.int(lo, hi);
        return { t: `${pad2(Math.floor(v / 3600))}:${pad2(Math.floor(v / 60) % 60)}:${pad2(v % 60)}` };
      };
    }
    case "uuid":
      return (ctx) => {
        const hex = Array.from({ length: 4 }, () => ctx.rng.u32().toString(16).padStart(8, "0")).join("");
        const v = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[ctx.rng.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        return fit(t.family === "binary" ? `0x${v.replace(/-/g, "").toUpperCase()}` : v);
      };
    case "binary": {
      const fixed = t.fixed && t.maxLength ? t.maxLength : 0;
      const max = Math.max(1, Math.min(t.maxLength ?? 16, 16));
      return (ctx) => {
        const n = fixed || ctx.rng.int(Math.min(4, max), max);
        let hex = "";
        for (let i = 0; i < n; i++) hex += ctx.rng.int(0, 255).toString(16).padStart(2, "0");
        return `0x${hex.toUpperCase()}`;
      };
    }
    case "json":
      return (ctx) => fit(JSON.stringify({ id: ctx.rowNo, codigo: runPattern(parsePattern("[A-Z]{3}\\d{3}"), ctx.rng), activo: ctx.rng.chance(0.7), puntos: ctx.rng.int(0, 100) }));
    case "firstName":
      return (ctx) => withNo(ctx, personOf(ctx).first, " ");
    case "lastName":
      return (ctx) => {
        const p = personOf(ctx);
        // "apellido1" / "apellido2" columns: one surname each; "apellidos": both (Spanish).
        const n = normName(col);
        const value = /2|segundo/.test(n) ? p.last2 : /1|primer/.test(n) || locale === "en" || !/apellidos/.test(n) ? p.last1 : `${p.last1} ${p.last2}`;
        return withNo(ctx, value, " ");
      };
    case "fullName":
      return (ctx) => withNo(ctx, fullName(personOf(ctx)), " ");
    case "email":
      return (ctx) => {
        const p = personOf(ctx);
        const local = `${slug(p.first)}.${slug(p.last1)}`;
        const extra = unique(ctx) ? String(ctx.rowNo) : ctx.rng.chance(0.3) ? String(ctx.rng.int(1, 99)) : "";
        const domain = ctx.rng.pick(L.domains);
        return fitWithSuffix(local, `${extra}@${domain}`, t);
      };
    case "username":
      return (ctx) => {
        const p = personOf(ctx);
        const base = `${slug(p.first, "")}${ctx.rng.pick([".", "_", ""])}${slug(p.last1, "")}`;
        const extra = unique(ctx) ? String(ctx.rowNo) : ctx.rng.chance(0.4) ? String(ctx.rng.int(1, 999)) : "";
        return fitWithSuffix(base, extra, t);
      };
    case "password":
      return (ctx) => {
        const max = t.maxLength ?? 60;
        if (max >= 60) {
          const chars = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
          let body = "";
          for (let i = 0; i < 53; i++) body += chars[ctx.rng.int(0, chars.length - 1)];
          return `$2b$10$${body}`;
        }
        let hex = "";
        for (let i = 0; i < Math.min(max, 64); i++) hex += "0123456789abcdef"[ctx.rng.int(0, 15)];
        return hex;
      };
    case "phone":
      if (t.family === "int" || t.family === "decimal") return (ctx) => ctx.rng.int(600000000, 799999999);
      return (ctx) => {
        const max = t.maxLength ?? 20;
        if (locale === "en") {
          const area = ctx.rng.int(201, 989);
          const line = String(ctx.rng.int(0, 9999)).padStart(4, "0");
          if (max >= 17) return `+1 (${area}) 555-${line}`;
          if (max >= 12) return `${area}-555-${line}`;
          return fit(`${area}555${line}`);
        }
        const digits = `${ctx.rng.pick(["6", "6", "6", "7", "9"])}${String(ctx.rng.int(0, 99_999_999)).padStart(8, "0")}`;
        const spaced = `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
        if (max >= 15) return `+34 ${spaced}`;
        if (max >= 11) return spaced;
        return fit(digits);
      };
    case "address":
      return (ctx) => {
        if (locale === "en") return withNo(ctx, `${ctx.rng.int(1, 9999)} ${ctx.rng.pick(L.streets)} ${ctx.rng.pick(L.streetTypes)}`, " #");
        const floor = ctx.rng.chance(0.6) ? `, ${ctx.rng.int(1, 9)}º ${"ABCD"[ctx.rng.int(0, 3)]}` : "";
        return withNo(ctx, `${ctx.rng.pick(L.streetTypes)} ${ctx.rng.pick(L.streets)}, ${ctx.rng.int(1, 150)}${floor}`, " · ");
      };
    case "city":
      return (ctx) => withNo(ctx, placeOf(ctx).city, " ");
    case "province":
      return (ctx) => withNo(ctx, placeOf(ctx).province, " ");
    case "postalCode":
      if (t.family === "int" || t.family === "decimal") return (ctx) => Number(`${placeOf(ctx).postal}${String(ctx.rng.int(0, 10 ** (5 - placeOf(ctx).postal.length) - 1)).padStart(5 - placeOf(ctx).postal.length, "0")}`);
      return (ctx) => {
        const p = placeOf(ctx);
        return fit(`${p.postal}${String(ctx.rng.int(0, 10 ** (5 - p.postal.length) - 1)).padStart(5 - p.postal.length, "0")}`);
      };
    case "country": {
      const total = L.countries.reduce((sum, c2) => sum + c2.weight, 0);
      const max = t.maxLength ?? Infinity;
      return (ctx) => {
        let r = ctx.rng.next() * total;
        const country = L.countries.find((c2) => (r -= c2.weight) < 0) ?? L.countries[0];
        return max <= 2 ? country.iso2 : max <= 3 ? country.iso3 : fit(country.name);
      };
    }
    case "company":
      return (ctx) => withNo(ctx, ctx.attempt === 0 ? ctx.company() : newCompany(ctx.rng, L, locale), " ");
    case "product":
      return (ctx) => {
        const noun = ctx.rng.pick(L.productNouns);
        const adj = ctx.rng.pick(L.productAdjectives);
        return withNo(ctx, locale === "es" ? `${noun} ${adj}` : `${adj} ${noun}`, " ");
      };
    case "nif": {
      const nie = /(^|_)nie($|_)/.test(normName(col));
      return (ctx) => fit(nif(ctx.rng.int(0, 99_999_999), nie));
    }
    case "cif":
      return (ctx) => fit(cif(ctx.rng.pick([..."ABBBBBBBBEFGHJNPQRSUVW"]), String(ctx.rng.int(0, 9_999_999)).padStart(7, "0")));
    case "iban":
      return (ctx) => {
        let value: string;
        if (locale === "es") {
          const bank = ctx.rng.pick(["0049", "0182", "2100", "0081", "0128", "1465", "0075", "2080", "3058", "0487"]);
          const branch = String(ctx.rng.int(0, 9999)).padStart(4, "0");
          const account = String(ctx.rng.int(0, 9_999_999_999)).padStart(10, "0");
          value = iban("ES", `${bank}${branch}${cccControl(bank, branch, account)}${account}`);
        } else {
          const bank = ctx.rng.pick(["NWBK", "BARC", "LOYD", "HBUK", "MIDL"]);
          value = iban("GB", `${bank}${String(ctx.rng.int(0, 999_999)).padStart(6, "0")}${String(ctx.rng.int(0, 99_999_999)).padStart(8, "0")}`);
        }
        const spaced = value.replace(/(.{4})/g, "$1 ").trim();
        return (t.maxLength ?? Infinity) >= spaced.length ? spaced : fit(value);
      };
    case "url":
      return (ctx) => {
        const name = slug(ctx.attempt === 0 ? ctx.company() : newCompany(ctx.rng, L, locale), "-").replace(/-(s-?l|s-?a|inc|llc|ltd|corp|co|s-?coop|s-?l-?u)$/g, "");
        const path = unique(ctx) ? `/${ctx.rowNo}` : ctx.rng.chance(0.3) ? `/${slug(ctx.rng.pick(LOREM), "-")}` : "";
        return fitWithSuffix(`https://www.${name}`, `.example${path}`, t);
      };
    case "ip":
      return (ctx) => `10.${ctx.rng.int(0, 255)}.${ctx.rng.int(0, 255)}.${ctx.rng.int(1, 254)}`;
    case "lorem":
    case "text":
    case "status": {
      if (s.kind === "status") {
        const statuses = (t.maxLength ?? Infinity) < 4 ? L.statuses.map((v) => v.charAt(0).toUpperCase()) : L.statuses;
        return (ctx) => withNo(ctx, ctx.rng.pick(statuses), " ");
      }
      const max = t.maxLength ?? (s.kind === "lorem" ? 400 : 40);
      if (s.kind === "text" && (t.family === "char" || max <= 8)) {
        // A short code: letters (and the row number, base 36, when it must be unique).
        return (ctx) => (unique(ctx) ? fit(ctx.rowNo.toString(36).toUpperCase().padStart(Math.min(max, 4), "0")) : runPattern([{ k: "rep", node: { k: "set", chars: UPPER }, min: Math.min(max, 1), max: Math.min(max, t.fixed ? max : 8) }], ctx.rng));
      }
      return (ctx) => {
        const target = s.kind === "lorem" ? ctx.rng.int(Math.min(20, max), Math.min(max, max > 200 ? 300 : max)) : ctx.rng.int(Math.min(6, max), Math.min(max, 30));
        let out = "";
        let sentenceStart = true;
        while (out.length < target) {
          let word = ctx.rng.pick(LOREM);
          if (sentenceStart) word = capitalize(word);
          sentenceStart = false;
          out += (out ? " " : "") + word;
          if (s.kind === "lorem" && ctx.rng.chance(0.12)) {
            out += ".";
            sentenceStart = true;
          }
        }
        let text = fitText(out, { ...t, maxLength: target });
        if (s.kind === "lorem" && !/[.]$/.test(text) && text.length < max) text += ".";
        return withNo(ctx, text, " ");
      };
    }
    case "list": {
      const items = parseList(s.values);
      if (!items.length) throw new TestDataError(`«${col}»: la lista de valores está vacía`, index);
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      if (!(total > 0)) throw new TestDataError(`«${col}»: los pesos de la lista suman 0`, index);
      const numeric = t.family === "int" || t.family === "decimal" || t.family === "float";
      return (ctx) => {
        let r = ctx.rng.next() * total;
        const item = items.find((it) => (r -= it.weight) < 0) ?? items[items.length - 1];
        if (t.family === "bool") return /^(1|true|t|s|si|sí|y|yes|verdadero)$/i.test(item.value.trim());
        return numeric && /^-?\d+(\.\d+)?$/.test(item.value.trim()) ? item.value.trim() : fit(item.value);
      };
    }
    case "pattern": {
      let nodes: PatNode[];
      try {
        nodes = parsePattern(s.pattern);
      } catch (err) {
        throw new TestDataError(`«${col}»: ${(err as Error).message}`, index);
      }
      if (!s.pattern) throw new TestDataError(`«${col}»: escribe un patrón`, index);
      return (ctx) => fit(runPattern(nodes, ctx.rng));
    }
    case "expression": {
      const names = model.columns.map((m) => m.col.name);
      for (const ref of templateRefs(s.template)) {
        if (!names.some((n) => n.toLowerCase() === ref.toLowerCase())) throw new TestDataError(`«${col}»: la expresión usa {${ref}}, que no es una columna de la tabla`, index);
      }
      if (!s.template.trim()) throw new TestDataError(`«${col}»: escribe la expresión`, index);
      return (ctx) => {
        const text = s.template.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
          const [ref, ...filters] = inner.split("|").map((part) => part.trim());
          if (ref === "#") return String(ctx.rowNo);
          const at = names.findIndex((n) => n.toLowerCase() === ref.toLowerCase());
          if (at < 0) return whole;
          let value = cellText(ctx.row[at]);
          for (const f of filters) {
            if (f === "lower") value = value.toLowerCase();
            else if (f === "upper") value = value.toUpperCase();
            else if (f === "slug") value = slug(value);
            else if (f === "initial") value = value.charAt(0);
          }
          return value;
        });
        // A column that came out NULL leaves its separators behind: "ana..garcia@" → "ana.garcia@", "ana.@" → "ana@".
        const tidy = text.replace(/([._-])[._-]+/g, "$1").replace(/[._-]+@/g, "@").replace(/^[._-]+|[._-]+$/g, "");
        return unique(ctx) && !/\{#\}/.test(s.template) ? fitWithSuffix(tidy, String(ctx.rowNo), t) : fit(tidy);
      };
    }
    case "fk":
      return null; // Filled by the foreign key's group (see createGenerator).
  }
}

/** A cell as text (expressions, export). */
export function cellText(cell: SheetCell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") return "d" in cell ? cell.d : cell.t;
  return String(cell);
}

function newPerson(rng: Rng, L: LocaleData): Person {
  const female = rng.chance(0.5);
  return { female, first: rng.pick(female ? L.female : L.male), last1: rng.pick(L.surnames), last2: rng.pick(L.surnames) };
}

function newCompany(rng: Rng, L: LocaleData, locale: Locale): string {
  const surname = rng.pick(L.surnames);
  if (locale === "en") return rng.chance(0.5) ? `${rng.pick(L.companyWords)} ${rng.pick(L.productNouns)} ${rng.pick(L.companySuffixes)}` : `${surname} ${rng.pick(L.companySuffixes)}`;
  return rng.chance(0.6) ? `${rng.pick(L.companyWords)} ${surname} ${rng.pick(L.companySuffixes)}` : `${surname} y ${rng.pick(L.surnames)} ${rng.pick(L.companySuffixes)}`;
}

/** The key a unique value is compared by: MySQL and SQL Server compare text without case or accents by default. */
function uniqueKey(cell: SheetCell, dialect: DbKind): string {
  if (cell === null) return "\u0000NULL";
  const text = cellText(cell);
  if (typeof cell === "string" && (dialect === "mysql" || dialect === "mssql")) return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+$/, "");
  if (typeof cell === "string" && /^-?\d+\.\d+$/.test(text)) return String(Number(text));
  return text;
}

/** NULL counts as a value in a unique key here: a second NULL is a duplicate. */
const nullIsValue = (dialect: DbKind) => dialect === "mssql" || dialect === "informix";

export interface RowGenerator {
  /** Indexes of the columns written (the others are left to the server). */
  written: number[];
  /** The next row: a cell for every column of the table (skipped ones null). */
  next(): SheetCell[];
}

const MAX_ATTEMPTS = 40;

/**
 * The rows for a table: each column from its own stream (seed + column name), so the same seed and settings give
 * the same rows. Unique columns retry (from the third attempt with the row number in the value), keys of several
 * columns retry the whole row, foreign keys take a key read from the referenced table. Throws TestDataError when a
 * setting cannot work or unique values run out.
 */
export function createGenerator(model: TableModel, settings: GenSettings[], seed: number, locale: Locale = "es"): RowGenerator {
  const L = LOCALES[locale];
  const n = model.columns.length;
  const fns: (ValueFn | null)[] = settings.map((s, i) => compile(model, i, s, locale));
  const rngs = model.columns.map((c) => stream(seed, `col:${c.col.name}`));
  const nullRngs = model.columns.map((c) => stream(seed, `null:${c.col.name}`));
  const fkGroups = model.fks.map((fk, key) => ({
    key,
    fk,
    rng: stream(seed, `fk:${fk.name}:${fk.columns.join(",")}`),
    cols: model.columns.map((c, i) => (c.fk?.key === key && settings[i].kind === "fk" ? i : -1)).filter((i) => i >= 0),
  })).filter((g) => g.cols.length);
  const personRng = stream(seed, "row:person");
  const placeRng = stream(seed, "row:place");
  const companyRng = stream(seed, "row:company");
  // Expressions after the columns they read.
  const order = [...model.columns.keys()].filter((i) => settings[i].kind !== "expression").concat([...model.columns.keys()].filter((i) => settings[i].kind === "expression"));
  const written = model.columns.map((_, i) => i).filter((i) => settings[i].kind !== "skip");
  const uniqueCols = written.filter((i) => model.columns[i].unique);
  const used: Map<number, Set<string>> = new Map(uniqueCols.map((i) => [i, new Set((model.existingValues[i] ?? []).map((v) => uniqueKey(v, model.dialect)))]));
  const sets = model.uniqueSets.filter((set) => set.every((i) => settings[i].kind !== "skip"));
  const usedSets = sets.map(() => new Set<string>());
  for (const g of fkGroups) {
    if (!g.fk.rows.length && g.cols.some((i) => !model.columns[i].col.nullable)) {
      throw new TestDataError(`«${model.columns[g.cols[0]].col.name}» hace referencia a ${g.fk.target.name}, que está vacía: genera antes sus datos`, g.cols[0]);
    }
  }
  let index = 0;
  return {
    written,
    next() {
      const rowNo = model.existing + index + 1;
      let person: Person | null = null;
      let place: Place | null = null;
      let company: string | null = null;
      const row: SheetCell[] = new Array(n).fill(null);
      const ctx: RowCtx = {
        rng: rngs[0],
        rowNo,
        index,
        attempt: 0,
        row,
        person: () => (person ??= newPerson(personRng, L)),
        place: () => (place ??= placeRng.pick(L.places)),
        company: () => (company ??= newCompany(companyRng, L, locale)),
      };
      for (let rowAttempt = 0; ; rowAttempt++) {
        // Foreign keys: one referenced row per key (its columns together); NULL together when the first column says so.
        for (const g of fkGroups) {
          const first = g.cols[0];
          const pct = settings[first].nullPct;
          const nullable = g.cols.every((i) => model.columns[i].col.nullable);
          const goNull = nullable && (!g.fk.rows.length || (pct > 0 && nullRngs[first].next() * 100 < pct));
          const parent = goNull ? null : g.fk.rows[g.rng.int(0, g.fk.rows.length - 1)];
          for (const i of g.cols) {
            const v = parent ? parent[model.columns[i].fk!.part] : null;
            row[i] = v === undefined ? null : (v as SheetCell);
          }
        }
        for (const i of order) {
          const fn = fns[i];
          if (!fn) continue;
          const c = model.columns[i];
          const seen = used.get(i);
          const pct = settings[i].nullPct;
          let value: SheetCell = null;
          for (let attempt = 0; ; attempt++) {
            ctx.rng = rngs[i];
            ctx.attempt = attempt + rowAttempt;
            const goNull = c.col.nullable && pct > 0 && nullRngs[i].next() * 100 < pct;
            value = goNull && !(seen && nullIsValue(model.dialect) && seen.has("\u0000NULL")) ? null : fn(ctx);
            if (!seen || (value === null && !nullIsValue(model.dialect)) || !seen.has(uniqueKey(value, model.dialect))) break;
            if (attempt >= MAX_ATTEMPTS) throw new TestDataError(`«${c.col.name}» es única y no quedan valores distintos tras ${index.toLocaleString("es-ES")} filas: amplía el rango, cambia el generador o genera menos filas`, i);
          }
          row[i] = value;
        }
        // A unique foreign key (one to one): its referenced row must not be taken yet.
        const fkClash = fkGroups.flatMap((g) => g.cols).find((i) => used.get(i)?.has(uniqueKey(row[i], model.dialect)) && (row[i] !== null || nullIsValue(model.dialect)));
        if (fkClash !== undefined) {
          if (rowAttempt >= MAX_ATTEMPTS) throw new TestDataError(`«${model.columns[fkClash].col.name}» es única y ya se usaron todas las claves de la tabla referenciada`, fkClash);
          continue;
        }
        // Keys of several columns: the combination must be new.
        const clash = sets.findIndex((set, k) => usedSets[k].has(JSON.stringify(set.map((i) => uniqueKey(row[i], model.dialect)))));
        if (clash < 0) break;
        if (rowAttempt >= MAX_ATTEMPTS * 5) {
          throw new TestDataError(`La clave (${sets[clash].map((i) => model.columns[i].col.name).join(", ")}) no tiene más combinaciones distintas tras ${index.toLocaleString("es-ES")} filas`, sets[clash][0]);
        }
      }
      for (const [i, seen] of used) if (row[i] !== null || nullIsValue(model.dialect)) seen.add(uniqueKey(row[i], model.dialect));
      sets.forEach((set, k) => usedSets[k].add(JSON.stringify(set.map((i) => uniqueKey(row[i], model.dialect)))));
      index++;
      return row;
    },
  };
}

// ---------------------------------------------------------------- checking the settings

export interface Problem {
  /** Column index (-1: the whole run). */
  column: number;
  text: string;
  /** Blocks the run (else a warning). */
  error: boolean;
  /** An empty referenced table: the dialog offers to fill it first. */
  parent?: ObjectRef;
}

/** What would stop the run, or deserves a look, before anything is generated. */
export function problems(model: TableModel, settings: GenSettings[], count: number, locale: Locale = "es"): Problem[] {
  const out: Problem[] = [];
  if (!Number.isInteger(count) || count < 1) out.push({ column: -1, text: "Indica cuántas filas generar", error: true });
  if (count > MAX_ROWS) out.push({ column: -1, text: `Como mucho ${MAX_ROWS.toLocaleString("es-ES")} filas por vez`, error: true });
  const total = count + model.existing;
  model.columns.forEach((c, i) => {
    const s = settings[i];
    const name = c.col.name;
    // A primary key column needs a value even where the catalog says nullable (SQLite: `INT PRIMARY KEY` takes NULLs).
    const required = !c.col.nullable || c.col.primaryKey;
    if (s.kind === "skip" && required && !c.auto && !c.col.default) out.push({ column: i, text: `«${name}» es obligatoria y no tiene valor por defecto: elige un generador`, error: true });
    if (s.kind === "null" && required) out.push({ column: i, text: `«${name}» no admite NULL`, error: true });
    if (s.kind !== "skip" && s.kind !== "null" && c.type.noLiteral) out.push({ column: i, text: `«${name}»: ${c.type.noLiteral}; déjala en NULL o sin generar`, error: true });
    if (s.kind === "fk") {
      const fk = c.fk ? model.fks[c.fk.key] : undefined;
      if (!fk) out.push({ column: i, text: `«${name}» no tiene clave foránea`, error: true });
      else if (!fk.rows.length) {
        out.push({ column: i, text: `«${name}» hace referencia a ${fk.target.name}, que está vacía${required ? "" : ": irá a NULL"}`, error: required, parent: fk.target });
      }
    }
    if (s.kind !== "skip" && c.auto && c.col.identity) out.push({ column: i, text: `«${name}» la rellena el servidor (identidad o calculada): al darle valor, el INSERT puede fallar`, error: false });
    if (c.checkUnknown && s.kind !== "skip" && s.kind !== "null") out.push({ column: i, text: `«${name}» tiene una restricción CHECK que Celer no interpreta: revisa que su generador la cumpla`, error: false });
    try {
      compile(model, i, s, locale);
    } catch (err) {
      out.push({ column: i, text: err instanceof Error ? err.message : String(err), error: true });
      return;
    }
    if (!c.unique || s.kind === "skip") return;
    // Unique columns: is there room for every row?
    let room = Infinity;
    if (s.kind === "constant") room = 1;
    else if (s.kind === "boolean") room = 2;
    else if (s.kind === "list") room = new Set(parseList(s.values).map((it) => it.value)).size;
    else if (s.kind === "null") room = nullIsValue(model.dialect) ? 1 : Infinity;
    else if (s.kind === "integer") {
      try {
        room = Number(BigInt(s.max || "1000") - BigInt(s.min || "0") + 1n);
      } catch {
        /* reported by compile */
      }
    } else if (s.kind === "date") {
      try {
        room = Math.floor((parseDate(s.max || "2025-12-31", "", i) - parseDate(s.min || "2020-01-01", "", i)) / DAY) + 1;
      } catch {
        /* reported by compile */
      }
    } else if (s.kind === "pattern") {
      try {
        room = patternVariety(parsePattern(s.pattern));
      } catch {
        /* reported by compile */
      }
    } else if (s.kind === "status" || s.kind === "country" || s.kind === "city" || s.kind === "province") room = 60;
    if (room < total) out.push({ column: i, text: `«${name}» es única y su generador solo da ${room.toLocaleString("es-ES")} valores distintos (hacen falta ${total.toLocaleString("es-ES")})`, error: true });
  });
  // Expressions read generated columns.
  settings.forEach((s, i) => {
    if (s.kind !== "expression") return;
    for (const ref of templateRefs(s.template)) {
      const at = model.columns.findIndex((c) => c.col.name.toLowerCase() === ref.toLowerCase());
      if (at >= 0 && settings[at].kind === "skip") out.push({ column: i, text: `«${model.columns[i].col.name}» usa {${ref}}, que no se genera (quedará vacío)`, error: false });
    }
  });
  return out;
}

// ---------------------------------------------------------------- outputs

/** The rows as the import writes them: INSERT statements, batched per dialect (importBatch). */
export function insertStatements(model: TableModel, generator: RowGenerator, rows: SheetCell[][]): string[] {
  const mapping = model.columns.map((_, i) => (generator.written.includes(i) ? i : -1));
  if (!generator.written.length) {
    // Every column left to the server: one row of defaults each.
    const sql = model.dialect === "mysql" ? `INSERT INTO ${model.qualified} () VALUES ()` : `INSERT INTO ${model.qualified} DEFAULT VALUES`;
    return rows.map(() => sql);
  }
  return importStatements(rows, { qualified: model.qualified, columns: model.columns.map((c) => c.col), quoted: model.columns.map((c) => c.quoted), mapping, emptyAsNull: false }, model.dialect);
}

/** A script of INSERT statements (nothing runs): what «Insertar» would send, statement by statement. */
export function scriptText(model: TableModel, statements: string[], header: { rows: number; seed: number; locale: Locale }): string {
  const head = `-- Datos de prueba para ${model.qualified}: ${header.rows.toLocaleString("es-ES")} filas, semilla ${header.seed}, ${header.locale === "es" ? "español" : "inglés"}.\n-- Generado por Celer. Revisa antes de ejecutar.\n\n`;
  return head + statements.map((sql) => `${sql};`).join("\n\n") + "\n";
}

/** The generated rows as a result (the written columns), for CSV / JSON export. */
export function rowsResult(model: TableModel, generator: RowGenerator, rows: SheetCell[][]): ResultSet {
  const columns: ColumnInfo[] = generator.written.map((i) => ({ name: model.columns[i].col.name, typeName: model.columns[i].col.typeName, kind: model.columns[i].col.kind }));
  const toCell = (cell: SheetCell): Cell => (cell === null || cell === undefined ? null : typeof cell === "object" ? cellText(cell) : cell);
  return { columns, rows: rows.map((row) => generator.written.map((i) => toCell(row[i]))), hasMore: false, rowsAffected: null };
}

/** CSV or JSON text of the rows (the export's own writer). */
export function exportText(model: TableModel, generator: RowGenerator, rows: SheetCell[][], format: "csv" | "json"): string {
  return resultToText(rowsResult(model, generator, rows), format, model.table);
}

/** The first `n` rows for the preview, or the error that stops them. */
export function previewRows(model: TableModel, settings: GenSettings[], seed: number, locale: Locale, n = 20): { rows: SheetCell[][]; written: number[]; error: string; column: number } {
  try {
    const generator = createGenerator(model, settings, seed, locale);
    const rows: SheetCell[][] = [];
    for (let i = 0; i < n; i++) rows.push(generator.next());
    return { rows, written: generator.written, error: "", column: -1 };
  } catch (err) {
    return { rows: [], written: [], error: err instanceof Error ? err.message : String(err), column: err instanceof TestDataError ? err.column : -1 };
  }
}
