import { Show } from "solid-js";
import { linkTitle, tabLink, type LinkInfo } from "../connStatus";
import type { Tab } from "../state";

/**
 * Indicador del estado de una conexión: el punto de color en el explorador (sobre el icono del motor) y en las
 * pestañas. Conectada: el color de la conexión; conectando: ámbar que late; reconectada: ámbar fijo; estado de
 * sesión perdido o sin conexión: rojo. Nunca solo color: el tooltip lo dice con palabras.
 */
export function LinkDot(props: { info: LinkInfo; color?: string; class?: string }) {
  return (
    <i
      class={`link-dot ${props.class ?? ""}`}
      classList={{ [props.info.link]: true }}
      style={{ background: props.info.link === "on" ? props.color : undefined }}
      title={linkTitle(props.info)}
      aria-label={linkTitle(props.info)}
    />
  );
}

/** El indicador de una pestaña: solo cuando dice algo (conectando, reconectada, perdida, sin conexión). */
export function TabLink(props: { tab: Tab }) {
  const info = () => tabLink(props.tab);
  return (
    <Show when={info().link !== "on" && info().link !== "off"}>
      <LinkDot info={info()} class="tab-link" />
    </Show>
  );
}
