import { createSignal, onCleanup, onMount, Show } from "solid-js";
import icon from "../../docs/brand/mascot/gib-icon.svg?raw";
import laptop from "../../docs/brand/mascot/gib-laptop.svg?raw";
import monday from "../../docs/brand/mascot/gib-monday.svg?raw";
import poker from "../../docs/brand/mascot/gib-poker.svg?raw";

export type GibMood = "idle" | "wave" | "busy" | "think" | "idea" | "ok" | "happy" | "love" | "error" | "offline" | "sleep" | "sad";
export type GibPose = "poker" | "laptop" | "monday" | "icon";

const ART: Record<GibPose, string> = { poker, laptop, monday, icon };

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
  pose?: GibPose;
  size?: number;
  label?: string;
  /** Hide the effect layer (thought bubble, bulb…), e.g. in tiny sizes. */
  plain?: boolean;
  onClick?: () => void;
  onDblClick?: () => void;
  onHover?: (inside: boolean) => void;
  ref?: (el: HTMLSpanElement) => void;
}) {
  let root: HTMLSpanElement | undefined;
  const idPrefix = `gib${++instances}`;
  const [blink, setBlink] = createSignal(false);
  const mood = () => props.mood ?? "idle";
  const pose = (): GibPose => {
    if (props.pose) return props.pose;
    if (mood() === "busy") return "laptop";
    if (mood() === "sleep") return "monday";
    return (props.size ?? 96) <= 44 ? "icon" : "poker";
  };

  onMount(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let timer = 0;
    const schedule = () => {
      const wait = 2500 + Math.random() * 4500;
      timer = window.setTimeout(() => {
        if (mood() !== "sleep" && mood() !== "think") {
          setBlink(true);
          window.setTimeout(() => setBlink(false), 120);
          if (Math.random() < 0.25) {
            window.setTimeout(() => {
              setBlink(true);
              window.setTimeout(() => setBlink(false), 120);
            }, 180);
          }
        }
        schedule();
      }, wait);
    };
    schedule();
    const look = (event: PointerEvent) => {
      if (!root || mood() === "busy" || mood() === "sleep" || mood() === "think") return;
      const box = root.getBoundingClientRect();
      const dx = (event.clientX - (box.left + box.width / 2)) / 80;
      const dy = (event.clientY - (box.top + box.height / 2)) / 80;
      root.style.setProperty("--look-x", `${Math.max(-2.5, Math.min(2.5, dx))}px`);
      root.style.setProperty("--look-y", `${Math.max(-2.5, Math.min(2.5, dy))}px`);
    };
    window.addEventListener("pointermove", look);
    onCleanup(() => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", look);
    });
  });

  return (
    <span
      ref={(el) => {
        root = el;
        props.ref?.(el);
      }}
      class="gib"
      classList={{ [`mood-${mood()}`]: true, [`pose-${pose()}`]: true, "is-blink": blink(), clickable: Boolean(props.onClick) }}
      style={{ width: `${props.size ?? 96}px`, "--gib-size": `${props.size ?? 96}px` }}
      role={props.onClick ? "button" : "img"}
      tabindex={props.onClick ? 0 : undefined}
      aria-label={props.label ?? "Gib"}
      onClick={() => props.onClick?.()}
      onDblClick={() => props.onDblClick?.()}
      onPointerEnter={() => props.onHover?.(true)}
      onPointerLeave={() => props.onHover?.(false)}
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
          <Show when={mood() === "sleep"}>
            <span class="fx-zzz"><i>z</i><i>z</i><i>z</i></span>
          </Show>
          <Show when={mood() === "error"}>
            <span class="fx-mark">?</span>
          </Show>
          <Show when={mood() === "sad"}>
            <span class="fx-tear" />
          </Show>
          <Show when={mood() === "ok" || mood() === "happy"}>
            <span class="fx-sparkle"><i /><i /><i /></span>
          </Show>
        </span>
      </Show>
    </span>
  );
}
