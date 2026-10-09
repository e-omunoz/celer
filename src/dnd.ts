// Drag and drop feedback shared by the explorer, the library and the tabs: the same ghost card under the pointer
// (the browser's drag image, which also follows the pointer out of the window), with the look of App.css
// (`.dnd-ghost`). The places to drop on use the shared classes and --dnd-* tokens.

export interface GhostContent {
  title: string;
  /** A second line: the kind of thing, a count, a connection. */
  detail?: string;
  /** A few lines of what it holds (a console's SQL), in the editor's font. */
  preview?: string;
  /** A colour for the strip on the left (a connection's colour). */
  color?: string;
}

/** The card itself (also drawn by the tabs' own ghost, src/components/Workspace.tsx). */
export function ghostCard(content: GhostContent): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "dnd-ghost";
  if (content.color) card.style.setProperty("--ghost-color", content.color);
  const title = document.createElement("b");
  title.textContent = content.title;
  card.appendChild(title);
  if (content.detail) {
    const detail = document.createElement("small");
    detail.textContent = content.detail;
    card.appendChild(detail);
  }
  if (content.preview) {
    const preview = document.createElement("pre");
    preview.textContent = previewLines(content.preview);
    card.appendChild(preview);
  }
  return card;
}

/** The first non-empty lines of a text, trimmed for a small preview. */
export function previewLines(text: string, lines = 4, width = 48): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim())
    .slice(0, lines)
    .map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
    .join("\n");
}

/**
 * Uses the ghost card as the drag image of `event` (dragstart). The browser takes a picture of it at once, so it
 * is built out of sight and removed right after.
 */
export function setDragGhost(event: DragEvent, content: GhostContent) {
  const transfer = event.dataTransfer;
  if (!transfer || typeof transfer.setDragImage !== "function") return;
  const card = ghostCard(content);
  card.classList.add("offscreen");
  document.body.appendChild(card);
  transfer.setDragImage(card, 16, 16);
  window.setTimeout(() => card.remove(), 0);
}

/** An image the size of nothing: the drag shows Celer's own ghost instead of the browser's picture (the tabs). */
export function hideDragImage(event: DragEvent) {
  const transfer = event.dataTransfer;
  if (!transfer || typeof transfer.setDragImage !== "function") return;
  const blank = document.createElement("div");
  blank.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0.01";
  document.body.appendChild(blank);
  transfer.setDragImage(blank, 0, 0);
  window.setTimeout(() => blank.remove(), 0);
}

/** "3 conexiones y 1 carpeta"-style count for a ghost's detail. */
export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
