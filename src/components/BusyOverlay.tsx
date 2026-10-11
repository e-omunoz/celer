import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { busy, cancelBusy } from "../busy";
import { gibShows } from "../state";
import { Gib } from "../gib/Gib";

const SHOW_AFTER_MS = 300;

/** Covers the grid while a long operation runs: Gib at work, live progress and a Cancel button. */
export function BusyOverlay(props: { tabId: string }) {
  const info = () => busy[props.tabId];
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    onCleanup(() => window.clearInterval(timer));
  });
  const elapsed = () => (info() ? now() - info()!.startedAt : 0);
  const visible = () => Boolean(info()) && elapsed() >= SHOW_AFTER_MS;
  const pct = () => {
    const b = info();
    return b?.total ? Math.min(100, (b.done / b.total) * 100) : null;
  };
  const seconds = () => {
    const s = elapsed() / 1000;
    return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  };

  return (
    <Show when={visible()}>
      <div class="busy-overlay" role="status" aria-live="polite">
        <div class="busy-card">
          <Show when={gibShows("overlays")}><Gib size={84} pose="laptop" mood="busy" plain /></Show>
          <div class="busy-body">
            <b>{info()!.title}</b>
            <span class="busy-detail">
              <Show when={info()!.done > 0}>{info()!.done.toLocaleString()} filas · </Show>
              {seconds()}
              <Show when={info()!.detail}> · {info()!.detail}</Show>
            </span>
            <div class="busy-track" classList={{ indeterminate: pct() === null }}>
              <div class="busy-fill" style={{ transform: pct() === null ? undefined : `translateX(${pct()! - 100}%)` }} />
            </div>
          </div>
          <Show when={info()!.cancel}>
            <button type="button" class="btn" disabled={info()!.cancelling} onClick={() => cancelBusy(props.tabId)}>
              {info()!.cancelling ? "Cancelando…" : "Cancelar"}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}
