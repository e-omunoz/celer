// «Capturar la ventana» (reportStore.ts): the window as a PNG, as the user sees it. html-to-image's toPng clones the
// page into an SVG, and a clone has no scroll offsets: a scrolled explorer (a virtual list, its rows far below the
// top) came out empty, and a scrolled editor or grid showed their top. This runs html-to-image's own steps (as its
// toCanvas does) and, between cloning and drawing, moves the children of every scrolled element back by its scroll,
// and every sticky element inside by how far it is stuck, so the clone draws what is on screen.
import { cloneNode } from "html-to-image/es/clone-node";
import { embedImages } from "html-to-image/es/embed-images";
import { applyStyle } from "html-to-image/es/apply-style";
import { embedWebFonts } from "html-to-image/es/embed-webfonts";
import { checkCanvasDimensions, createImage, getImageSize, nodeToDataURL } from "html-to-image/es/util";
import type { Options } from "html-to-image/es/types";

type Shift = [x: number, y: number];

/** How far each element must move in the clone: by its scrolled parent's offset, and back by how far it is stuck. */
export function scrollShifts(root: HTMLElement): Map<Element, Shift> {
  const shifts = new Map<Element, Shift>();
  const add = (el: Element, x: number, y: number) => {
    const s = shifts.get(el) ?? [0, 0];
    shifts.set(el, [s[0] + x, s[1] + y]);
  };
  const stuck = new Set<HTMLElement>();
  for (const box of root.querySelectorAll<HTMLElement>("*")) {
    const { scrollLeft: left, scrollTop: top } = box;
    if (!left && !top) continue;
    for (const child of box.children) add(child, -left, -top);
    for (const el of box.querySelectorAll<HTMLElement>("*")) {
      if (stuck.has(el) || getComputedStyle(el).position !== "sticky") continue;
      stuck.add(el);
      // Where it is against where it would be unstuck; set and put back in the same task, so nothing is painted.
      const at = el.getBoundingClientRect();
      const before = el.style.position;
      el.style.position = "static";
      const free = el.getBoundingClientRect();
      el.style.position = before;
      // At the clone's scroll 0 it sits where it would be unstuck, and its scrolled ancestors move it back by
      // their scroll: this puts it where it is stuck.
      add(el, at.left - free.left, at.top - free.top);
    }
  }
  return shifts;
}

/** Applies the shifts to the clone, walking it alongside the page (the filter's choices say which child is which). */
function shiftClone(node: Node, clone: Node, shifts: Map<Element, Shift>, kept: WeakSet<Node>) {
  if (node instanceof Element && shifts.has(node) && clone instanceof Element) {
    const [x, y] = shifts.get(node)!;
    if (x || y) (clone as HTMLElement).style.translate = `${x}px ${y}px`;
  }
  // An SVG is cloned whole and a canvas, video or iframe becomes an image: nothing inside to walk.
  if (!(node instanceof HTMLElement) || node instanceof HTMLCanvasElement || node instanceof HTMLVideoElement || node instanceof HTMLIFrameElement) return;
  let index = 0;
  for (const child of node.childNodes) {
    if (!kept.has(child)) continue;
    const twin = clone.childNodes[index++];
    if (!twin) return;
    shiftClone(child, twin, shifts, kept);
  }
}

/** toPng with the page's scroll offsets kept. */
export async function captureToPng(root: HTMLElement, options: Options): Promise<string> {
  const shifts = scrollShifts(root);
  const kept = new WeakSet<Node>();
  const filter = options.filter;
  const opts: Options = {
    ...options,
    filter: (node) => {
      const keep = !filter || filter(node);
      if (keep) kept.add(node);
      return keep;
    },
  };
  const { width, height } = getImageSize(root, opts);
  const clone = (await cloneNode(root, opts, true)) as HTMLElement;
  if (shifts.size) shiftClone(root, clone, shifts, kept);
  await embedWebFonts(clone, opts);
  await embedImages(clone, opts);
  applyStyle(clone, opts);
  const img = await createImage(await nodeToDataURL(clone, width, height));
  const canvas = document.createElement("canvas");
  const ratio = opts.pixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  if (!opts.skipAutoScale) checkCanvasDimensions(canvas);
  const context = canvas.getContext("2d")!;
  if (opts.backgroundColor) {
    context.fillStyle = opts.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}
