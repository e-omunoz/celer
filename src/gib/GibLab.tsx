// Development only (http://localhost:1420/#giblab): every mood and idle activity of Gib, big and looping, to review
// the animations by eye or capture them (dev/gib-lab-shots.mjs). Not part of the production bundle.
//   #giblab?only=yawn,think&size=150&paused&side=left      one big Gib per activity / mood (looping)
//   #giblab?grid&sizes=34,46,84,150&theme=sand&blink&look=6,-6&acc=cap,glasses&tint=%23D97757
//       every pose × (mood ∪ activity) at once, at each size Gib is shown in the app, in one theme; `blink` shuts the
//       lids, `look` fixes the gaze (SVG units), `acc` and `tint` dress him (as Settings › Apariencia › Gib does).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Gib, GIB_ACCESSORIES, type GibAccessory, type GibActivity, type GibMood, type GibPose } from "./Gib";

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
const MOODS: GibMood[] = ["idle", "annoyed", "grumpy", "wave", "think", "idea", "happy", "ok", "love", "error", "sad", "sleep", "offline", "busy"];
export const LAB_POSES: GibPose[] = ["poker", "laptop", "monday", "icon"];
/**
 * Every size Gib is drawn at in the app: onboarding mini (34), companion (46), empty state (72), update dialog (76),
 * sidebar / E-R diagram / migrate / busy overlay (84), welcome (112), onboarding (120), settings preview (128), splash (150).
 */
export const LAB_SIZES = [34, 46, 72, 76, 84, 112, 120, 128, 150];
export const LAB_THEMES = ["dark", "light", "darcula", "contrast", "contrast-light", "fjord", "sand"];

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
  const theme = params.get("theme");
  if (theme) document.documentElement.dataset.theme = theme;
  // Dressed as Settings › Apariencia › Gib would (the root's data-gib-acc and --gib-tint, App.css).
  const tint = params.get("tint");
  if (tint) {
    document.documentElement.style.setProperty("--gib-tint", tint);
    document.documentElement.dataset.gibTint = "";
  }
  const acc = (params.get("acc") ?? "").split(",").filter((name): name is GibAccessory => (GIB_ACCESSORIES as readonly string[]).includes(name));
  if (acc.length) document.documentElement.dataset.gibAcc = acc.join(" ");
  return <Show when={params.has("grid")} fallback={<Showcase params={params} />}><Grid params={params} /></Show>;
}

/** All poses × moods and activities, at every size asked for: what dev/gib-lab-shots.mjs checks and captures. */
function Grid(props: { params: URLSearchParams }) {
  const sizes = (props.params.get("sizes") ?? props.params.get("size") ?? "84").split(",").map(Number).filter((n) => n > 0);
  const poses = (props.params.get("poses") ?? LAB_POSES.join(",")).split(",") as GibPose[];
  const look = props.params.get("look")?.split(",").map(Number) as [number, number] | undefined;
  const blink = props.params.has("blink");
  const cells: { mood: GibMood; activity: GibActivity | null }[] = [...MOODS.map((mood) => ({ mood, activity: null })), ...ACTIVITIES.map(([activity]) => ({ mood: "idle" as GibMood, activity }))];
  const label = { font: "10px var(--mono)", color: "var(--text-muted)", "line-height": "1.2", "text-align": "center" as const };
  return (
    <div class="giblab grid" style={{ padding: "16px", background: "var(--bg)", "min-height": "100vh", color: "var(--text)" }}>
      <For each={sizes}>
        {(size) => (
          <section data-size={size} style={{ "margin-bottom": "24px" }}>
            <h3 style={{ font: "600 12px var(--sans)", margin: "0 0 8px" }}>{size}px · {document.documentElement.dataset.theme ?? "dark"}</h3>
            <For each={poses}>
              {(pose) => (
                <div data-pose={pose} style={{ display: "flex", "flex-wrap": "wrap", gap: `${Math.max(14, size / 3)}px ${Math.max(8, size / 5)}px`, "align-items": "flex-end", padding: `${Math.max(18, size / 2)}px 8px 6px`, "border-top": "1px solid var(--border)" }}>
                  <For each={cells}>
                    {(cell) => (
                      <figure class="lab-cell" data-pose={pose} data-mood={cell.mood} data-activity={cell.activity ?? ""} style={{ margin: "0", display: "flex", "flex-direction": "column", "align-items": "center", gap: "4px", width: `${Math.max(size, 54)}px` }}>
                        <Gib size={size} pose={pose} mood={cell.mood} activity={cell.activity} blink={blink} look={look} />
                        <figcaption style={label}>{pose}<br />{cell.activity ?? cell.mood}</figcaption>
                      </figure>
                    )}
                  </For>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  );
}

/** One big looping Gib per activity and mood (the original lab). */
function Showcase(props: { params: URLSearchParams }) {
  const params = props.params;
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
              <Gib size={size} pose={name === "sleep" ? "monday" : name === "busy" ? "laptop" : "poker"} mood={name} />
            </span>
            <figcaption style={{ font: "12px var(--mono)", color: "var(--text-muted)" }}>{name}</figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}
