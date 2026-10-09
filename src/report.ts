// «Reportar / Sugerir» (#112): what a report holds, what it says about this copy of Celer, and the GitHub issue it
// becomes. Pure logic (dev/report-check.ts); the window is src/components/ReportDialog.tsx. Nothing is sent from
// here: the report opens as a prefilled github.com/…/issues/new page and the user submits it there.
import { scrubPaths } from "./scrub.ts";
import type { DbKind } from "./types";

export type ReportKind = "bug" | "idea";

export const REPO = "e-omunoz/celer";

/** An image attached to a report: a screenshot (maybe annotated), or one pasted or dropped. */
export interface ReportImage {
  id: string;
  name: string;
  /** data:image/png;base64,… */
  dataUrl: string;
}

export interface ReportDraft {
  id: string;
  kind: ReportKind;
  title: string;
  /** Bug: what happened, what was expected, the steps. */
  happened: string;
  expected: string;
  steps: string;
  /** Idea: what, why, the area. */
  what: string;
  why: string;
  area: string;
  /** Attach the newest entries of the error log (#122), shown in the preview first. */
  attachErrors: boolean;
  images: ReportImage[];
  updatedAt: number;
}

/** A report opened on GitHub («Mis reportes»). */
export interface SentReport {
  id: string;
  kind: ReportKind;
  title: string;
  at: number;
  /** The issue's address once the user pastes it ("" until then). */
  issueUrl: string;
}

/** What a report says about this copy of Celer: never a host, a user, a database name or data. */
export interface ReportEnv {
  version: string;
  os: string;
  theme: string;
  /** The active connection's engine and driver ("" without one). */
  engine: string;
}

export const AREAS = [
  "Conexiones",
  "Consola SQL",
  "Resultados y rejilla",
  "Tablas y edición de datos",
  "Explorador",
  "Exportar e importar",
  "Diagramas y comparaciones",
  "IA y MCP",
  "Ajustes y apariencia",
  "Instalación y actualizaciones",
  "Otra",
];

/** Errors attached by default: the newest few. */
export const ATTACHED_ERRORS = 5;

export function blankDraft(kind: ReportKind, id: string, now = Date.now()): ReportDraft {
  return { id, kind, title: "", happened: "", expected: "", steps: "", what: "", why: "", area: "", attachErrors: kind === "bug", images: [], updatedAt: now };
}

/** Nothing typed and no image: not worth keeping as a draft. */
export function draftIsEmpty(d: ReportDraft): boolean {
  return !d.images.length && ![d.title, d.happened, d.expected, d.steps, d.what, d.why].some((v) => v.trim());
}

/** What is missing before the report can open on GitHub, in the words of the form. */
export function draftProblems(d: ReportDraft): string[] {
  const missing: string[] = [];
  if (!d.title.trim()) missing.push("un título");
  if (d.kind === "bug") {
    if (!d.happened.trim()) missing.push("qué ha pasado");
    if (!d.steps.trim()) missing.push("los pasos");
  } else if (!d.what.trim()) missing.push("qué te gustaría");
  return missing;
}

/**
 * The engine of the active connection as a report gives it: product, version and driver, without the server's address
 * or the database (the banners of PostgreSQL, MySQL and SQLite carry them after " — ").
 */
export function engineLine(kind: DbKind, serverInfo: string, driver: string): string {
  const banner = (serverInfo.split("\n")[0] ?? "").split(" — ")[0].trim();
  const product = kind === "mysql" ? (/mariadb/i.test(serverInfo) ? "MariaDB" : "MySQL") : ENGINE_NAMES[kind];
  // The address went with the " — " part; versions look like IPs (15.0.1.0), so only user paths are scrubbed here.
  const server = scrubPaths(banner).slice(0, 120);
  return [product, driver.trim(), server && server !== product ? server : ""].filter(Boolean).join(" · ");
}

const ENGINE_NAMES: Record<DbKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mssql: "SQL Server",
  sqlite: "SQLite",
  informix: "Informix",
  odbc: "ODBC",
};

/** The operating system from the webview's user agent ("Windows 10/11", "macOS 14.5", "Linux"). */
export function osFromUserAgent(ua: string): string {
  if (/Windows NT 10\.0/.test(ua)) return "Windows 10/11";
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) return `Windows NT ${win[1]}`;
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  if (mac) return `macOS ${mac[1].replace(/_/g, ".")}`;
  if (/Linux/.test(ua)) return "Linux";
  return "Desconocido";
}

export function environmentText(env: ReportEnv): string {
  return [`Celer: ${env.version || "dev"}`, `Sistema: ${env.os}`, `Tema: ${env.theme}`, `Conexión activa: ${env.engine || "ninguna"}`].join("\n");
}

export interface IssueField {
  /** The id of the field in .github/ISSUE_TEMPLATE/*.yml (GitHub fills a form's fields from the address). */
  id: string;
  /** The field's label in the form, as GitHub shows it. */
  label: string;
  value: string;
}

export interface Issue {
  template: string;
  title: string;
  labels: string[];
  fields: IssueField[];
}

/** User text: their folders (C:\Users\<name>…) and their name go. */
const clean = (text: string, user?: string | null) => scrubPaths(text.trim(), user);

/** The issue a draft becomes: the form, its fields as GitHub will show them, and the labels for triage. */
export function buildIssue(d: ReportDraft, env: ReportEnv, errorsText: string, user?: string | null): Issue {
  const images = d.images.length
    ? `${d.images.length === 1 ? "1 imagen" : `${d.images.length} imágenes`} (Celer las ha copiado y guardado: pégalas o arrástralas aquí).`
    : "";
  if (d.kind === "bug") {
    return {
      template: "bug_report.yml",
      title: clean(d.title, user),
      labels: ["bug", "status:triage"],
      fields: [
        { id: "what", label: "What happened? · Qué ha pasado", value: clean(d.happened, user) },
        { id: "expected", label: "What did you expect? · Qué esperabas", value: clean(d.expected, user) },
        { id: "steps", label: "Steps to reproduce · Pasos para reproducirlo", value: clean(d.steps, user) },
        { id: "version", label: "Celer version · Versión de Celer", value: env.version || "dev" },
        { id: "environment", label: "Environment · Entorno", value: environmentText(env) },
        { id: "logs", label: "Recent errors (error log) · Últimos errores (registro de errores)", value: d.attachErrors ? errorsText.trim() : "" },
        { id: "screenshots", label: "Screenshots · Capturas", value: images },
      ].filter((f) => f.value),
    };
  }
  return {
    template: "feature_request.yml",
    title: clean(d.title, user),
    labels: ["enhancement", "status:triage"],
    fields: [
      { id: "what", label: "What would you like Celer to do? · Qué te gustaría", value: clean(d.what, user) },
      { id: "why", label: "What are you trying to do, and why? · Para qué / por qué", value: clean(d.why, user) },
      { id: "area", label: "Area · Área", value: d.area },
      { id: "version", label: "Celer version · Versión de Celer", value: env.version || "dev" },
      { id: "screenshots", label: "Screenshots · Capturas", value: images },
    ].filter((f) => f.value),
  };
}

/** The whole issue as text: what «Copiar» gives and what the preview shows, field by field. */
export function issueText(issue: Issue): string {
  return [`# ${issue.title}`, `Etiquetas: ${issue.labels.join(", ")}`, ...issue.fields.map((f) => `## ${f.label}\n\n${f.value}`)].join("\n\n");
}

/** GitHub answers 414 past about 8 KB of address: fields are cut to fit, longest first. */
export const MAX_URL = 7500;
const CUT_NOTE = "\n\n… (recortado: el texto completo está en el portapapeles)";

/** The prefilled github.com/…/issues/new address, and the ids of the fields cut to fit it. */
export function issueUrl(issue: Issue, max = MAX_URL): { url: string; cut: string[] } {
  const build = (fields: IssueField[]) => {
    const params = new URLSearchParams({ template: issue.template, title: issue.title, labels: issue.labels.join(",") });
    for (const f of fields) params.set(f.id, f.value);
    return `https://github.com/${REPO}/issues/new?${params.toString()}`;
  };
  const fields = issue.fields.map((f) => ({ ...f }));
  const cut = new Set<string>();
  let url = build(fields);
  while (url.length > max) {
    const longest = fields.reduce((a, b) => (b.value.length > a.value.length ? b : a));
    const over = url.length - max;
    // Encoded text is up to 3× longer (accents 6×): cut a little more than what is over.
    const keep = Math.max(0, longest.value.length - Math.ceil(over / 2) - CUT_NOTE.length - 20);
    longest.value = keep > 0 ? `${longest.value.slice(0, keep)}${CUT_NOTE}` : CUT_NOTE.trim();
    cut.add(longest.id);
    url = build(fields);
    if (fields.every((f) => f.value.length <= CUT_NOTE.length)) break;
  }
  return { url, cut: [...cut] };
}

/** A sent report's link: its issue when known, else a search of the repository for its title. */
export function sentLink(sent: SentReport): string {
  if (sent.issueUrl) return sent.issueUrl;
  return `https://github.com/${REPO}/issues?q=${encodeURIComponent(`is:issue in:title "${sent.title}"`)}`;
}

/** A pasted issue link of this repository ("" when it is not one). */
export function parseIssueUrl(text: string): string {
  const m = new RegExp(`^https://github\\.com/${REPO.replace("/", "\\/")}/issues/(\\d+)\\b`).exec(text.trim());
  return m ? `https://github.com/${REPO}/issues/${m[1]}` : "";
}
