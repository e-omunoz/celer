import { createSignal, onCleanup, onMount, Show } from "solid-js";
import "./activities.css";
import icon from "../../docs/brand/mascot/gib-icon.svg?raw";
import laptop from "../../docs/brand/mascot/gib-laptop.svg?raw";
import monday from "../../docs/brand/mascot/gib-monday.svg?raw";
import poker from "../../docs/brand/mascot/gib-poker.svg?raw";
import type { GibAccessory, GibPose } from "./prefs";

export { GIB_ACCESSORIES, type GibAccessory, type GibPose } from "./prefs";

export type GibMood = "idle" | "wave" | "busy" | "think" | "idea" | "ok" | "happy" | "love" | "error" | "offline" | "sleep" | "sad" | "annoyed" | "grumpy";
/**
 * Things Gib does on his own while nothing is happening (see Companion). Each one is a CSS animation on the rig
 * plus, for some, a prop in the SVG (mug, book) or an effect in the fx layer (steam, notes, balls, a bug…).
 */
export type GibActivity =
  | "yawn"
  | "coffee-out"
  | "coffee-away"
  | "coffee-in"
  | "coffee-sip"
  | "coffee-done"
  | "laptop"
  | "doze"
  | "juggle"
  | "read"
  | "dance"
  | "scratch"
  | "bug";
/**
 * Accessories (Settings › Apariencia › Gib): SVG layers every pose carries, hidden until chosen (App.css shows the ones
 * named in the root's data-gib-acc, or a Gib's own `accessories`). Head ones go at the end of the head group, so they
 * move with it and sit over the eyes and lids without touching them; the scarf goes under the head, over the body.
 * Every pose shares the head's geometry, so one drawing fits all. Colour: .acc-fill and .acc-frame (App.css).
 */
const ACC_HEAD = `
  <g class="acc acc-cap" display="none">
    <path class="acc-fill" d="M52 50C52 22 74 10 100 10s48 12 48 40z"/>
    <path d="M100 11v39M78 16q-9 14-9 34M122 16q9 14 9 34" stroke="#000" stroke-opacity=".16" stroke-width="1.6"/>
    <path class="acc-fill" d="M44 50q56-10 112 0q4 6-2 9q-54-9-108 0q-6-3-2-9z"/>
    <path d="M44 50q56-10 112 0q4 6-2 9q-54-9-108 0q-6-3-2-9z" fill="#000" fill-opacity=".22"/>
    <circle class="acc-fill" cx="100" cy="11" r="4.2"/>
  </g>
  <g class="acc acc-glasses" display="none">
    <circle class="acc-frame" cx="79" cy="85" r="16.5" fill="#BFE0FF" fill-opacity=".12" stroke-width="2.8"/>
    <circle class="acc-frame" cx="121" cy="85" r="16.5" fill="#BFE0FF" fill-opacity=".12" stroke-width="2.8"/>
    <path class="acc-frame" d="M95.5 84q4.5-3 9 0M62.5 82l-8-3M137.5 82l8-3" stroke-width="2.6" stroke-linecap="round"/>
  </g>
  <g class="acc acc-headphones" display="none">
    <path d="M27 96C25 44 58 17 100 17s75 27 73 79" stroke="#2E3138" stroke-width="7" stroke-linecap="round"/>
    <rect class="acc-fill" x="15" y="76" width="25" height="40" rx="11"/>
    <rect class="acc-fill" x="160" y="76" width="25" height="40" rx="11"/>
    <path d="M24 84v24M176 84v24" stroke="#000" stroke-opacity=".2" stroke-width="5" stroke-linecap="round"/>
  </g>`;
const ACC_NECK = `
  <g class="acc acc-scarf" display="none">
    <path class="acc-fill" d="M110 150l13 42-13 3-9-40z"/>
    <path d="M112 182l11-3M114 188l10-3" stroke="#fff" stroke-opacity=".45" stroke-width="2"/>
    <path class="acc-fill" d="M64 141q36 17 72 0l3 13q-39 19-78 0z"/>
    <path d="M66 147q34 15 68 0" stroke="#fff" stroke-opacity=".4" stroke-width="2"/>
  </g>`;

const dress = (svg: string) => svg.replace("<!-- acc:head -->", ACC_HEAD).replace(/<!-- acc:neck[^>]*-->/, ACC_NECK);
const ART: Record<GibPose, string> = { poker: dress(poker), laptop: dress(laptop), monday: dress(monday), icon: dress(icon) };

let instances = 0;
/**
 * Each Gib gets its own SVG ids. Inline SVGs share one id space: url(#poker-shirt) resolves to the first
 * element with that id in the document, and if that Gib is hidden (an inactive tab) the gradient is not
 * painted, so every other Gib lost its shirt, sleeves and fur.
 */
function uniqueIds(svg: string, prefix: string) {
  return svg.replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`).replace(/href="#([^"]+)"/g, `href="#${prefix}-$1"`);
}

export function Gib(props: {
  mood?: GibMood;
  /** An idle activity; ignored while the mood is not "idle". */
  activity?: GibActivity | null;
  pose?: GibPose;
  size?: number;
  label?: string;
  /** Hide the effect layer (thought bubble, bulb…), e.g. in tiny sizes. */
  plain?: boolean;
  onClick?: () => void;
  onDblClick?: () => void;
  onHover?: (inside: boolean) => void;
  ref?: (el: HTMLSpanElement) => void;
  /** His own accessories and colour (the settings preview, the lab); otherwise those of the settings, from the root. */
  accessories?: GibAccessory[];
  tint?: string | null;
  /** No petting or poking (a Gib that is only a picture). */
  still?: boolean;
  /** GibLab only: lids shut (to check that a blink closes them fully), and a fixed gaze in SVG units. */
  blink?: boolean;
  look?: [number, number];
}) {
  let root: HTMLSpanElement | undefined;
  const idPrefix = `gib${++instances}`;
  const [blink, setBlink] = createSignal(false);
  const [side, setSide] = createSignal<"left" | "right">("right");
  /**
   * Every Gib without a click of its own can be touched: the cursor resting on him is a pet (eyes half closed, a
   * blush, head tilted), a click is a poke (a jump, eyes wide) and three quick pokes make him grumpy for a moment.
   */
  const [touch, setTouch] = createSignal<"pet" | "poke" | "grumpy" | null>(null);
  const touchable = () => !props.onClick && !props.onHover && !props.still;
  let touchTimer = 0;
  let pokes: number[] = [];
  const mood = () => (touch() === "grumpy" ? "grumpy" : props.mood ?? "idle");
  const activity = () => (mood() === "idle" ? props.activity ?? null : null);
  const pose = (): GibPose => {
    const act = activity();
    if (act === "laptop") return "laptop";
    // The other activities need the poker rig (arms, the mug, the book): a Gib in another pose plays them standing.
    if (act) return "poker";
    if (props.pose) return props.pose;
    if (mood() === "busy") return "laptop";
    if (mood() === "sleep") return "monday";
    return (props.size ?? 96) <= 44 ? "icon" : "poker";
  };

  onMount(() => {
    // The app sets data-motion from its settings (and may change it later); elsewhere (the installer) the system
    // setting decides. Read at every blink, so switching "reduce motion" on stops them at once.
    const reduce = () => {
      const motion = document.documentElement.dataset.motion;
      return motion ? motion === "reduce" : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    };
    let timer = 0;
    const schedule = () => {
      const wait = 2500 + Math.random() * 4500;
      timer = window.setTimeout(() => {
        // Nobody is looking (another window has the focus, or it is minimised): no blinks either.
        if (!reduce() && !document.hidden && document.hasFocus() && mood() !== "sleep" && mood() !== "think") {
          // 150 ms shut: the lids close in 60 ms (App.css), so they always meet before opening again.
          setBlink(true);
          window.setTimeout(() => setBlink(false), 150);
          if (Math.random() < 0.25) {
            window.setTimeout(() => {
              setBlink(true);
              window.setTimeout(() => setBlink(false), 150);
            }, 260);
          }
        }
        schedule();
      }, wait);
    };
    schedule();
    // The eyes follow the pointer: at most once per frame (one layout read, then style writes), and not for a Gib
    // that is not on screen.
    let frame = 0;
    let pointer: PointerEvent | null = null;
    const look = (event: PointerEvent) => {
      pointer = event;
      if (!frame) frame = window.requestAnimationFrame(follow);
    };
    const follow = () => {
      frame = 0;
      const event = pointer;
      if (!event || !root || props.look || reduce() || mood() === "busy" || mood() === "sleep" || mood() === "think") return;
      // Settings › Apariencia › Gib: eyes that do not follow the cursor look ahead.
      if (document.documentElement.dataset.gibEyes === "off") {
        root.style.removeProperty("--look-x");
        root.style.removeProperty("--look-y");
        return;
      }
      const box = root.getBoundingClientRect();
      if (!box.width) return;
      // The side the cursor is on: an annoyed Gib swats with the arm on that side.
      setSide(event.clientX < box.left + box.width / 2 ? "left" : "right");
      // In SVG units; App.css clamps the sum with the mood's own gaze to the room each pose's eyes have.
      const dx = (event.clientX - (box.left + box.width / 2)) / 60;
      const dy = (event.clientY - (box.top + box.height / 2)) / 60;
      root.style.setProperty("--look-x", `${Math.max(-6, Math.min(6, dx)).toFixed(2)}px`);
      root.style.setProperty("--look-y", `${Math.max(-6, Math.min(6, dy)).toFixed(2)}px`);
    };
    window.addEventListener("pointermove", look);
    onCleanup(() => {
      window.clearTimeout(timer);
      window.clearTimeout(touchTimer);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", look);
    });
  });

  /** A poke: a jump; the third within a couple of seconds makes him grumpy. */
  function poke() {
    const at = Date.now();
    pokes = [...pokes.filter((t) => at - t < 2500), at];
    window.clearTimeout(touchTimer);
    const grumpy = pokes.length >= 3;
    if (grumpy) pokes = [];
    setTouch(grumpy ? "grumpy" : "poke");
    touchTimer = window.setTimeout(() => setTouch(null), grumpy ? 1300 : 520);
  }

  return (
    <span
      ref={(el) => {
        root = el;
        props.ref?.(el);
      }}
      class="gib"
      classList={{ ...accessoryClasses(props.accessories), tinted: Boolean(props.tint), [`mood-${mood()}`]: true, [`pose-${pose()}`]: true, [`act-${activity()}`]: Boolean(activity()), [`side-${side()}`]: true, "is-blink": blink() || Boolean(props.blink), clickable: Boolean(props.onClick), "is-pet": touch() === "pet", "is-poke": touch() === "poke" }}
      style={{
        width: `${props.size ?? 96}px`,
        "--gib-size": `${props.size ?? 96}px`,
        ...(props.tint ? { "--gib-tint": props.tint } : {}),
        ...(props.look ? { "--look-x": `${props.look[0]}px`, "--look-y": `${props.look[1]}px` } : {}),
      }}
      role={props.onClick ? "button" : "img"}
      tabindex={props.onClick ? 0 : undefined}
      aria-label={props.label ?? "Gib"}
      onClick={() => {
        if (props.onClick) props.onClick();
        else if (touchable()) poke();
      }}
      onDblClick={() => props.onDblClick?.()}
      onPointerEnter={() => {
        props.onHover?.(true);
        if (!touchable()) return;
        window.clearTimeout(touchTimer);
        // A moment on him before it counts as petting (passing over does not).
        touchTimer = window.setTimeout(() => !touch() && setTouch("pet"), 600);
      }}
      onPointerLeave={() => {
        props.onHover?.(false);
        if (touch() === "pet") setTouch(null);
        if (!touch()) window.clearTimeout(touchTimer);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onClick?.();
      }}
    >
      <span class="gib-art" innerHTML={uniqueIds(ART[pose()], idPrefix)} />
      <Show when={!props.plain}>
        <span class="gib-fx" aria-hidden="true">
          <Show when={mood() === "think"}>
            <span class="fx-thought">
              <i class="b1" />
              <i class="b2" />
              <span class="fx-cloud">
                <i />
                <i />
                <i />
              </span>
            </span>
          </Show>
          <Show when={mood() === "idea"}>
            <span class="fx-bulb">
              <svg viewBox="0 0 40 52">
                <g class="rays" stroke="#F5B83D" stroke-width="2.6" stroke-linecap="round">
                  <path d="M20 3v5M5 10l3.5 3.5M35 10l-3.5 3.5M1 24h5M39 24h-5" />
                </g>
                <path d="M20 12a11 11 0 0 0-6.5 19.9c1.4 1.1 2.2 2.6 2.4 4.3h8.2c.2-1.7 1-3.2 2.4-4.3A11 11 0 0 0 20 12z" fill="#FFD25E" stroke="#E2A72E" stroke-width="1.4" />
                <path d="M16.5 26.5c1-2.4 2.3-3.4 3.5-3.4s2.5 1 3.5 3.4" stroke="#C98A1C" stroke-width="1.3" fill="none" stroke-linecap="round" />
                <rect x="15.5" y="37.5" width="9" height="3.4" rx="1.2" fill="#9AA0AA" />
                <rect x="16.3" y="41.6" width="7.4" height="3" rx="1.2" fill="#7D838E" />
              </svg>
            </span>
          </Show>
          <Show when={mood() === "love"}>
            <span class="fx-heart">
              <svg viewBox="0 0 24 22"><path d="M12 21s-9-5.6-9-12A5 5 0 0 1 12 6a5 5 0 0 1 9 3c0 6.4-9 12-9 12z" fill="#EC6A7A" /></svg>
            </span>
          </Show>
          <Show when={mood() === "sleep" || activity() === "doze"}>
            <span class="fx-zzz"><i>z</i><i>z</i><i>z</i></span>
          </Show>
          <Show when={mood() === "error"}>
            <span class="fx-mark">?</span>
          </Show>
          <Show when={mood() === "sad"}>
            <span class="fx-tear" />
          </Show>
          <Show when={mood() === "annoyed" || mood() === "grumpy"}>
            <span class="fx-swish"><i /><i /></span>
          </Show>
          <Show when={mood() === "grumpy"}>
            <span class="fx-vein"><i /><i /><i /><i /></span>
          </Show>
          <ActivityFx activity={activity()} />
          <Show when={mood() === "ok" || mood() === "happy"}>
            <span class="fx-sparkle"><i /><i /><i /></span>
          </Show>
        </span>
      </Show>
    </span>
  );
}

/** Effects that belong to an idle activity (drawn over Gib, sized in em from --fx). */
function ActivityFx(props: { activity: GibActivity | null }) {
  return (
    <>
      <Show when={props.activity === "coffee-sip"}>
        <span class="fx-steam"><i /><i /><i /></span>
      </Show>
      <Show when={props.activity === "coffee-away"}>
        <span class="fx-sign">
          <b>Vuelvo ya</b>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" fill="#F7F3EC" stroke="#8C7A66" stroke-width="1.5" /><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16" fill="none" stroke="#8C7A66" stroke-width="1.5" /><path d="M8 3.5c-.8 1 .8 2 0 3M11 3c-.8 1 .8 2 0 3.2M14 3.5c-.8 1 .8 2 0 3" fill="none" stroke="#B7A794" stroke-width="1.2" stroke-linecap="round" /></svg>
        </span>
      </Show>
      <Show when={props.activity === "dance"}>
        <span class="fx-notes"><i>♪</i><i>♫</i><i>♪</i></span>
      </Show>
      <Show when={props.activity === "juggle"}>
        <span class="fx-juggle"><i /><i /><i /></span>
      </Show>
      <Show when={props.activity === "doze"}>
        <span class="fx-wake">!</span>
      </Show>
      <Show when={props.activity === "scratch"}>
        <span class="fx-question">?</span>
      </Show>
      <Show when={props.activity === "bug"}>
        <span class="fx-bug">
          <svg viewBox="0 0 24 16" aria-hidden="true">
            <g stroke="#3A2A20" stroke-width="1.3" stroke-linecap="round"><path d="M8 5 4 2M8 8H3M8 11l-4 3M16 5l4-3M16 8h5M16 11l4 3" /></g>
            <ellipse cx="12" cy="8.5" rx="5.5" ry="6" fill="#4F8A3C" stroke="#2E5524" stroke-width="1" />
            <path d="M12 3v11" stroke="#2E5524" stroke-width="1" />
            <circle cx="12" cy="2.6" r="2.4" fill="#2E2A26" />
          </svg>
          <i class="poof" />
        </span>
        <span class="fx-sparkle late"><i /><i /><i /></span>
      </Show>
      <Show when={props.activity === "laptop"}>
        <span class="fx-sparkle late"><i /><i /><i /></span>
      </Show>
    </>
  );
}
/** "acc-own" plus one class per accessory when a Gib has its own set (App.css then ignores the root's). */
function accessoryClasses(list: GibAccessory[] | undefined): Record<string, boolean> {
  if (!list) return {};
  return { "acc-own": true, ...Object.fromEntries(list.map((name) => [`acc-${name}`, true])) };
}
