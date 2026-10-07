import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// UI of "Celer Setup". Shares tokens, fonts and Gib with the app (../src); built into installer/dist.
export default defineConfig({
  root: here("./ui"),
  base: "./",
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1430, strictPort: true, fs: { allow: [here("..")] } },
  build: { outDir: here("./dist"), emptyOutDir: true, target: "es2020", chunkSizeWarningLimit: 900 },
});
