// The engines a script, template or history entry is written for (src/engineCompat.ts): their icons, «SQL estándar»
// for generic SQL, and a warning look when they do not match the connection it is compared with.
import { For, Show } from "solid-js";
import { compatibility, guessText, type EngineGuess } from "../engineCompat";
import { EngineIcon } from "../icons";
import type { DbKind } from "../types";

export function EngineBadge(props: { guess: EngineGuess; kind?: DbKind; showStandard?: boolean }) {
  const warn = () => compatibility(props.guess, props.kind) === "warn";
  const shown = () => props.guess.engines.length > 0 || props.guess.generic || (props.showStandard && props.guess.source === "none");
  return (
    <Show when={shown()}>
      <span
        class="lib-engine"
        classList={{ warn: warn(), guess: props.guess.source === "connection" }}
        title={guessText(props.guess, props.kind)}
        aria-label={guessText(props.guess, props.kind)}
      >
        <Show when={props.guess.engines.length} fallback={<>SQL estándar</>}>
          <For each={props.guess.engines}>{(kind) => <EngineIcon kind={kind} size={11} />}</For>
        </Show>
        <Show when={warn()}>
          <span class="lib-engine-warn">otro motor</span>
        </Show>
      </span>
    </Show>
  );
}
