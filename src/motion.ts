// Motion shared by every component: durations read from the motion tokens in App.css (scaled by the theme's
// animation speed and cut short by Animaciones › Reducidas), the exit of an element that is being removed, and
// list items that glide to their new place (tabs, toasts).

import { createComputed, createEffect, on, onCleanup } from "solid-js";

/** Animaciones › Reducidas, or the system's wish when the setting follows it (state.ts sets data-motion). */
export function motionReduced(): boolean {
  const motion = document.documentElement.dataset.motion;
  if (motion) return motion === "reduce";
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function tokenNumber(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A duration for a script-driven animation, as the CSS ones get it: × the theme's speed, short when reduced. */
export function motionMs(ms: number): number {
  if (motionReduced()) return Math.min(ms, 60);
  return Math.round(ms * tokenNumber("--motion-scale", 1));
}

/** Gib's own tempo (--motion-gib): his flights and acts are timed with the companion's script. */
export function gibMs(ms: number): number {
  return Math.round(ms * tokenNumber("--motion-gib", 1));
}

/** The named motion tokens in ms (for scripts): fast 100, normal 160, slow 220 at normal speed. */
export const MOTION = { instant: 60, fast: 100, normal: 160, slow: 220, slower: 360 } as const;

export type LeaveKind = "dialog" | "scrim" | "menu" | "palette" | "toast" | "panel-left" | "panel-right" | "tab" | "popover";

/**
 * Plays the exit of `el`, which is about to leave the DOM (call it from onCleanup, while it is still there): a
 * copy takes its exact place, inert, and fades/slides out with the token durations (App.css, `[data-leave]`), then
 * goes. Nothing with reduced motion.
 */
export function leaveAnimation(el: Element | undefined | null, kind: LeaveKind) {
  if (!(el instanceof HTMLElement) || !el.isConnected || motionReduced()) return;
  const parent = el.parentNode;
  const rect = el.getBoundingClientRect();
  if (!parent || rect.width === 0 || rect.height === 0) return;
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  delete ghost.dataset.flip;
  ghost.inert = true;
  ghost.dataset.leave = kind;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    transform: "none",
    pointerEvents: "none",
    zIndex: getComputedStyle(el).zIndex === "auto" ? "50" : getComputedStyle(el).zIndex,
  });
  parent.insertBefore(ghost, el.nextSibling);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    ghost.remove();
  };
  ghost.addEventListener("animationend", (event) => event.target === ghost && remove());
  // Never left behind (a background window pauses animations; the event may not come).
  window.setTimeout(remove, motionMs(MOTION.slow) + 200);
}

/** A ref that plays the element's exit when its owner goes (a dialog closed, a menu dismissed…). */
export function leaveOnCleanup(kind: LeaveKind) {
  return (el: HTMLElement) => onCleanup(() => leaveAnimation(el, kind));
}

/**
 * The items of a list glide from where they were to where they are when the list changes (FLIP): a tab closed or
 * moved, a toast gone. `items` returns the elements now in the list, each with a stable `data-flip` key; `deps` is
 * what changes the list. New items keep their own entrance animation.
 */
export function flipList(items: () => HTMLElement[], deps: () => unknown) {
  let first = new Map<string, DOMRect>();
  // Before the DOM updates (computations run ahead of the render): where everything is now.
  createComputed(
    on(deps, () => {
      first = new Map();
      for (const el of items()) if (el.dataset.flip) first.set(el.dataset.flip, el.getBoundingClientRect());
    }),
  );
  let running: Animation[] = [];
  createEffect(
    on(
      deps,
      () => {
        if (motionReduced()) return;
        for (const animation of running) animation.cancel();
        running = [];
        for (const el of items()) {
          const before = el.dataset.flip ? first.get(el.dataset.flip) : undefined;
          if (!before) continue;
          const now = el.getBoundingClientRect();
          const dx = before.left - now.left;
          const dy = before.top - now.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          running.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: motionMs(MOTION.normal), easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }));
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => running.forEach((animation) => animation.cancel()));
}
