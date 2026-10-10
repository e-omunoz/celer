// Writes one connection per engine of docs/review/ENGINE_MATRIX.md into a dev data folder's connections.json, so a
// tester starts with every engine ready. Used by dev\run-desktop.ps1 (-Engines, and every new slot folder).
//   node dev/devdata-connections.mjs <data folder>
// Ids are fixed, so every data folder shares the same entries of the "Celer-dev" credential store: the passwords go
// in as `PWD=` in «Parámetros extra», and the app moves them to the store on its first start (lib.rs
// move_inline_passwords). Existing connections with other ids are kept; these ones are replaced.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node dev/devdata-connections.mjs <data folder>");
  process.exit(2);
}

// SQLite: a copy per data folder, so slots never write the same file.
const sqliteSeed = "C:\\Users\\oscar\\Documents\\Celer\\tienda-pruebas.sqlite";
const sqlite = join(dir, "tienda.sqlite");
if (!existsSync(sqlite) && existsSync(sqliteSeed)) copyFileSync(sqliteSeed, sqlite);

const base = {
  color: "", encryption: "login", filePath: "", folder: "Motores (ENGINE_MATRIX)", instance: "", integratedAuth: false,
  informixMode: "drda", odbcConnStr: "", production: false, readOnly: false, savePassword: true, startupSql: "",
  trustCert: true, host: "", port: null, user: "", database: "", extra: "",
};
const id = (n) => `00000000-ce1e-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const engines = [
  { id: id(1), name: "PostgreSQL", kind: "postgres", host: "localhost", port: 15432, user: "celer", database: "celer", extra: "PWD=celer" },
  { id: id(2), name: "MySQL", kind: "mysql", host: "127.0.0.1", port: 33306, user: "celer", database: "celer", extra: "PWD=celer" },
  { id: id(3), name: "MariaDB", kind: "mysql", host: "127.0.0.1", port: 33307, user: "celer", database: "celer", extra: "PWD=celer" },
  { id: id(4), name: "SQL Server", kind: "mssql", host: "localhost", port: 1433, user: "sa", database: "celerdemo", extra: "PWD=Celer_Test_2026!" },
  { id: id(5), name: "Informix DRDA", kind: "informix", host: "localhost", port: 9089, user: "informix", database: "celerdemo", informixMode: "drda", extra: "PWD=in4mix" },
  { id: id(6), name: "Informix JDBC", kind: "informix", host: "localhost", port: 9088, user: "informix", database: "celerdemo", instance: "informix", informixMode: "jdbc", extra: "PWD=in4mix" },
  { id: id(7), name: "SQLite", kind: "sqlite", filePath: sqlite, savePassword: false },
  // The only ODBC driver every Windows has; any other DSN (PostgreSQL, MySQL ODBC) is added by hand when installed.
  { id: id(8), name: "ODBC (SQL Server)", kind: "odbc", odbcConnStr: "DRIVER={SQL Server};SERVER=localhost,1433;DATABASE=celerdemo;UID=sa;PWD=Celer_Test_2026!" },
];

const file = join(dir, "connections.json");
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const ids = new Set(engines.map((e) => e.id));
const next = [...current.filter((c) => !ids.has(c.id)), ...engines.map((e) => ({ ...base, ...e }))];
writeFileSync(file, JSON.stringify(next, null, 2));
console.log(`${file}: ${engines.map((e) => e.name).join(", ")}`);
