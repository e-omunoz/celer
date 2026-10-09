import { ArrowUpRight, EyeOff, Square, Undo2 } from "lucide-solid";
import { createSignal, onMount } from "solid-js";

type Tool = "rect" | "arrow" | "hide";
interface Mark {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Pixels of one block when hiding: big enough that text under it cannot be read back. */
const BLOCK = 14;

/**
 * Marks on a report's image before it is sent: a rectangle or an arrow to point at something, and «Ocultar» to
 * pixelate what must not be seen (done on the pixels themselves, so it cannot be undone from the image).
 */
export function ImageAnnotator(props: { src: string; onDone: (dataUrl: string) => void; onCancel: () => void }) {
  let canvas: HTMLCanvasElement | undefined;
  const [tool, setTool] = createSignal<Tool>("rect");
  const [marks, setMarks] = createSignal<Mark[]>([]);
  let base: HTMLImageElement | null = null;
  let drawing: Mark | null = null;

  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "#e5484d";

  function paint(extra: Mark | null = null) {
    const ctx = canvas?.getContext("2d");
    if (!ctx || !base || !canvas) return;
    ctx.drawImage(base, 0, 0);
    for (const m of extra ? [...marks(), extra] : marks()) draw(ctx, m);
  }

  function draw(ctx: CanvasRenderingContext2D, m: Mark) {
    const x = Math.min(m.x1, m.x2);
    const y = Math.min(m.y1, m.y2);
    const w = Math.abs(m.x2 - m.x1);
    const h = Math.abs(m.y2 - m.y1);
    const line = Math.max(3, Math.round((canvas?.width ?? 1000) / 400));
    if (m.tool === "hide") {
      if (w < 2 || h < 2) return;
      const data = ctx.getImageData(x, y, w, h);
      for (let by = 0; by < h; by += BLOCK) {
        for (let bx = 0; bx < w; bx += BLOCK) {
          const i = (by * w + bx) * 4;
          ctx.fillStyle = `rgb(${data.data[i]}, ${data.data[i + 1]}, ${data.data[i + 2]})`;
          ctx.fillRect(x + bx, y + by, Math.min(BLOCK, w - bx), Math.min(BLOCK, h - by));
        }
      }
      return;
    }
    ctx.strokeStyle = accent();
    ctx.fillStyle = accent();
    ctx.lineWidth = line;
    ctx.lineCap = "round";
    if (m.tool === "rect") {
      ctx.strokeRect(x, y, w, h);
      return;
    }
    const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
    const head = line * 5;
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2 - Math.cos(angle) * head * 0.6, m.y2 - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x2, m.y2);
    ctx.lineTo(m.x2 - head * Math.cos(angle - Math.PI / 7), m.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(m.x2 - head * Math.cos(angle + Math.PI / 7), m.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  const point = (event: PointerEvent) => {
    const r = canvas!.getBoundingClientRect();
    return { x: Math.round(((event.clientX - r.left) / r.width) * canvas!.width), y: Math.round(((event.clientY - r.top) / r.height) * canvas!.height) };
  };

  onMount(() => {
    const img = new Image();
    img.onload = () => {
      base = img;
      canvas!.width = img.naturalWidth;
      canvas!.height = img.naturalHeight;
      paint();
    };
    img.src = props.src;
  });

  return (
    <div class="annotator">
      <div class="annotator-tools">
        <div class="seg">
          <button type="button" classList={{ on: tool() === "rect" }} onClick={() => setTool("rect")} title="Rodear con un rectángulo"><Square size={13} /> Rectángulo</button>
          <button type="button" classList={{ on: tool() === "arrow" }} onClick={() => setTool("arrow")} title="Señalar con una flecha"><ArrowUpRight size={13} /> Flecha</button>
          <button type="button" classList={{ on: tool() === "hide" }} onClick={() => setTool("hide")} title="Pixelar una zona para que no se lea"><EyeOff size={13} /> Ocultar</button>
        </div>
        <button type="button" class="btn tiny" disabled={!marks().length} onClick={() => { setMarks(marks().slice(0, -1)); paint(); }}><Undo2 size={12} /> Deshacer</button>
        <span class="spacer" />
        <button type="button" class="btn tiny" onClick={props.onCancel}>Cancelar</button>
        <button type="button" class="btn tiny primary" onClick={() => { paint(); props.onDone(canvas!.toDataURL("image/png")); }}>Aplicar</button>
      </div>
      <div class="annotator-canvas">
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            const p = point(event);
            drawing = { tool: tool(), x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            canvas!.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drawing) return;
            const p = point(event);
            drawing = { ...drawing, x2: p.x, y2: p.y };
            paint(drawing);
          }}
          onPointerUp={() => {
            if (drawing && (Math.abs(drawing.x2 - drawing.x1) > 3 || Math.abs(drawing.y2 - drawing.y1) > 3)) setMarks([...marks(), drawing]);
            drawing = null;
            paint();
          }}
        />
      </div>
      <p class="muted small">«Ocultar» pixela la zona en la propia imagen: lo que había debajo no se puede recuperar.</p>
    </div>
  );
}
