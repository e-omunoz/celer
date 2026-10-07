// Encodes captured frames into an animated GIF (used by dev/readme-media.mjs).
// Needs gifenc, pngjs and jpeg-js; they are not project dependencies, install them once elsewhere:
//   npm install --prefix "%TEMP%\celer-gif-tools" gifenc pngjs jpeg-js
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const tools = process.env.CELER_GIF_TOOLS || join(process.env.TEMP || "/tmp", "celer-gif-tools", "node_modules");
const require = createRequire(join(tools, "noop.js"));
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");

/** Decodes a PNG or JPEG buffer to { width, height, data: RGBA }. */
export function decode(buffer) {
  if (buffer[0] === 0x89) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * frames: [{ image: Buffer, delay: ms }]. Consecutive identical frames are merged; one palette is
 * built from a sample of every frame so flat UI colours stay stable between frames.
 */
export function writeGif(path, frames, { colors = 256, loop = 0 } = {}) {
  const decoded = frames.map((f) => ({ ...decode(f.image), delay: f.delay }));
  const merged = [];
  for (const frame of decoded) {
    const last = merged[merged.length - 1];
    if (last && Buffer.compare(Buffer.from(last.data.buffer, last.data.byteOffset, last.data.length), Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length)) === 0) last.delay += frame.delay;
    else merged.push(frame);
  }
  // Palette from a strided sample of all frames.
  const { width, height } = merged[0];
  const stride = Math.max(1, Math.floor(merged.length / 24));
  const samples = merged.filter((_, i) => i % stride === 0);
  const pick = new Uint8Array(samples.length * width * Math.ceil(height / 4) * 4);
  let o = 0;
  for (const s of samples) for (let y = 0; y < height; y += 4) { pick.set(s.data.subarray(y * width * 4, (y + 1) * width * 4), o); o += width * 4; }
  const palette = quantize(pick.subarray(0, o), colors, { format: "rgb565" });
  const gif = GIFEncoder();
  merged.forEach((frame, i) => {
    const index = applyPalette(frame.data, palette, "rgb565");
    gif.writeFrame(index, width, height, i === 0 ? { palette, delay: frame.delay, repeat: loop } : { delay: frame.delay });
  });
  gif.finish();
  writeFileSync(path, gif.bytes());
  return { frames: merged.length, bytes: gif.bytes().length };
}
