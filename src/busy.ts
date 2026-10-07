// Long operations per tab (load all, server reloads, big local sorts): what the busy overlay shows and
// how to cancel it. The overlay appears only after a short delay so quick operations don't flicker.
import { createStore } from "solid-js/store";

export interface Busy {
  title: string;
  detail: string;
  /** Rows (or items) done so far, and the total when known. */
  done: number;
  total: number | null;
  startedAt: number;
  /** Null while the operation can't be interrupted (e.g. a local sort). */
  cancel: (() => void) | null;
  cancelling: boolean;
}

export const [busy, setBusy] = createStore<Record<string, Busy | undefined>>({});

export function startBusy(tabId: string, title: string, cancel: (() => void) | null, total: number | null = null) {
  setBusy(tabId, { title, detail: "", done: 0, total, startedAt: Date.now(), cancel, cancelling: false });
}

export function updateBusy(tabId: string, patch: Partial<Busy>) {
  if (busy[tabId]) setBusy(tabId, patch);
}

export function endBusy(tabId: string) {
  setBusy(tabId, undefined);
}

export function cancelBusy(tabId: string) {
  const current = busy[tabId];
  if (!current?.cancel || current.cancelling) return;
  setBusy(tabId, "cancelling", true);
  current.cancel();
}

/** Lets the browser paint (e.g. the overlay) before a synchronous chunk of work starts. */
export function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
