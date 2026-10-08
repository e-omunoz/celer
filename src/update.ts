// Updates: checks GitHub for a newer release, downloads Celer Setup (verified against SHA256SUMS in the
// core) and hands over to it. The installer waits for Celer to close, updates in place and reopens it.
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { notify, saveSettings, state } from "./state";
import { confirmQuit } from "./windows";
import type { UpdateInfo } from "./types";

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";

export const [update, setUpdate] = createStore({
  status: "idle" as UpdateStatus,
  info: null as UpdateInfo | null,
  error: "",
  done: 0,
  total: 0,
  path: "",
  dialogOpen: false,
  checkedAt: 0,
});

const FIRST_CHECK_MS = 6_000;
const EVERY_MS = 6 * 60 * 60 * 1000;
let timer = 0;
let listening = false;

/** Background checks after start-up and every few hours (desktop only, unless turned off in Settings). */
export function startUpdateChecks() {
  if (!isTauri() && !new URLSearchParams(location.search).has("update")) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(function tick() {
    if (state.settings.checkUpdates) void checkForUpdates(false);
    timer = window.setTimeout(tick, EVERY_MS);
  }, FIRST_CHECK_MS);
}

/** `manual` opens the dialog with the answer; background checks only speak up when there is something new. */
export async function checkForUpdates(manual: boolean) {
  if (update.status === "checking" || update.status === "downloading" || update.status === "installing") return;
  if (manual) setUpdate({ dialogOpen: true });
  // A download already done in this session stays ready to install.
  if (update.status === "ready" && update.info) return;
  setUpdate({ status: "checking", error: "" });
  try {
    const info = await api().updateCheck();
    setUpdate({ info, status: info.available ? "available" : "current", checkedAt: Date.now() });
    if (info.available && !manual && state.settings.skippedVersion !== info.latest) {
      notify(`Celer ${info.latest} está disponible`, "info", "Tus conexiones y ajustes se conservan.", {
        label: "Ver novedades",
        run: () => setUpdate({ dialogOpen: true }),
      });
    }
  } catch (err) {
    setUpdate({ status: manual ? "error" : "idle", error: errorText(err) });
  }
}

export async function downloadUpdate() {
  const info = update.info;
  if (!info?.available) return;
  if (!info.assetUrl) {
    // A release without Celer Setup: send the user to the release page.
    await openReleasePage();
    return;
  }
  if (!listening) {
    listening = true;
    void api().onUpdateDownload((p) => setUpdate({ done: p.done, total: p.total || info.assetSize }));
  }
  setUpdate({ status: "downloading", done: 0, total: info.assetSize, error: "" });
  try {
    const path = await api().updateDownload(info.assetUrl, info.assetName, info.sumsUrl);
    setUpdate({ status: "ready", path, done: update.total });
  } catch (err) {
    setUpdate({ status: "error", error: errorText(err) });
  }
}

/** Closes Celer through the usual guard (open transactions, unsaved edits, in every window) and runs the installer. */
export async function installUpdate() {
  if (update.status !== "ready" || !update.path) return;
  if (!(await confirmQuit())) return;
  setUpdate({ status: "installing" });
  try {
    await api().updateInstall(update.path, true);
  } catch (err) {
    setUpdate({ status: "error", error: errorText(err) });
  }
}

/** Closing Celer with an update downloaded installs it silently (Celer is not reopened). */
export async function installOnClose() {
  if (update.status !== "ready" || !update.path) return;
  await api().updateInstall(update.path, false).catch(() => {});
}

export async function skipVersion() {
  if (update.info) await saveSettings({ skippedVersion: update.info.latest });
  setUpdate({ dialogOpen: false });
}

export async function openReleasePage() {
  const url = update.info?.htmlUrl || "https://github.com/e-omunoz/celer/releases/latest";
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

/** The status bar shows a chip while there is something to do (and the version was not skipped). */
export function updateChipVisible() {
  const s = update.status;
  if (s === "downloading" || s === "ready" || s === "installing") return true;
  return s === "available" && update.info?.latest !== state.settings.skippedVersion;
}

export function formatMb(bytes: number) {
  return `${(bytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}
