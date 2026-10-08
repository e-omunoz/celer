// The script that brings a table's rows to match another's, from a comparison (compare.ts): INSERT for rows only
// in the source, UPDATE of the changed columns for rows in both, and the DELETE of rows only in the target written
// commented out. Pure: dev/datacompare-check.ts tests it.
import type { Comparison } from "./compare.ts";
import { cellText, quoteIdentFor, sqlLiteral } from "./sql.ts";
import type { Cell, ColumnInfo, DbKind } from "./types";

export interface DataSyncOptions {
  dialect: DbKind;
  /** The target table, qualified and quoted. */
  table: string;
  /** Columns of the target (only these are written). */
  targetColumns: { name: string; identity?: boolean }[];
}

const literal = (cell: Cell, column: ColumnInfo, dialect: DbKind) => (cell === null || cell === undefined ? "NULL" : sqlLiteral(cellText(cell), column.kind, dialect));

/**
 * `comparison` compares the target (before) with the source (after): its rows carry the source's values, `changed`
 * the target's old ones, `gone` the rows only in the target and the rows from `newFrom` on only in the source.
 */
export function dataSyncScript(comparison: Comparison, options: DataSyncOptions): string {
  const { dialect } = options;
  const q = (name: string) => quoteIdentFor(name, dialect);
  const inTarget = new Map(options.targetColumns.map((c) => [c.name, c]));
  // Written columns: in both tables, not binary (no portable literal).
  const writable = comparison.columns.map((c, i) => ({ c, i })).filter(({ c }) => inTarget.has(c.name) && c.kind !== "binary");
  const skipped = comparison.columns.filter((c) => inTarget.has(c.name) && c.kind === "binary").map((c) => c.name);
  const keyIdx = comparison.key.map((name) => comparison.columns.findIndex((c) => c.name === name)).filter((i) => i >= 0);
  const where = (row: Cell[]) => keyIdx.map((i) => (row[i] === null || row[i] === undefined ? `${q(comparison.columns[i].name)} IS NULL` : `${q(comparison.columns[i].name)} = ${literal(row[i], comparison.columns[i], dialect)}`)).join(" AND ");

  const lines: string[] = [];
  if (!keyIdx.length) lines.push("-- Sin clave para emparejar filas: las cambiadas aparecen como borradas y nuevas.");
  if (skipped.length) lines.push(`-- Columnas binarias no incluidas: ${skipped.join(", ")}.`);

  const added = comparison.rows.slice(comparison.newFrom);
  if (added.length) {
    lines.push("", `-- Filas que faltan en el destino (${added.length})`);
    const identity = writable.some(({ c }) => inTarget.get(c.name)?.identity);
    if (identity && dialect === "mssql") lines.push(`SET IDENTITY_INSERT ${options.table} ON;`);
    const cols = writable.map(({ c }) => q(c.name)).join(", ");
    const overriding = identity && dialect === "postgres" ? " OVERRIDING SYSTEM VALUE" : "";
    for (const row of added) lines.push(`INSERT INTO ${options.table} (${cols})${overriding} VALUES (${writable.map(({ c, i }) => literal(row[i], c, dialect)).join(", ")});`);
    if (identity && dialect === "mssql") lines.push(`SET IDENTITY_INSERT ${options.table} OFF;`);
  }

  if (keyIdx.length) {
    const updates: string[] = [];
    const changedRows = new Map<number, number[]>();
    for (const key of Object.keys(comparison.changed)) {
      const [row, col] = key.split(":").map(Number);
      changedRows.set(row, [...(changedRows.get(row) ?? []), col]);
    }
    for (const [rowIndex, cols] of [...changedRows].sort((a, b) => a[0] - b[0])) {
      const row = comparison.rows[rowIndex];
      const sets = cols.filter((i) => writable.some((w) => w.i === i) && !keyIdx.includes(i)).map((i) => `${q(comparison.columns[i].name)} = ${literal(row[i], comparison.columns[i], dialect)}`);
      if (sets.length) updates.push(`UPDATE ${options.table} SET ${sets.join(", ")} WHERE ${where(row)};`);
    }
    if (updates.length) lines.push("", `-- Filas con valores distintos (${updates.length})`, ...updates);
  }

  if (comparison.gone.length) {
    lines.push("", `-- Filas que solo están en el destino (${comparison.gone.length}): borrarlas es decisión tuya`);
    for (const index of comparison.gone) {
      const row = comparison.rows[index];
      const condition = keyIdx.length ? where(row) : writable.map(({ c, i }) => (row[i] === null || row[i] === undefined ? `${q(c.name)} IS NULL` : `${q(c.name)} = ${literal(row[i], c, dialect)}`)).join(" AND ");
      lines.push(`-- DELETE FROM ${options.table} WHERE ${condition};`);
    }
  }
  if (!added.length && !comparison.counts.changed && !comparison.gone.length) return "-- Las dos tablas tienen los mismos datos: no hay nada que cambiar.\n";
  return `${lines.join("\n").trim()}\n`;
}
