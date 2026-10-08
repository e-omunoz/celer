// The script that brings a table's rows to match another's, from a comparison (compare.ts): INSERT for rows only
// in the source, UPDATE of the changed columns for rows in both, and the DELETE of rows only in the target written
// commented out. Pure: dev/datacompare-check.ts tests it.
import type { Comparison } from "./compare.ts";
import { cellText, fitInformixDatetime, quoteIdentFor, sqlLiteral } from "./sql.ts";
import type { Cell, ColKind, DbKind } from "./types";

export interface DataSyncOptions {
  dialect: DbKind;
  /** The target table, qualified and quoted. */
  table: string;
  /** Columns of the target: only these are written, with their names and kinds. */
  targetColumns: { name: string; identity?: boolean; kind?: ColKind; typeName?: string }[];
}

/**
 * `comparison` compares the target (before) with the source (after): its rows carry the source's values, `changed`
 * the target's old ones, `gone` the rows only in the target and the rows from `newFrom` on only in the source.
 */
export function dataSyncScript(comparison: Comparison, options: DataSyncOptions): string {
  const { dialect } = options;
  const q = (name: string) => quoteIdentFor(name, dialect);
  // Each source column with its target column (same name, or the same in another case).
  const target = (name: string) => options.targetColumns.find((c) => c.name === name) ?? options.targetColumns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const columns = comparison.columns.map((c, i) => ({ i, source: c, target: target(c.name) }));
  // Literals in the target's terms (its kind: a source bit going into an integer column is 1, not TRUE).
  const kind = (i: number): ColKind => columns[i].target?.kind ?? comparison.columns[i].kind;
  const literal = (cell: Cell, i: number) => {
    if (cell === null || cell === undefined) return "NULL";
    if (typeof cell === "boolean" && kind(i) === "number") return cell ? "1" : "0";
    // Informix DATETIME: exactly the fields of its qualifier (the text may carry more).
    const typeName = columns[i].target?.typeName ?? "";
    const text = dialect === "informix" && /^datetime\b/i.test(typeName) ? fitInformixDatetime(cellText(cell), typeName) : cellText(cell);
    return sqlLiteral(text, kind(i), dialect);
  };
  const name = (i: number) => q(columns[i].target?.name ?? comparison.columns[i].name);
  // Written columns: in both tables, not binary (no portable literal).
  const writable = columns.filter((c) => c.target && kind(c.i) !== "binary");
  const skipped = columns.filter((c) => c.target && kind(c.i) === "binary").map((c) => c.target!.name);
  const keyIdx = comparison.key.map((k) => comparison.columns.findIndex((c) => c.name === k)).filter((i) => i >= 0);

  // A binary key has no literal that would find its rows: no script rather than one that silently misses.
  if (keyIdx.some((i) => kind(i) === "binary")) return "-- La clave de las filas es binaria: no se puede escribir un script que las encuentre.\n";

  const where = (row: Cell[], idx: number[]) => idx.map((i) => (row[i] === null || row[i] === undefined ? `${name(i)} IS NULL` : `${name(i)} = ${literal(row[i], i)}`)).join(" AND ");
  const lines: string[] = [];
  if (!keyIdx.length) lines.push("-- Sin clave para emparejar filas: las cambiadas aparecen como borradas y nuevas.");
  if (skipped.length) lines.push(`-- Columnas binarias no incluidas: ${skipped.join(", ")}.`);

  const added = comparison.rows.slice(comparison.newFrom);
  if (added.length) {
    lines.push("", `-- Filas que faltan en el destino (${added.length})`);
    const identity = writable.filter((c) => c.target?.identity);
    if (identity.length && dialect === "mssql") lines.push(`SET IDENTITY_INSERT ${options.table} ON;`);
    const cols = writable.map((c) => name(c.i)).join(", ");
    const overriding = identity.length && dialect === "postgres" ? " OVERRIDING SYSTEM VALUE" : "";
    for (const row of added) lines.push(`INSERT INTO ${options.table} (${cols})${overriding} VALUES (${writable.map((c) => literal(row[c.i], c.i)).join(", ")});`);
    if (identity.length && dialect === "mssql") lines.push(`SET IDENTITY_INSERT ${options.table} OFF;`);
    // Explicit identity values do not move PostgreSQL's sequence: the next normal insert would collide.
    if (identity.length && dialect === "postgres") {
      for (const c of identity) {
        const col = c.target!.name;
        lines.push(`SELECT setval(pg_get_serial_sequence(${sqlLiteral(options.table, "text", dialect)}, ${sqlLiteral(col, "text", dialect)}), (SELECT max(${q(col)}) FROM ${options.table}));`);
      }
    }
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
      // Identity columns are never set (SQL Server and GENERATED ALWAYS refuse it; their values are the target's own).
      const sets = cols.filter((i) => writable.some((w) => w.i === i) && !keyIdx.includes(i) && !columns[i].target?.identity).map((i) => `${name(i)} = ${literal(row[i], i)}`);
      if (sets.length) updates.push(`UPDATE ${options.table} SET ${sets.join(", ")} WHERE ${where(row, keyIdx)};`);
    }
    if (updates.length) lines.push("", `-- Filas con valores distintos (${updates.length})`, ...updates);
  }

  if (comparison.gone.length) {
    lines.push("", `-- Filas que solo están en el destino (${comparison.gone.length}): borrarlas es decisión tuya`);
    for (const index of comparison.gone) lines.push(`-- DELETE FROM ${options.table} WHERE ${where(comparison.rows[index], keyIdx.length ? keyIdx : writable.map((c) => c.i))};`);
  }
  if (!added.length && !comparison.counts.changed && !comparison.gone.length) return "-- Las dos tablas tienen los mismos datos: no hay nada que cambiar.\n";
  return `${lines.join("\n").trim()}\n`;
}
