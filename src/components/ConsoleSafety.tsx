// What a console wears for risk: its connection's environment (chip and strip, src/environment.ts) and its open
// manual transaction (how long, how many statements, src/txWatch.ts). Used by the console toolbar, the tabs, the
// explorer and the status bar.
import { FlaskConical, Layers, ShieldAlert, Tag, Timer, Wrench } from "lucide-solid";
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { envOf, type EnvLook } from "../environment";
import { txDuration, txLabel, txLevel, worstLevel } from "../txWatch";
import { now, openMenu, openTransactions, saveSettings, selectTab, state, txAge, txThresholdsOf, type SqlTab } from "../state";
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

/** A console's transaction state: level and texts, ticking with the clock. */
export function txView(tab: SqlTab) {
  const ms = txAge(tab, now());
  const level = txLevel(ms, txThresholdsOf(tab));
  return { ms, level, label: txLabel(ms, tab.txStatements || 1), short: txDuration(ms) };
}

/** «Transacción abierta · N min · M sentencias», amber then red past the thresholds (Ajustes › Seguridad). */
export function TxIndicator(props: { tab: SqlTab }) {
  const view = () => txView(props.tab);
  return (
    <Show when={props.tab.inTransaction}>
      <span class={`tx-indicator ${view().level}`} role="status" title={`${view().label}. Commit la confirma; Rollback la deshace.`}>
        <Timer size={12} />
        <span>{view().label}</span>
      </span>
    </Show>
  );
}

/** The tab's badge: how long its transaction has been open. */
export function TxTabBadge(props: { tab: SqlTab }) {
  const view = () => txView(props.tab);
  return (
    <span class={`tab-tx ${view().level}`} title={view().label}>
      TX {view().short}
    </span>
  );
}

/** The status bar's list of this window's open transactions: a click goes to the console (a menu when several). */
export function TxStatus() {
  const open = () => openTransactions();
  const level = () => worstLevel(open().map((tab) => txView(tab).level));
  const go = (event: MouseEvent) => {
    const list = open();
    if (list.length === 1) {
      selectTab(list[0].id);
      return;
    }
    openMenu(
      event,
      list.map((tab) => ({
        label: `${tab.title}${tab.id === state.activeTabId ? " ●" : ""}`,
        hint: txView(tab).label.replace("Transacción abierta · ", ""),
        run: () => selectTab(tab.id),
      })),
    );
  };
  return (
    <Show when={open().length}>
      <button type="button" class={`st-tx ${level()}`} title={open().map((tab) => `${tab.title}: ${txView(tab).label}`).join("\n")} onClick={go}>
        <Timer size={12} />
        <Show when={open().length === 1} fallback={<span>{open().length} transacciones abiertas</span>}>
          <span>TX {open()[0].title} · {txView(open()[0]).short}</span>
        </Show>
      </button>
    </Show>
  );
}

/** Ajustes › Seguridad: when an open manual transaction turns amber and red, and the reminder. */
export function TxSettings() {
  const s = () => state.settings;
  const minutes = (secs: number) => String(Math.round((secs / 60) * 10) / 10);
  const field = (label: string, key: "txWarnSecs" | "txAlertSecs" | "txProdWarnSecs" | "txProdAlertSecs") => (
    <label class="field">
      <span>{label}</span>
      <span class="input-unit">
        <input
          type="number"
          min="0.5"
          max="240"
          step="0.5"
          value={minutes(s()[key])}
          onChange={(event) => {
            const value = Number(event.currentTarget.value.replace(",", "."));
            if (Number.isFinite(value) && value > 0) void saveSettings({ [key]: Math.round(Math.min(240, value) * 60) });
            else event.currentTarget.value = minutes(s()[key]);
          }}
        />
        <small>min</small>
      </span>
    </label>
  );
  return (
    <div class="tx-settings">
      <h4>Transacciones manuales</h4>
      <p class="settings-note">En modo Manual, la consola muestra cuánto lleva abierta la transacción y cuántas sentencias tiene: en ámbar al pasar el primer umbral y en rojo al pasar el segundo. En producción se usan los umbrales más estrictos.</p>
      <div class="form-row">
        {field("Ámbar a partir de", "txWarnSecs")}
        {field("Rojo a partir de", "txAlertSecs")}
        {field("Producción: ámbar", "txProdWarnSecs")}
        {field("Producción: rojo", "txProdAlertSecs")}
      </div>
      <label class="check">
        <input type="checkbox" checked={s().txRemind} onChange={(event) => void saveSettings({ txRemind: event.currentTarget.checked })} /> Recordármelo al pasar a rojo, y otra vez cada vez que pase ese tiempo (Gib, o un aviso si está apagado)
      </label>
      <p class="settings-note">Al cerrar una consola o la ventana, desconectar, cambiar de conexión o de base de datos, pasar a Auto o salir con una transacción abierta, Celer pregunta: Commit, Rollback o Cancelar. Nunca confirma por su cuenta.</p>
    </div>
  );
}
