// Vigilancia de las conexiones abiertas:
// - al volver de una suspensión del equipo (el reloj salta) o de un corte de red (evento «online»), comprueba cada
//   sesión abierta (explorador, consolas, tablas) y el núcleo reconecta la que se cortó; una consola que tenía una
//   transacción o estado de sesión lo dice al momento, no en su siguiente sentencia;
// - al mostrar una consola, abre su sesión en segundo plano (y conecta su conexión si no pide contraseña).
// Lo que se ve: el indicador de la conexión en el explorador y en la pestaña (connStatus.ts).
import { createEffect, createRoot, on } from "solid-js";
import { api } from "./api";
import { markConn, markTab } from "./connStatus";
import { notify, patchTab, plainError, state, warmSqlSession } from "./state";

/** Cada cuánto mira el reloj, y qué salto se toma por una suspensión. */
const TICK_MS = 15_000;
const SLEPT_MS = 60_000;

let started = false;
let checking = false;

export function startConnWatch() {
  if (started) return;
  started = true;
  let last = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > TICK_MS + SLEPT_MS) void checkOpenSessions(`tras ${Math.round(gap / 60_000)} min de suspensión`);
  }, TICK_MS);
  window.addEventListener("online", () => void checkOpenSessions("al volver la red"));
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

/** Comprueba ya todas las sesiones abiertas (una ida y vuelta cada una, en paralelo) y anota lo que pasó. */
export async function checkOpenSessions(cause: string) {
  if (checking) return;
  checking = true;
  try {
    const jobs: Promise<void>[] = [];
    for (const [connId, session] of Object.entries(state.sessions)) {
      if (!session?.metaId) continue;
      jobs.push(
        api()
          .checkSession(session.metaId, true)
          .then((health) => {
            if (!health.ok) markConn(connId, "down", { note: plainError(health.error) });
            else if (health.reconnected) markConn(connId, "reconnected", { note: `Se había cortado ${cause}; reconectada en ${health.ms} ms` });
          })
          .catch(() => {}),
      );
    }
    for (const tab of state.tabs) {
      // A session at work answers when it ends (its statement tells what happened).
      if (!tab.connId || !tab.sessionId || (tab.kind === "sql" ? tab.running : tab.loading)) continue;
      const { id, title, kind } = tab;
      const sessionId = tab.sessionId;
      jobs.push(
        api()
          .checkSession(sessionId, true)
          .then((health) => {
            if (!health.ok) {
              markTab(id, "down", { note: plainError(health.error) });
            } else if (health.lost) {
              const text = plainError(health.lost);
              markTab(id, "lost", { note: text });
              if (kind === "sql") patchTab(id, { inTransaction: false });
              notify(`«${title}» perdió su sesión al cortarse la conexión`, "warning", text);
            } else if (health.reconnected) {
              markTab(id, "reconnected", { note: `Se había cortado ${cause}; reconectada en ${health.ms} ms` });
            }
          })
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
  } finally {
    checking = false;
  }
}
