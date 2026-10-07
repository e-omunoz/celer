// Contract with installer/src-tauri. Outside Tauri (vite dev) a simulator stands in, so the UI can be designed in a browser.

export interface SetupInfo {
  version: string;
  defaultDir: string;
  payloadMb: number;
  existing: { dir: string; version: string } | null;
  freeMb: number;
  webview2: boolean;
  isUninstall: boolean;
}

export interface InstallOptions {
  dir: string;
  desktopShortcut: boolean;
  startMenu: boolean;
  associateSql: boolean;
  launchAfter: boolean;
}

export interface Progress {
  step: "prepare" | "extract" | "shortcuts" | "register" | "finish";
  pct: number;
  detail: string;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let simListener: ((p: Progress) => void) | null = null;

async function simulate(steps: Progress["step"][], fail = false) {
  const labels: Record<Progress["step"], string> = {
    prepare: "Preparando la carpeta",
    extract: "Copiando Celer",
    shortcuts: "Creando accesos directos",
    register: "Registrando en Windows",
    finish: "Últimos retoques",
  };
  let pct = 0;
  for (const step of steps) {
    const target = step === "extract" ? pct + 70 : pct + (30 / (steps.length - 1));
    while (pct < Math.min(100, target)) {
      pct = Math.min(100, pct + (step === "extract" ? 1.6 : 4));
      simListener?.({ step, pct, detail: step === "extract" ? `${labels[step]} · ${Math.round(pct * 0.19)} de 19 MB` : labels[step] });
      await sleep(45);
    }
    if (fail && step === "shortcuts") throw new Error("No se pudo crear el acceso directo (simulación)");
  }
  simListener?.({ step: "finish", pct: 100, detail: "Listo" });
}

export const setup = {
  info: (): Promise<SetupInfo> =>
    isTauri()
      ? invoke("setup_info")
      : Promise.resolve({
          version: "1.0.0",
          defaultDir: "C:\\Users\\oscar\\AppData\\Local\\Programs\\Celer",
          payloadMb: 19.2,
          existing: new URLSearchParams(location.search).has("update") ? { dir: "C:\\Users\\oscar\\AppData\\Local\\Programs\\Celer", version: "0.9.0" } : null,
          freeMb: 1520,
          webview2: true,
          isUninstall: new URLSearchParams(location.search).has("uninstall"),
        }),
  driveFree: (dir: string): Promise<number> => (isTauri() ? invoke("drive_free", { dir }) : Promise.resolve(dir.toUpperCase().startsWith("D:") ? 1_714_000 : 1520)),
  pickDir: (current: string): Promise<string | null> => (isTauri() ? invoke("pick_dir", { current }) : Promise.resolve("D:\\Apps\\Celer")),
  install: (options: InstallOptions): Promise<string> =>
    isTauri() ? invoke("install", { options }) : simulate(["prepare", "extract", "shortcuts", "register", "finish"], new URLSearchParams(location.search).has("fail")).then(() => `${options.dir}\\celer.exe`),
  uninstall: (keepData: boolean): Promise<void> => (isTauri() ? invoke("uninstall", { options: { keepData } }) : simulate(["prepare", "shortcuts", "register", "finish"])),
  launch: (path: string): Promise<void> => (isTauri() ? invoke("launch", { path }) : Promise.resolve()),
  quit: (): Promise<void> => (isTauri() ? invoke("quit") : Promise.resolve()),
  onProgress: async (cb: (p: Progress) => void): Promise<() => void> => {
    if (!isTauri()) {
      simListener = cb;
      return () => (simListener = null);
    }
    const { listen } = await import("@tauri-apps/api/event");
    return listen<Progress>("setup-progress", (event) => cb(event.payload));
  },
  showWindow: async () => {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().show();
  },
  minimize: async () => {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  },
};
