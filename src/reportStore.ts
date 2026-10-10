// The report window's state (#112): the draft being written, the drafts kept offline and «Mis reportes», in
// reports.json in the data folder. Sending is opening a prefilled github.com issue page: nothing leaves Celer before
// the user presses «Abrir en GitHub» after the preview, and even then the issue is created by them on GitHub.
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { entriesText, type ErrorEntry } from "./errorLogText";
import { latestErrors, onUnexpectedError } from "./errorLog";
import {
  ATTACHED_ERRORS,
  blankDraft,
  buildIssue,
  draftIsEmpty,
  engineLine,
  issueText,
  issueUrl,
  osFromUserAgent,
  type ReportDraft,
  type ReportEnv,
  type ReportImage,
  type ReportKind,
  type SentReport,
} from "./report";
import { activeTab, connectionById, copyText, notify, resolvedTheme, revealPath, state, uid } from "./state";
import { themeChoices } from "./commands";
import { scrubText } from "./scrub";

export type ReportView = "form" | "preview" | "sent" | "mine";

export const [report, setReport] = createStore({
  open: false,
  view: "form" as ReportView,
  draft: blankDraft("bug", "") as ReportDraft,
  drafts: [] as ReportDraft[],
  sent: [] as SentReport[],
  /** The newest entries of the error log, as the preview shows them before they are attached. */
  errors: [] as ErrorEntry[],
  /** The report just opened on GitHub (its paths and what was copied), for the «sent» view. */
  last: null as { sent: SentReport; images: string[]; copied: "text" | "image" | ""; cut: string[] } | null,
  /** The window hides itself while a screenshot is taken. */
  capturing: false,
  loaded: false,
});

interface ReportsFile {
  drafts?: ReportDraft[];
  sent?: SentReport[];
}

async function load() {
  try {
    const file = ((await api().loadJson("reports")) ?? {}) as ReportsFile;
    setReport({ drafts: Array.isArray(file.drafts) ? file.drafts : [], sent: Array.isArray(file.sent) ? file.sent : [], loaded: true });
  } catch (err) {
    setReport("loaded", true);
    notify("No se pudieron leer los reportes guardados", "error", errorText(err));
  }
}

let saveTimer = 0;
/** Drafts and «Mis reportes» to reports.json, a moment after the last change. */
function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 800);
}

async function saveNow() {
  window.clearTimeout(saveTimer);
  const file: ReportsFile = { drafts: report.drafts, sent: report.sent };
  await api()
    .saveJson("reports", file)
    .catch((err) => notify("No se pudo guardar el borrador del reporte", "error", errorText(err)));
}

/** The draft on screen into the kept drafts (or out of them when it is empty). */
function keepDraft() {
  const d = report.draft;
  const others = report.drafts.filter((x) => x.id !== d.id);
  setReport("drafts", draftIsEmpty(d) ? others : [{ ...d, updatedAt: Date.now() }, ...others]);
  saveSoon();
}

/** «Reportar un fallo» / «Sugerir una mejora»: the newest draft of that kind, or a new one. */
export async function openReport(kind: ReportKind, opts: { attachErrors?: boolean } = {}) {
  if (!report.loaded) await load();
  const kept = report.drafts.find((d) => d.kind === kind);
  const draft = kept ? { ...kept } : blankDraft(kind, uid());
  if (opts.attachErrors) draft.attachErrors = true;
  setReport({ open: true, view: "form", draft, last: null });
  void refreshErrors();
}

/** «Mis reportes»: the drafts and the reports opened on GitHub. */
export async function openMyReports() {
  if (!report.loaded) await load();
  setReport({ open: true, view: "mine", last: null });
}

export function closeReport() {
  if (report.view === "form" || report.view === "preview") keepDraft();
  void saveNow();
  setReport({ open: false, capturing: false });
}

export function editDraft(patch: Partial<ReportDraft>) {
  setReport("draft", (d) => ({ ...d, ...patch, updatedAt: Date.now() }));
  keepDraft();
}

export function resumeDraft(id: string) {
  const d = report.drafts.find((x) => x.id === id);
  if (d) setReport({ draft: { ...d }, view: "form" });
  void refreshErrors();
}

export function deleteDraft(id: string) {
  setReport("drafts", (list) => list.filter((d) => d.id !== id));
  if (report.draft.id === id) setReport("draft", blankDraft(report.draft.kind, uid()));
  saveSoon();
}

/** Switch between a bug and an idea: the text typed stays in its own draft. */
export function switchKind(kind: ReportKind) {
  if (report.draft.kind === kind) return;
  keepDraft();
  const kept = report.drafts.find((d) => d.kind === kind && d.id !== report.draft.id);
  setReport("draft", kept ? { ...kept } : blankDraft(kind, uid()));
}

export async function refreshErrors() {
  setReport("errors", await latestErrors(ATTACHED_ERRORS));
}

// ---------------------------------------------------------------- what the report says

/** Version, system, theme and the active connection's engine and driver: never a host, a user or data. */
export function reportEnv(): ReportEnv {
  const tab = activeTab();
  const conn = connectionById(tab?.connId);
  const session = conn ? state.sessions[conn.id] : undefined;
  const theme = themeChoices.find((t) => t.id === state.settings.theme)?.label ?? state.settings.theme;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = [osFromUserAgent(ua), state.appInfo.os ? `(${state.appInfo.os})` : ""].filter(Boolean).join(" ");
  return {
    version: state.appInfo.version || "dev",
    os,
    theme: state.settings.theme === "system" ? `${theme} (${resolvedTheme()})` : theme,
    engine: conn && session ? engineLine(conn.kind, session.serverInfo, session.driver ?? "") : conn ? `${engineLine(conn.kind, "", "")} (sin conectar)` : "",
  };
}

/** The issue as it will be opened: what the preview shows, field by field. */
export function currentIssue() {
  const user = userName();
  return buildIssue(report.draft, reportEnv(), entriesText(report.errors.map((e) => ({ ...e, message: scrubText(e.message, user), stack: "" }))), user);
}

/** The user's name as the data folder shows it (C:\Users\<name>\…, /home/<name>/…), to scrub it from what they wrote. */
function userName(): string | null {
  const m = /[\\/](?:users|home)[\\/]([^\\/]+)/i.exec(state.appInfo.dataDir);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- images

const MAX_IMAGES = 6;

export function addImage(image: Omit<ReportImage, "id">) {
  if (report.draft.images.length >= MAX_IMAGES) {
    notify(`Como mucho ${MAX_IMAGES} imágenes por reporte`, "warning");
    return;
  }
  editDraft({ images: [...report.draft.images, { ...image, id: uid() }] });
}

export function replaceImage(id: string, dataUrl: string) {
  editDraft({ images: report.draft.images.map((img) => (img.id === id ? { ...img, dataUrl } : img)) });
}

export function removeImage(id: string) {
  editDraft({ images: report.draft.images.filter((img) => img.id !== id) });
}

/** An image file (pasted or dropped) as a PNG data URL, at most 2000 px wide. */
export async function imageFromFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("No es una imagen"));
      el.src = url;
    });
    const scale = Math.min(1, 2000 / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** «Capturar la ventana»: this window as it is under the report (which hides for the moment it takes). */
export async function captureWindow() {
  const root = document.querySelector<HTMLElement>(".app");
  if (!root) return;
  setReport("capturing", true);
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { toPng } = await import("html-to-image");
    const bg = getComputedStyle(document.body).backgroundColor;
    // Hidden tabs (and their editors) are left out: with 20 tabs open the serialised page was 42 MB and failed to load.
    const filter = (node: Node) => !(node instanceof HTMLElement) || (node.hidden === false && getComputedStyle(node).display !== "none");
    const options = { backgroundColor: bg, cacheBust: true, filter };
    let dataUrl: string;
    try {
      dataUrl = await toPng(root, { ...options, pixelRatio: Math.min(2, window.devicePixelRatio || 1) });
    } catch {
      dataUrl = await toPng(root, { ...options, pixelRatio: 1 });
    }
    addImage({ name: `captura-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`, dataUrl });
  } catch (err) {
    notify("No se pudo capturar la ventana", "error", errorText(err));
  } finally {
    setReport("capturing", false);
  }
}

// ---------------------------------------------------------------- sending

/**
 * «Abrir en GitHub»: the images saved (and the first one copied, or the whole text when the address had to cut it),
 * the prefilled issue page opened, and the report moved to «Mis reportes».
 */
export async function sendReport() {
  const d = report.draft;
  const issue = currentIssue();
  const { url, cut } = issueUrl(issue);
  let images: string[] = [];
  let copied: "text" | "image" | "" = "";
  try {
    if (d.images.length) images = await api().reportSaveImages(d.id, d.images.map((img) => [img.name, img.dataUrl]));
  } catch (err) {
    notify("No se pudieron guardar las imágenes", "error", errorText(err));
  }
  if (cut.length) {
    await copyText(issueText(issue), "Texto completo del reporte copiado");
    copied = "text";
  } else if (d.images.length && (await copyImage(d.images[0].dataUrl))) copied = "image";
  try {
    if (isTauri()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else window.open(url, "_blank", "noopener");
  } catch (err) {
    notify("No se pudo abrir GitHub", "error", errorText(err));
    return;
  }
  const sent: SentReport = { id: d.id, kind: d.kind, title: issue.title, at: Date.now(), issueUrl: "" };
  setReport({
    sent: [sent, ...report.sent.filter((s) => s.id !== sent.id)],
    drafts: report.drafts.filter((x) => x.id !== d.id),
    draft: blankDraft(d.kind, uid()),
    view: "sent",
    last: { sent, images, copied, cut },
  });
  await saveNow();
  if (images.length && isTauri()) void revealPath(images[0]);
}

/** A PNG on the clipboard (to paste it into the GitHub page); false where the webview does not allow it. */
async function copyImage(dataUrl: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** «Mis reportes»: the issue's address, once the user pastes it. */
export function setSentLink(id: string, issueUrl: string) {
  setReport("sent", (list) => list.map((s) => (s.id === id ? { ...s, issueUrl } : s)));
  if (report.last?.sent.id === id) setReport("last", "sent", "issueUrl", issueUrl);
  saveSoon();
}

export function forgetSent(id: string) {
  setReport("sent", (list) => list.filter((s) => s.id !== id));
  saveSoon();
}

// After an unexpected error the notice offers to report it, with the last errors attached (shown before sending).
onUnexpectedError({ label: "Reportar…", run: () => void openReport("bug", { attachErrors: true }) });
