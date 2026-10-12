// One-time hints about a feature that is easy to miss (tearing a tab off into its own window): Gib says it, or a
// notice when he is off. Remembered on this computer (localStorage, shared by every window), so it comes once.

import { gib, gibShows, notify } from "./state";
import { gibHere } from "./windows";

/** This window can say a hint now: Gib is in it, or he is off (a notice here). Reactive. */
export function hintReady(): boolean {
  return !gibShows("companion") || gibHere();
}

const KEY = "celer.hints";

function seen(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Says `text` the first time `id` comes up; false when it was already said, or when Gib is in another window: a
 * hint is about this window, so it waits until he is here (hintReady()) instead of being said somewhere else.
 */
export function hintOnce(id: string, text: string): boolean {
  const done = seen();
  if (done.includes(id) || !hintReady()) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify([...done, id]));
  } catch {
    // Storage unavailable: it may come again another day.
  }
  if (!gibShows("companion")) notify(text, "info");
  else gib("hint", { detail: text });
  return true;
}
