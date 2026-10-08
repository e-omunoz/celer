// Estado de la conexión de cada conexión guardada (explorador) y de cada pestaña: conectando, conectada (con lo que
// tardó), reconectada sola, perdida. Lo alimentan connect(), las sesiones de las consolas, los errores con código del
// núcleo (SESSION_LOST, CONN_RESET, CONN_DOWN) y la comprobación al volver de una suspensión.
import { createStore, produce } from "solid-js/store";
import { state, type Tab } from "./state";

/**
 * off: sin sesión · connecting: conectando · on: lista · reconnected: se cortó y volvió sola (sin perder nada) ·
 * lost: se cortó y se perdió estado (transacción, #temporales, SET) · down: no se pudo volver a conectar.
 */
export type Link = "off" | "connecting" | "on" | "reconnected" | "lost" | "down";

export interface LinkInfo {
  link: Link;
  /** Lo que tardó la última conexión (ms) y si se tomó una conexión libre de la misma configuración. */
  connectMs: number | null;
  reused: boolean;
  /** Cuándo cambió (Date.now()). */
  at: number;
  /** Qué pasó, para el tooltip ("Se cortó tras la suspensión; reconectada en 240 ms"). */
  note: string;
}

const EMPTY: LinkInfo = { link: "off", connectMs: null, reused: false, at: 0, note: "" };

const [links, setLinks] = createStore({ conns: {} as Record<string, LinkInfo>, tabs: {} as Record<string, LinkInfo> });

/** Principio de la nota del núcleo cuando una sesión se recupera sola (`RECOVERED` en src-tauri/src/guard.rs). */
export const RECOVERED_PREFIX = "Conexión recuperada";

/** Los avisos (reconectada, perdida) se quedan un rato y luego vuelven a «on». */
const NOTICE_MS = 10 * 60_000;

function settle(info: LinkInfo | undefined): LinkInfo | undefined {
  if (!info) return info;
  if ((info.link === "reconnected" || info.link === "lost") && Date.now() - info.at > NOTICE_MS) return { ...info, link: "on" };
  return info;
}

/** El estado de una conexión guardada, para el explorador. */
export function connLink(connId: string | null | undefined): LinkInfo {
  if (!connId) return EMPTY;
  const own = settle(links.conns[connId]);
  if (state.connecting[connId]) return { ...(own ?? EMPTY), link: "connecting" };
  if (!state.sessions[connId]) return own?.link === "down" ? own : { ...(own ?? EMPTY), link: "off" };
  if (!own || own.link === "off" || own.link === "connecting") return { ...(own ?? EMPTY), link: "on" };
  return own;
}

/** El estado de la sesión de una pestaña (consola o tabla). */
export function tabLink(tab: Tab): LinkInfo {
  if (!tab.connId) return EMPTY;
  const own = settle(links.tabs[tab.id]);
  if (own?.link === "connecting") return own;
  if (!tab.sessionId) {
    // Sin sesión propia todavía: se abre al ejecutar (o ya, si la conexión está conectada).
    if (own?.link === "down" || own?.link === "lost") return own;
    return { ...(own ?? EMPTY), link: state.connecting[tab.connId] ? "connecting" : "off" };
  }
  if (!own || own.link === "off") return { ...(own ?? EMPTY), link: "on" };
  return own;
}

export function markConn(connId: string, link: Link, patch: Partial<Omit<LinkInfo, "link" | "at">> = {}) {
  const before = links.conns[connId] ?? EMPTY;
  setLinks("conns", connId, { ...before, ...patch, link, at: Date.now() });
}

export function markTab(tabId: string, link: Link, patch: Partial<Omit<LinkInfo, "link" | "at">> = {}) {
  const before = links.tabs[tabId] ?? EMPTY;
  setLinks("tabs", tabId, { ...before, ...patch, link, at: Date.now() });
}

export function forgetTab(tabId: string) {
  setLinks(
    "tabs",
    produce((tabs) => {
      delete tabs[tabId];
    }),
  );
}

/** «84 ms», «84 ms · conexión reutilizada». */
export function connectTimeText(info: LinkInfo): string {
  if (info.connectMs === null) return "";
  const ms = info.connectMs < 1000 ? `${Math.round(info.connectMs)} ms` : `${(info.connectMs / 1000).toFixed(1)} s`;
  return info.reused ? `${ms} · conexión reutilizada` : ms;
}

/** Texto del tooltip de un indicador. */
export function linkTitle(info: LinkInfo): string {
  const time = connectTimeText(info);
  const base: Record<Link, string> = {
    off: "Sin conectar",
    connecting: "Conectando…",
    on: time ? `Conectada en ${time}` : "Conectada",
    reconnected: "Se cortó y Celer volvió a conectar",
    lost: "Se cortó la conexión y se perdió el estado de la sesión",
    down: "Sin conexión con el servidor",
  };
  return [base[info.link], info.note].filter(Boolean).join("\n");
}
