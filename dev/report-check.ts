// Checks for the report window's logic (src/report.ts): node --experimental-strip-types dev/report-check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  blankDraft,
  buildIssue,
  draftIsEmpty,
  draftProblems,
  engineLine,
  environmentText,
  issueText,
  issueUrl,
  MAX_URL,
  osFromUserAgent,
  parseIssueUrl,
  REPO,
  sentLink,
} from "../src/report.ts";

// ---- engine and driver of the active connection, for every engine: never the host, the database or the file
const banners: [Parameters<typeof engineLine>, string, string[]][] = [
  [["postgres", "PostgreSQL 17.2 — db.internal.example:5432/ventas", "nativo"], "PostgreSQL · nativo · PostgreSQL 17.2", ["db.internal", "ventas", "5432"]],
  [["mysql", "8.4.3 MySQL Community Server - GPL — 10.0.0.7:3306", "nativo"], "MySQL · nativo · 8.4.3 MySQL Community Server - GPL", ["10.0.0.7"]],
  [["mysql", "11.4.4-MariaDB-ubu2404 — mariadb.example:3307", "nativo"], "MariaDB · nativo · 11.4.4-MariaDB-ubu2404", ["mariadb.example"]],
  [["mssql", "Microsoft SQL Server 2022 (RTM-CU16) - 16.0.4165.4 (X64) — Developer Edition (64-bit) (16.0.4165.4)", "TDS nativo"], "SQL Server · TDS nativo · Microsoft SQL Server 2022 (RTM-CU16) - 16.0.4165.4 (X64)", []],
  [["informix", "IBM Informix Dynamic Server Version 15.0.1.0", "IBM CLI (DRDA)"], "Informix · IBM CLI (DRDA) · IBM Informix Dynamic Server Version 15.0.1.0", []],
  [["informix", "IBM Informix Dynamic Server 15.0.1.0", "JDBC"], "Informix · JDBC · IBM Informix Dynamic Server 15.0.1.0", []],
  [["sqlite", "SQLite 3.46.0 — C:\\Users\\oscar\\datos\\ventas.db", "embebido"], "SQLite · embebido · SQLite 3.46.0", ["oscar", "ventas.db"]],
  [["odbc", "PostgreSQL 17.2.0", "ODBC · PostgreSQL Unicode"], "ODBC · ODBC · PostgreSQL Unicode · PostgreSQL 17.2.0", []],
];
for (const [args, want, gone] of banners) {
  const line = engineLine(...args);
  assert.equal(line, want);
  for (const g of gone) assert.ok(!line.includes(g), `${line} still has ${g}`);
}

assert.equal(osFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129"), "Windows 10/11");
assert.equal(osFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605"), "macOS 14.5");
assert.equal(osFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605"), "Linux");

// ---- drafts
const bug = blankDraft("bug", "d1", 1);
assert.ok(draftIsEmpty(bug));
assert.equal(bug.attachErrors, false, "the last errors are opt-in: only the report opened after an error starts with them");
assert.equal(blankDraft("idea", "d2").attachErrors, false);
assert.deepEqual(draftProblems(bug), ["un título", "qué ha pasado", "los pasos"]);
assert.deepEqual(draftProblems({ ...blankDraft("idea", "d3"), title: "x" }), ["qué te gustaría"]);

// ---- the issue: form, labels for triage, user paths gone, the environment without a host
const env = { version: "2.3.0", os: "Windows 10/11", theme: "Celer Oscuro", engine: "PostgreSQL · nativo · PostgreSQL 17.2" };
const filled = {
  ...bug,
  attachErrors: true,
  title: "La exportación falla",
  happened: "Al exportar a C:\\Users\\oscar\\Desktop\\x.csv sale un error",
  expected: "Que exporte",
  steps: "1. Abrir tabla\n2. Exportar",
  images: [{ id: "i", name: "captura.png", dataUrl: "data:image/png;base64,AAAA" }],
};
const issue = buildIssue(filled, env, "2026-10-09T08:30:00Z · 2.3.0 · driver:postgres\ndb error: ERROR: …", "oscar");
assert.equal(issue.template, "bug_report.yml");
assert.deepEqual(issue.labels, ["bug", "status:triage"]);
const field = (id: string) => issue.fields.find((f) => f.id === id)?.value ?? "";
assert.ok(field("what").includes("C:\\Users\\…\\Desktop"), field("what"));
assert.ok(!issueText(issue).includes("oscar"), "the user name is nowhere");
assert.ok(field("environment").includes("Conexión activa: PostgreSQL · nativo · PostgreSQL 17.2"));
assert.ok(field("logs").startsWith("2026-10-09T08:30:00Z"));
assert.ok(field("screenshots").includes("1 imagen"));
assert.equal(buildIssue({ ...filled, attachErrors: false }, env, "x").fields.some((f) => f.id === "logs"), false, "errors only when ticked");
const idea = buildIssue({ ...blankDraft("idea", "d4"), title: "Atajo", what: "Un atajo", why: "Rapidez", area: "Consola SQL" }, env, "");
assert.equal(idea.template, "feature_request.yml");
assert.deepEqual(idea.labels, ["enhancement", "status:triage"]);
assert.deepEqual(idea.fields.map((f) => f.id), ["what", "why", "area", "version"]);
assert.ok(environmentText({ ...env, engine: "" }).includes("Conexión activa: ninguna"));

// ---- every field id exists in its issue form, so GitHub fills it
for (const [file, built] of [["bug_report.yml", issue], ["feature_request.yml", idea]] as const) {
  const yml = readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), "utf8");
  for (const f of buildIssue({ ...filled, kind: built === idea ? "idea" : "bug", what: "a", why: "b", area: "c" }, env, "e").fields) {
    assert.ok(new RegExp(`\\n\\s+id: ${f.id}\\n`).test(yml), `${file} has no field ${f.id}`);
    assert.ok(yml.includes(`label: ${f.label}\n`), `${file}: the preview shows «${f.label}», the form another label`);
  }
  for (const label of built.labels) assert.ok(yml.includes(label), `${file} applies ${label}`);
}

// ---- the address: prefilled, and cut to fit
const { url, cut } = issueUrl(issue);
assert.ok(url.startsWith(`https://github.com/${REPO}/issues/new?`));
const params = new URL(url).searchParams;
assert.equal(params.get("template"), "bug_report.yml");
assert.equal(params.get("title"), "La exportación falla");
assert.equal(params.get("labels"), "bug,status:triage");
assert.equal(params.get("steps"), "1. Abrir tabla\n2. Exportar");
assert.deepEqual(cut, []);
const huge = buildIssue({ ...filled, happened: "ñ".repeat(20_000) }, env, "e".repeat(9000));
const fitted = issueUrl(huge);
assert.ok(fitted.url.length <= MAX_URL, `${fitted.url.length}`);
assert.ok(fitted.cut.includes("what"));
assert.ok(new URL(fitted.url).searchParams.get("what")!.endsWith("(recortado: el texto completo está en el portapapeles)"));

// ---- «Mis reportes»
assert.equal(parseIssueUrl("https://github.com/e-omunoz/celer/issues/131#issuecomment-1"), "https://github.com/e-omunoz/celer/issues/131");
assert.equal(parseIssueUrl("https://github.com/otro/repo/issues/1"), "");
assert.equal(sentLink({ id: "s", kind: "bug", title: "La exportación", at: 1, issueUrl: "" }), `https://github.com/${REPO}/issues?q=is%3Aissue%20in%3Atitle%20%22La%20exportaci%C3%B3n%22`);
assert.equal(sentLink({ id: "s", kind: "bug", title: "x", at: 1, issueUrl: "https://github.com/e-omunoz/celer/issues/9" }), "https://github.com/e-omunoz/celer/issues/9");

console.log("report-check: ok");
