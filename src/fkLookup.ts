// Choosing the value of a foreign-key cell from the referenced table: while the cell is being edited, a side
// session searches the referenced table by its key and by a descriptive column (name, title, code…), so the
// table's own session keeps its open cursor.
import { api, errorText } from "./api";
import { LOOKUP_ROWS, lookupSql, pickLabelColumn } from "./fkLookupSql";
import { cellText, isNullCell } from "./sql";
import { foreignKeyOf, kindOf, openSessionFor, type TableTab } from "./state";

export interface LookupItem {
  value: string;
  label: string;
}

export interface LookupSession {
  /** "clientes · nombre": what the list shows. */
  title: string;
  search(text: string): Promise<LookupItem[]>;
  close(): void;
}

/** A lookup for `column` of the table tab, or null when it is not (the only column of) a foreign key. */
export async function openFkLookup(tab: TableTab, column: string): Promise<LookupSession | null> {
  const fk = foreignKeyOf(tab, column);
  if (!fk || fk.columns.length !== 1 || fk.targetColumns.length !== 1) return null;
  const opened = await openSessionFor(tab.connId);
  if (!opened) return null;
  const sid = opened.sessionId;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void api().closeSession(sid).catch(() => {});
  };
  try {
    if (fk.target.database) await api().useDatabase(sid, fk.target.database).catch(() => {});
    const [columns, info] = await Promise.all([api().tableColumns(sid, fk.target), api().objectSql(sid, fk.target)]);
    const keyName = fk.targetColumns[0];
    // Informix cannot compare or sort its large objects (TEXT, CLOB): they never label a row.
    const usable = kindOf(tab.connId) === "informix" ? columns.filter((c) => !/^(text|clob|byte|blob)\b/i.test(c.typeName.trim())) : columns;
    const labelName = pickLabelColumn(usable, keyName);
    const [qKey, qLabel] = await api().quoteIdents(sid, labelName ? [keyName, labelName] : [keyName]);
    const kind = kindOf(tab.connId);
    const run = async (text: string): Promise<LookupItem[]> => {
      if (closed) return [];
      const out = await api().execute(sid, lookupSql(kind, info.qualified, qKey, labelName ? qLabel : null, text), LOOKUP_ROWS);
      const rows = out.results.find((r) => r.columns.length)?.rows ?? [];
      return rows.filter((row) => !isNullCell(row[0])).map((row) => ({ value: cellText(row[0]), label: row.length > 1 && !isNullCell(row[1]) ? cellText(row[1]) : "" }));
    };
    // One statement at a time on the session: a new search waits for the previous one.
    let chain: Promise<unknown> = Promise.resolve();
    return {
      title: `${fk.target.name}${labelName ? ` · ${labelName}` : ""}`,
      search: (text) => {
        const next = chain.then(
          () => run(text),
          () => run(text),
        );
        chain = next.catch(() => {});
        return next;
      },
      close,
    };
  } catch (err) {
    close();
    throw new Error(`No se pudo leer ${fk.target.name}: ${errorText(err)}`);
  }
}
