import { ChevronRight, Copy, ExternalLink, Gauge, RefreshCw, TriangleAlert } from "lucide-solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { flatten, planText, type Plan, type PlanNode } from "../plan";
import { canAnalyze, copyText, explainStatement, formatMs, type SqlTab } from "../state";
import { isTauri } from "../api";
import { detachPanel, isPanelWindow } from "../windows";

/**
 * An execution plan as a tree: what each step does, on what, rows (estimated, and real with ANALYZE), and a bar
 * with its share of the cost (or of the time, when analyzed). Warnings are flagged on their step and counted
 * in the header; a click shows a step's details.
 */
export function PlanView(props: { tab: SqlTab; plan: Plan; sql: string }) {
  const nodes = createMemo(() => flatten(props.plan.root));
  const [collapsed, setCollapsed] = createSignal(new Set<PlanNode>());
  const [selected, setSelected] = createSignal<PlanNode | null>(null);
  const warnings = createMemo(() => nodes().reduce((n, node) => n + node.warnings.length, 0));
  /** Bars: share of the root's time when analyzed, of its cost otherwise. */
  const total = createMemo(() => (props.plan.analyzed ? props.plan.root.timeMs : props.plan.root.cost) || Math.max(1, ...nodes().map((n) => (props.plan.analyzed ? n.timeMs : n.cost) ?? 0)));
  const share = (n: PlanNode) => {
    const value = props.plan.analyzed ? n.timeMs : n.cost;
    return value === null || !total() ? 0 : Math.min(1, value / total()!);
  };
  const toggle = (n: PlanNode) => {
    const next = new Set(collapsed());
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setCollapsed(next);
  };
  const fmt = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString("es-ES"));
  /** Plan times are often under a millisecond: keep two decimals there. */
  const ms = (n: number | null) => (n === null ? "—" : n < 10 ? `${n.toLocaleString("es-ES", { maximumFractionDigits: 2 })} ms` : formatMs(n));

  const Row = (rowProps: { node: PlanNode; depth: number }) => {
    const n = rowProps.node;
    const open = () => !collapsed().has(n);
    return (
      <>
        <div class="plan-row" classList={{ selected: selected() === n, warn: n.warnings.length > 0 }} onClick={() => setSelected(selected() === n ? null : n)}>
          <span class="plan-op" style={{ "padding-left": `${8 + rowProps.depth * 18}px` }}>
            <Show when={n.children.length} fallback={<span class="plan-twist-space" />}>
              <button type="button" class="plan-twist" classList={{ open: open() }} onClick={(event) => { event.stopPropagation(); toggle(n); }}>
                <ChevronRight size={12} />
              </button>
            </Show>
            <b>{n.op}</b>
            <Show when={n.target}><span class="plan-target">{n.target}</span></Show>
            <Show when={n.warnings.length}><TriangleAlert size={13} class="plan-warn-icon" /></Show>
          </span>
          <span class="plan-num" title="Filas estimadas">{fmt(n.rows)}</span>
          <Show when={props.plan.analyzed}>
            <span class="plan-num" classList={{ off: n.actualRows !== null && n.rows !== null && (n.actualRows > n.rows * 10 || n.rows > Math.max(n.actualRows, 1) * 10) }} title="Filas reales">{fmt(n.actualRows)}</span>
            <span class="plan-num" title="Tiempo (incluye los pasos de debajo)">{ms(n.timeMs)}</span>
          </Show>
          <span class="plan-bar" title={props.plan.analyzed ? "Parte del tiempo total" : `Coste ${n.cost ?? "—"}`}>
            <i style={{ width: `${Math.round(share(n) * 100)}%` }} classList={{ hot: share(n) > 0.5 }} />
          </span>
        </div>
        <Show when={selected() === n}>
          <div class="plan-detail" style={{ "margin-left": `${26 + rowProps.depth * 18}px` }}>
            <For each={n.warnings}>{(w) => <p class="plan-warning"><TriangleAlert size={13} /> {w}</p>}</For>
            <dl>
              <Show when={n.cost !== null}><dt>Coste</dt><dd>{n.cost}</dd></Show>
              <Show when={n.loops !== null}><dt>Bucles</dt><dd>{n.loops}</dd></Show>
              <For each={n.details}>{([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>}</For>
            </dl>
          </div>
        </Show>
        <Show when={open()}>
          <For each={n.children}>{(child) => <Row node={child} depth={rowProps.depth + 1} />}</For>
        </Show>
      </>
    );
  };

  return (
    <div class="plan-view">
      <div class="plan-head">
        <Gauge size={15} />
        <b>Plan de ejecución</b>
        <span class="tag">{props.plan.engine}</span>
        <span class="tag" classList={{ ok: props.plan.analyzed }}>{props.plan.analyzed ? "real (ANALYZE)" : "estimado"}</span>
        <Show when={props.plan.planningMs !== null}><span class="muted small">planificación {ms(props.plan.planningMs)}</span></Show>
        <Show when={props.plan.executionMs !== null}><span class="muted small">ejecución {ms(props.plan.executionMs)}</span></Show>
        <Show when={warnings()}>
          <button type="button" class="tag warn plan-warn-chip" title="Ir al primer aviso" onClick={() => setSelected(nodes().find((n) => n.warnings.length) ?? null)}>
            <TriangleAlert size={12} /> {warnings()} {warnings() === 1 ? "aviso" : "avisos"}
          </button>
        </Show>
        <span class="spacer" />
        <Show when={!props.plan.analyzed && canAnalyze(props.tab, props.sql)}>
          <button type="button" class="btn tiny" title="EXPLAIN ANALYZE: ejecuta la consulta y mide cada paso" disabled={props.tab.running} onClick={() => void explainStatement(props.tab.id, props.sql, true)}>Analizar (ejecuta la consulta)</button>
        </Show>
        <button type="button" class="tb-icon" title="Volver a planificar" disabled={props.tab.running} onClick={() => void explainStatement(props.tab.id, props.sql, props.plan.analyzed)}><RefreshCw size={14} /></button>
        <button type="button" class="tb-icon" title="Copiar el plan como texto" onClick={() => void copyText(planText(props.plan), "Plan copiado")}><Copy size={14} /></button>
        <Show when={isTauri() && !isPanelWindow()}>
          <button type="button" class="tb-icon" title="Abrir el plan en su propia ventana" onClick={() => void detachPanel("plan")}><ExternalLink size={14} /></button>
        </Show>
      </div>
      <div class="plan-cols">
        <span>Paso</span>
        <span class="plan-num">Filas est.</span>
        <Show when={props.plan.analyzed}>
          <span class="plan-num">Reales</span>
          <span class="plan-num">Tiempo</span>
        </Show>
        <span>{props.plan.analyzed ? "% del tiempo" : "% del coste"}</span>
      </div>
      <div class="plan-tree" classList={{ analyzed: props.plan.analyzed }}>
        {/* Keyed: a new plan (re-plan, ANALYZE) rebuilds the rows instead of reusing the old nodes. */}
        <Show when={props.plan} keyed>
          {(plan) => <Row node={plan.root} depth={0} />}
        </Show>
      </div>
    </div>
  );
}
