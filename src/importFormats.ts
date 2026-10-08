// Reading the files the import wizard accepts: CSV / TSV, JSON (objects, arrays, JSON Lines). Pure, so
// dev/import-check.ts tests it; spreadsheets are read by the Rust side (sheets.rs).

/** RFC 4180 CSV parser (quotes, doubled quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).filter(Boolean);
  let best = ",";
  let bestScore = -1;
  for (const delimiter of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => line.split(delimiter).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.every((count) => count === counts[0]);
    const score = counts[0] * (consistent ? 2 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** A JSON value as an import cell: null as empty (NULL with «vacíos como NULL»), objects and arrays as JSON. */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * JSON data as rows with a header row: an array of objects (the header is every key, in order of appearance),
 * an array of arrays (as they are), an object holding such an array ({"data": […]}) or JSON Lines.
 */
export function parseJsonRows(text: string): { rows: string[][]; objects: boolean } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (err) {
    // JSON Lines: one value per line.
    const lines = src.split(/\r?\n/).filter((line) => line.trim());
    try {
      data = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error(`El fichero no es JSON válido: ${(err as Error).message}`);
    }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const inner = Object.values(data as Record<string, unknown>).find((value) => Array.isArray(value) && value.some((item) => item && typeof item === "object"));
    data = inner ?? [data];
  }
  if (!Array.isArray(data)) throw new Error("El JSON no contiene una lista de filas");
  const items = data.filter((item) => item !== null && item !== undefined);
  if (items.length && items.every(Array.isArray)) return { rows: (items as unknown[][]).map((row) => row.map(jsonCell)), objects: false };
  if (!items.every((item) => typeof item === "object" && !Array.isArray(item))) throw new Error("Las filas del JSON deben ser objetos o listas");
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items as Record<string, unknown>[]) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return { rows: [keys, ...(items as Record<string, unknown>[]).map((item) => keys.map((key) => jsonCell(item[key])))], objects: true };
}

export type ImportFormat = "csv" | "json" | "sheet";

export function importFormat(path: string): ImportFormat {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") return "json";
  if (["xlsx", "xlsm", "xlsb", "xls", "ods"].includes(ext)) return "sheet";
  return "csv";
}
