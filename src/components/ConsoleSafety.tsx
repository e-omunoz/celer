// What a console wears for risk: its connection's environment (chip and strip, src/environment.ts). Used by the
// console toolbar, the tabs, the explorer and the status bar.
import { FlaskConical, Layers, ShieldAlert, Tag, Wrench } from "lucide-solid";
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { envOf, type EnvLook } from "../environment";
import type { ConnSummary } from "../types";

const ICONS = { dev: Wrench, test: FlaskConical, staging: Layers, prod: ShieldAlert, custom: Tag } as const;

/** The environment as a chip: icon and label on its colour (never only colour). */
export function EnvChip(props: { conn: ConnSummary | undefined; short?: boolean; tiny?: boolean }) {
  const look = () => envOf(props.conn);
  return (
    <Show when={look()}>
      {(env) => (
        <span class="env-chip" classList={{ tiny: props.tiny }} style={{ background: env().color, color: env().fg }} title={`Entorno: ${env().label}${env().production ? " · confirma cambios peligrosos" : ""}`}>
          <Dynamic component={ICONS[env().id]} size={props.tiny ? 10 : 11} />
          <span>{props.short ? env().short : env().label}</span>
        </span>
      )}
    </Show>
  );
}

/** The coloured band across the top of a console or table of a connection with an environment. */
export function EnvStrip(props: { conn: ConnSummary | undefined }) {
  const look = (): EnvLook | null => envOf(props.conn);
  return <Show when={look()}>{(env) => <div class="env-strip" style={{ background: env().color }} aria-hidden="true" />}</Show>;
}
