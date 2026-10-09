// Vigilancia de las conexiones abiertas:
// - al volver de una suspensión del equipo (el reloj salta) o de un corte de red (evento «online»), comprueba cada
//   sesión abierta (explorador, consolas, tablas) y el núcleo reconecta la que se cortó; una consola que tenía una
//   transacción o estado de sesión lo dice al momento, no en su siguiente sentencia;
// - al volver a la ventana, comprueba las sesiones que llevan más de un minuto paradas (el núcleo solo mira esas), así
//   una conexión que el servidor cortó por inactividad se repone antes de la siguiente consulta (#97);
// - en las conexiones con «Mantener viva», comprueba sus sesiones paradas un poco antes de que el servidor las corte;
// - al mostrar una consola, abre su sesión en segundo plano (y conecta su conexión si no pide contraseña).
// Lo que se ve: el indicador de la conexión en el explorador y en la pestaña (connStatus.ts).
import { createEffect, createRoot, on } from "solid-js";
import { api } from "./api";
import { markConn, markTab } from "./connStatus";
import { connectionById, notify, patchTab, plainError, state, warmSqlSession } from "./state";
import type { SessionHealth } from "./types";

/** Cada cuánto mira el reloj, y qué salto se toma por una suspensión. */
const TICK_MS = 15_000;
const SLEPT_MS = 60_000;
/** Al volver a la ventana, como mucho una comprobación por minuto. */
const FOCUS_CHECK_MS = 60_000;

let started = false;
let checking = false;
let keeping = false;
let focusChecked = 0;

export function startConnWatch() {
  if (started) return;
  started = true;
  let last = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > TICK_MS + SLEPT_MS) void checkOpenSessions(`tras ${Math.round(gap / 60_000)} min de suspensión`);
    else void keepAlive();
  }, TICK_MS);
  window.addEventListener("online", () => void checkOpenSessions("al volver la red"));
  window.addEventListener("focus", () => {
    if (Date.now() - focusChecked < FOCUS_CHECK_MS) return;
    focusChecked = Date.now();
    void checkOpenSessions("mientras estaba parada", false);
  });
  createRoot(() => {
    createEffect(
      on(
        () => state.activeTabId,
        (id) => {
          if (id) warmSqlSession(id);
        },
      ),
    );
  });
}

/** What a check of the explorer's session of a connection found, on its dot. */
function reportConn(connId: string, health: SessionHealth, cause: string) {
  if (!health.ok) markConn(connId, "down", { note: plainError(health.error) });
  else if (health.reconnected) markConn(connId, "reconnected", { note: `Se había cortado ${cause}; reconectada en ${health.ms} ms` });
}

/** What a check of a tab's session found, on its dot (and a warning when its session state was lost). */
function reportTab(tabId: string, health: SessionHealth, cause: string) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (!health.ok) {
    markTab(tabId, "down", { note: plainError(health.error) });
  } else if (health.lost) {
    const text = plainError(health.lost);
    markTab(tabId, "lost", { note: text });
    if (tab.kind === "sql") patchTab(tabId, { inTransaction: false });
    notify(`«${tab.title}» perdió su sesión al cortarse la conexión`, "warning", text);
  } else if (health.reconnected) {
    markTab(tabId, "reconnected", { note: `Se había cortado ${cause}; reconectada en ${health.ms} ms` });
  }
}

/** Tabs with a session that is not at work (a session at work answers when it ends: its statement tells). */
const idleTabs = () => state.tabs.filter((tab) => tab.connId && tab.sessionId && !(tab.kind === "sql" ? tab.running : tab.loading));

/**
 * Comprueba ya las sesiones abiertas (una ida y vuelta cada una, en paralelo) y anota lo que pasó. Sin `force`, el
 * núcleo solo comprueba las que llevan un rato paradas.
 */
export async function checkOpenSessions(cause: string, force = true) {
  if (checking) return;
  checking = true;
  try {
    const jobs: Promise<void>[] = [];
    for (const [connId, session] of Object.entries(state.sessions)) {
      if (!session?.metaId) continue;
      jobs.push(
        api()
          .checkSession(session.metaId, force)
          .then((health) => reportConn(connId, health, cause))
          .catch(() => {}),
      );
    }
    for (const tab of idleTabs()) {
      const { id } = tab;
      jobs.push(
        api()
          .checkSession(tab.sessionId!, force)
          .then((health) => reportTab(id, health, cause))
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
  } finally {
    checking = false;
  }
}

/** Seconds idle after which a session of a connection with «Mantener viva» is checked: 80% of the server's limit. */
export function keepAliveIdleSecs(minutes: number | undefined): number {
  if (!minutes || minutes <= 0) return 0;
  return Math.max(20, Math.floor(minutes * 60 * 0.8));
}

/**
 * «Mantener viva» (#97): the sessions of those connections idle for 80% of the minutes after which their server ends
 * idle sessions get a cheap round trip (the core skips one with a result open), so the server never cuts them.
 */
async function keepAlive() {
  if (keeping || checking) return;
  keeping = true;
  try {
    const jobs: Promise<void>[] = [];
    for (const [connId, session] of Object.entries(state.sessions)) {
      const idle = keepAliveIdleSecs(connectionById(connId)?.keepaliveMin);
      if (!idle || !session) continue;
      const cause = "por inactividad";
      if (session.metaId) {
        jobs.push(
          api()
            .keepAliveSession(session.metaId, idle)
            .then((health) => {
              if (health) reportConn(connId, health, cause);
            })
            .catch(() => {}),
        );
      }
      for (const tab of idleTabs().filter((t) => t.connId === connId)) {
        const { id } = tab;
        jobs.push(
          api()
            .keepAliveSession(tab.sessionId!, idle)
            .then((health) => {
              if (health) reportTab(id, health, cause);
            })
            .catch(() => {}),
        );
      }
    }
    await Promise.all(jobs);
  } finally {
    keeping = false;
  }
}
