/**
 * Gives the focus back to `opener` (what had it before a dialog or the palette opened) once the overlay is gone,
 * unless something else took it meanwhile: the editor and grid shortcuts need it, and <body> takes none.
 */
export function returnFocus(opener: Element | null) {
  if (!(opener instanceof HTMLElement) || opener === document.body) return;
  queueMicrotask(() => {
    const now = document.activeElement;
    if (now && now !== document.body) return;
    if (opener.isConnected) opener.focus({ preventScroll: true });
  });
}
