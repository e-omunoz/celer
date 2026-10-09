// One-time hints about a feature that is easy to miss (tearing a tab off into its own window): Gib says it, or a
// notice when he is off. Remembered on this computer (localStorage, shared by every window), so it comes once.

import { gib, notify, state } from "./state";

const KEY = "celer.hints";

function seen(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Says `text` the first time `id` comes up; false when it was already said. */
export function hintOnce(id: string, text: string): boolean {
  const done = seen();
  if (done.includes(id)) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify([...done, id]));
  } catch {
    // Storage unavailable: it may come again another day.
  }
  if (state.settings.companion === "off") notify(text, "info");
  else gib("hint", { detail: text });
  return true;
}
