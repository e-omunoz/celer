declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: (string | number | Uint8Array | null)[][];
  }
  export interface Database {
    run(sql: string): Database;
    exec(sql: string): QueryExecResult[];
    getRowsModified(): number;
    prepare(sql: string): Statement;
    close(): void;
  }
  export interface Statement {
    getColumnNames(): string[];
    free(): boolean;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
