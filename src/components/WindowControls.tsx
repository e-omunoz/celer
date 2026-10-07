import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { isTauri } from "../api";
import { beforeClose } from "../state";
import { installOnClose } from "../update";

type AppWindow = Awaited<ReturnType<typeof getWindow>>;

async function getWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Windows 11-style caption buttons drawn by the app, so the title bar matches the theme. */
export function WindowControls() {
  const [maximized, setMaximized] = createSignal(false);
  let win: AppWindow | undefined;

  onMount(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    void getWindow().then(async (w) => {
      win = w;
      setMaximized(await w.isMaximized());
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
      // Covers our button, Alt+F4 and the taskbar: unsaved work is confirmed and the workspace flushed.
      unlistenClose = await w.onCloseRequested(async (event) => {
        if (!(await beforeClose())) event.preventDefault();
        else await installOnClose();
      });
    });
    onCleanup(() => {
      unlisten?.();
      unlistenClose?.();
    });
  });

  return (
    <Show when={isTauri()}>
      <div class="win-controls">
        <button type="button" class="win-btn" title="Minimizar" aria-label="Minimizar" onClick={() => void win?.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1" /></svg>
        </button>
        <button type="button" class="win-btn" title={maximized() ? "Restaurar" : "Maximizar"} aria-label={maximized() ? "Restaurar" : "Maximizar"} onClick={() => void win?.toggleMaximize()}>
          <Show
            when={maximized()}
            fallback={<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1" /></svg>}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
              <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
              <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            </svg>
          </Show>
        </button>
        <button type="button" class="win-btn close" title="Cerrar" aria-label="Cerrar" onClick={() => void win?.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" /></svg>
        </button>
      </div>
    </Show>
  );
}

/** Shows the window once the first frame is painted (it starts hidden to avoid a white flash). */
export function revealWindow() {
  if (!isTauri()) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void getWindow().then((w) => w.show().catch(() => {}));
    }),
  );
}
