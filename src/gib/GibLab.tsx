// Development only (http://localhost:1420/#giblab): every mood and idle activity of Gib, big and looping, to review
// the animations by eye or capture them (dev/gib-lab-shots.mjs). Not part of the production bundle.
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Gib, type GibActivity, type GibMood } from "./Gib";

const ACTIVITIES: [GibActivity, number][] = [
  ["yawn", 3400],
  ["coffee-out", 1600],
  ["coffee-away", 5000],
  ["coffee-in", 1600],
  ["coffee-sip", 6400],
  ["coffee-done", 1200],
  ["laptop", 8000],
  ["doze", 5500],
  ["juggle", 5600],
  ["read", 8000],
  ["dance", 4800],
  ["scratch", 3600],
  ["bug", 6000],
];
const MOODS: GibMood[] = ["idle", "annoyed", "grumpy", "wave", "think", "idea", "happy", "ok", "love", "error", "sad", "sleep"];

/** Restarts an activity every `ms` (+ a short rest) so its CSS animations replay from the start. */
function Looping(props: { activity: GibActivity; ms: number; size: number; paused: boolean }) {
  const [on, setOn] = createSignal(true);
  let timer = 0;
  const cycle = () => {
    setOn(true);
    timer = window.setTimeout(() => {
      setOn(false);
      timer = window.setTimeout(cycle, 600);
    }, props.ms);
  };
  onMount(() => {
    if (!props.paused) cycle();
  });
  onCleanup(() => window.clearTimeout(timer));
  return <Gib size={props.size} pose="poker" activity={on() ? props.activity : null} />;
}

export function GibLab() {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const size = Number(params.get("size") ?? 150);
  const only = params.get("only");
  const side = params.get("side");
  return (
    <div class="giblab" style={{ padding: "24px", display: "flex", "flex-wrap": "wrap", "align-items": "flex-start", "align-content": "flex-start", gap: "56px 40px", background: "var(--bg)", "min-height": "100vh", color: "var(--text)" }}>
      <For each={ACTIVITIES.filter(([name]) => !only || only.split(",").includes(name))}>
        {([name, ms]) => (
          <figure style={{ margin: "40px 30px 0", display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px" }} data-activity={name}>
            <Looping activity={name} ms={ms} size={size} paused={params.has("paused")} />
            <figcaption style={{ font: "12px var(--mono)", color: "var(--text-muted)" }}>{name}</figcaption>
          </figure>
        )}
      </For>
      <For each={MOODS.filter((name) => !only || only.split(",").includes(name))}>
        {(name) => (
          <figure style={{ margin: "40px 30px 0", display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px" }} data-mood={name}>
            <span ref={(el) => side && queueMicrotask(() => el.querySelector(".gib")?.classList.replace("side-right", `side-${side}`))}>
              <Gib size={size} pose={name === "sleep" ? "monday" : "poker"} mood={name} />
            </span>
            <figcaption style={{ font: "12px var(--mono)", color: "var(--text-muted)" }}>{name}</figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}
