import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Mark } from "../brand/Mark";
import { reducedMotion, setSplashDone, setState, state } from "../state";
import { Gib, type GibMood } from "./Gib";
import { gibMs, motionMs } from "../motion";

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Startup moment: Gib thinks while the workspace loads, gets an idea (bulb + smile)
 * and hops down to its spot in the status bar. Any key or click skips ahead.
 */
export function Splash() {
  const [mood, setMood] = createSignal<GibMood>("think");
  const [caption, setCaption] = createSignal("Preparando tu espacio de trabajo…");
  const [leaving, setLeaving] = createSignal(false);
  const [gone, setGone] = createSignal(false);
  let overlay: HTMLDivElement | undefined;
  let mover: HTMLDivElement | undefined;
  let skip = false;
  let skipWake: (() => void) | null = null;

  const wait = (ms: number) =>
    skip
      ? Promise.resolve()
      : Promise.race([sleep(ms), new Promise<void>((resolve) => (skipWake = resolve))]);

  onMount(() => {
    const onSkip = () => {
      skip = true;
      skipWake?.();
    };
    window.addEventListener("keydown", onSkip, { once: true });
    window.addEventListener("pointerdown", onSkip, { once: true });
    onCleanup(() => {
      window.removeEventListener("keydown", onSkip);
      window.removeEventListener("pointerdown", onSkip);
    });
    void run();
  });

  async function run() {
    const started = performance.now();
    while (!state.ready) await sleep(30);
    // Read once the settings are loaded: "Animaciones: reducidas" in Celer counts, not only the system's.
    if (reducedMotion() || state.settings.companion === "off") {
      await finish(false);
      return;
    }
    await wait(Math.max(0, 1000 - (performance.now() - started)));
    setMood("idea");
    setCaption("¡Listo!");
    await wait(850);
    await finish(true);
  }

  async function finish(fly: boolean) {
    setMood("happy");
    setLeaving(true);
    const target = document.querySelector<HTMLElement>(".companion .gib");
    const source = mover?.querySelector<HTMLElement>(".gib");
    if (fly && target && source && mover) {
      const from = source.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const scale = to.width / from.width;
      overlay?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: gibMs(520), delay: gibMs(120), easing: "ease-out", fill: "forwards" });
      const flight = mover.animate(
        [
          { transform: "translate(0, 0) scale(1) rotate(0deg)" },
          { transform: "translate(0, -18px) scale(1.06) rotate(-4deg)", offset: 0.14 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.32 - 90}px) scale(${(1 + scale) / 2}) rotate(8deg)`, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy + 6}px) scale(${scale * 1.08}, ${scale * 0.9}) rotate(0deg)`, offset: 0.88 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)` },
        ],
        { duration: gibMs(skip ? 420 : 950), easing: "cubic-bezier(.45,.05,.3,1)", fill: "forwards" },
      );
      // Animations pause while the window is hidden or minimised: never wait for them indefinitely.
      await Promise.race([flight.finished.catch(() => {}), sleep(gibMs(skip ? 420 : 950) + 400)]);
    } else {
      const fade = overlay?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motionMs(220), fill: "forwards" });
      await Promise.race([fade?.finished.catch(() => {}), sleep(600)]);
    }
    setSplashDone(true);
    setGone(true);
    // First launch: the start-up guide takes over once Gib has landed.
    if (!state.settings.onboarded) setState("onboardingOpen", true);
  }

  return (
    <Show when={!gone()}>
      <div class="splash" classList={{ leaving: leaving() }}>
        <div class="splash-bg" ref={overlay} />
        <div class="splash-center">
          <div class="splash-mover" ref={mover}>
            <Gib size={150} pose="poker" mood={mood()} />
          </div>
          <div class="splash-text">
            <div class="splash-brand"><Mark size={22} /><span>Celer</span></div>
            <p>{caption()}</p>
          </div>
        </div>
      </div>
    </Show>
  );
}
