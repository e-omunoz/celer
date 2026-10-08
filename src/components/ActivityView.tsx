import { Ban, LoaderCircle, OctagonX, RefreshCw } from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isBusy, type ServerSession } from "../activity";
import { activityAction, closeActivity, formatMs, now, refreshActivity, state } from "../state";
import { Dialog } from "./Modals";

/**
 * Server activity: every session with its user, database, client, state, wait and what it is running, newest
 * work first. Refreshes by itself; a session's running statement can be cancelled or the session ended.
 */
export function ActivityView() {
  const act = () => state.activity!;
  const [onlyBusy, setOnlyBusy] = createSignal(false);
  const [auto, setAuto] = createSignal(true);
  const [query, setQuery] = createSignal("");
  const [expanded, setExpanded] = createSignal<string | null>(null);
  let timer = 0;
  onMount(() => {
    timer = window.setInterval(() => {
      if (auto() && !act().loading && act().sessionId) void refreshActivity();
    }, 3000);
  });
  onCleanup(() => window.clearInterval(timer));

  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return act().sessions.filter(
      (s) => (!onlyBusy() || isBusy(s)) && (!q || [s.id, s.user, s.database, s.app, s.client, s.state, s.query].some((v) => v.toLowerCase().includes(q))),
    );
  });
  const blocked = createMemo(() => new Set(act().sessions.filter((s) => s.blockedBy).flatMap((s) => s.blockedBy.split(/,\s*/))));
  const busyCount = createMemo(() => act().sessions.filter(isBusy).length);

  const duration = (s: ServerSession) => (s.durationMs === null ? "" : formatMs(s.durationMs));
  const slow = (s: ServerSession) => isBusy(s) && (s.durationMs ?? 0) > 10_000;

  return (
    <Dialog title={`Actividad del servidor · ${act().title}`} wide class="activity-dialog" onClose={closeActivity}>
      <div class="activity-tools">
        <span class="muted small">
          {act().sessions.length} {act().sessions.length === 1 ? "sesión" : "sesiones"} · {busyCount()} {busyCount() === 1 ? "activa" : "activas"}
          <Show when={act().updatedAt}> · actualizado hace {Math.max(0, Math.round((now() - act().updatedAt) / 1000))} s</Show>
        </span>
        <span class="spacer" />
        <input class="activity-search" placeholder="Filtrar por usuario, base, consulta…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        <label class="check"><input type="checkbox" checked={onlyBusy()} onChange={(event) => setOnlyBusy(event.currentTarget.checked)} /> Solo activas</label>
        <label class="check"><input type="checkbox" checked={auto()} onChange={(event) => setAuto(event.currentTarget.checked)} /> Cada 3 s</label>
        <button type="button" class="icon-btn" title="Actualizar" disabled={act().loading || !act().sessionId} onClick={() => void refreshActivity()}>
          <Show when={act().loading} fallback={<RefreshCw size={14} />}><LoaderCircle size={14} class="spin" /></Show>
        </button>
      </div>
      <Show when={act().error}>
        <p class="activity-error">{act().error}</p>
      </Show>
      <div class="activity-table">
        <div class="activity-row head">
          <span>ID</span>
          <span>Usuario</span>
          <span>Base</span>
          <span>Cliente</span>
          <span>Estado</span>
          <span>Duración</span>
          <span>Consulta</span>
          <span />
        </div>
        <For each={shown()} fallback={<p class="muted activity-empty">{act().loading && !act().updatedAt ? "Leyendo sesiones…" : "No hay sesiones que mostrar."}</p>}>
          {(s) => (
            <>
              <div
                class="activity-row"
                classList={{ self: s.self, busy: isBusy(s), slow: slow(s), blocked: Boolean(s.blockedBy), blocking: blocked().has(s.id), open: expanded() === s.id }}
                onClick={() => setExpanded(expanded() === s.id ? null : s.id)}
              >
                <span class="mono">{s.id}</span>
                <span title={s.user}>{s.user}</span>
                <span title={s.database}>{s.database}</span>
                <span title={[s.app, s.client].filter(Boolean).join(" · ")}>{s.app || s.client}</span>
                <span title={s.wait ? `Espera: ${s.wait}` : s.state}>
                  {s.state}
                  <Show when={s.wait}><small> · {s.wait}</small></Show>
                </span>
                <span class="mono num">{duration(s)}</span>
                <span class="mono query" title={s.query}>
                  <Show when={s.self} fallback={s.query.replace(/\s+/g, " ")}><em>esta ventana (el monitor)</em></Show>
                </span>
                <span class="activity-actions" onClick={(event) => event.stopPropagation()}>
                  <Show when={!s.self && act().canCancel && isBusy(s)}>
                    <button type="button" class="icon-btn tiny" title="Cancelar la consulta en curso" onClick={() => void activityAction(s.id, "cancel")}><Ban size={13} /></button>
                  </Show>
                  <Show when={!s.self && act().canKill}>
                    <button type="button" class="icon-btn tiny danger" title="Terminar la sesión" onClick={() => void activityAction(s.id, "kill")}><OctagonX size={13} /></button>
                  </Show>
                </span>
              </div>
              <Show when={expanded() === s.id}>
                <div class="activity-detail">
                  <Show when={s.blockedBy}><p class="activity-warn">Bloqueada por la sesión {s.blockedBy}.</p></Show>
                  <Show when={blocked().has(s.id)}><p class="activity-warn">Está bloqueando a otras sesiones.</p></Show>
                  <pre>{s.query || "(sin sentencia en curso)"}</pre>
                </div>
              </Show>
            </>
          )}
        </For>
      </div>
    </Dialog>
  );
}
