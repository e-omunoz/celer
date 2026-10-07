import { createSignal, onCleanup, onMount } from "solid-js";
import icon from "../../docs/brand/mascot/gib-icon.svg?raw";
import laptop from "../../docs/brand/mascot/gib-laptop.svg?raw";
import monday from "../../docs/brand/mascot/gib-monday.svg?raw";
import poker from "../../docs/brand/mascot/gib-poker.svg?raw";

export type GibMood = "idle" | "wave" | "busy" | "ok" | "love" | "error" | "offline" | "sleep";
export type GibPose = "poker" | "laptop" | "monday" | "icon";

const ART: Record<GibPose, string> = { poker, laptop, monday, icon };

export function Gib(props: {
  mood?: GibMood;
  pose?: GibPose;
  size?: number;
  label?: string;
  onClick?: () => void;
}) {
  let root: HTMLSpanElement | undefined;
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
        setBlink(true);
        window.setTimeout(() => setBlink(false), 120);
        if (Math.random() < 0.25) {
          window.setTimeout(() => {
            setBlink(true);
            window.setTimeout(() => setBlink(false), 120);
          }, 180);
        }
        schedule();
      }, wait);
    };
    schedule();
    const look = (event: PointerEvent) => {
      if (!root || mood() === "busy" || mood() === "sleep") return;
      const box = root.getBoundingClientRect();
      const dx = (event.clientX - (box.left + box.width / 2)) / 80;
      const dy = (event.clientY - (box.top + box.height / 2)) / 80;
      root.style.setProperty("--look-x", `${Math.max(-2, Math.min(2, dx))}px`);
      root.style.setProperty("--look-y", `${Math.max(-2, Math.min(2, dy))}px`);
    };
    window.addEventListener("pointermove", look);
    onCleanup(() => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", look);
    });
  });

  return (
    <span
      ref={root}
      class="gib"
      classList={{ [`mood-${mood()}`]: true, [`pose-${pose()}`]: true, "is-blink": blink() }}
      style={{ width: `${props.size ?? 96}px` }}
      role={props.onClick ? "button" : "img"}
      tabindex={props.onClick ? 0 : undefined}
      aria-label={props.label ?? "Gib"}
      innerHTML={ART[pose()]}
      onClick={() => props.onClick?.()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onClick?.();
      }}
    />
  );
}
