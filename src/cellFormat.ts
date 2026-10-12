// How the grid draws a value, from the Results settings. Display only: copies, exports and edits keep the value as
// the server sent it.
import type { Cell, ColKind, DateFormat, NumberFormat } from "./types";

export interface CellDisplay {
  nullText: string;
  dateFormat: DateFormat;
  numberFormat: NumberFormat;
  maxCellChars: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?))?(.*)$/;
const PLAIN_NUMBER = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** A date or date-time as day/month/year ("2026-03-15 10:20:00+01" → "15/03/2026 10:20:00+01"). */
export function formatDate(text: string, format: DateFormat): string {
  if (format === "iso") return text;
  const m = ISO_DATE.exec(text.trim());
  if (!m) return text;
  const [, y, mo, d, , time, rest] = m;
  return `${d}/${mo}/${y}${time ? ` ${time}` : ""}${rest}`;
}

/**
 * A number with a thousands separator, Spanish style ("1234567.5" → "1.234.567,5"). Done on the text, so a DECIMAL
 * wider than a double keeps every digit; anything else (exponents, NaN, money with a symbol) is left as it is.
 */
export function formatNumber(text: string, format: NumberFormat): string {
  if (format === "plain") return text;
  const m = PLAIN_NUMBER.exec(text.trim());
  if (!m) return text;
  const [, sign, int, frac] = m;
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}${frac !== undefined ? `,${frac}` : ""}`;
}

/** The text a grid cell shows (before it is cut to the column's width). */
export function cellLabel(value: Cell, kind: ColKind | undefined, prefs: CellDisplay): string {
  if (value === null || value === undefined) return prefs.nullText;
  let text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  if (kind === "date") text = formatDate(text, prefs.dateFormat);
  else if (kind === "number") text = formatNumber(text, prefs.numberFormat);
  const max = Math.max(1, prefs.maxCellChars);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
