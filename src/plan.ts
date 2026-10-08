// Execution plans as one tree for every engine: PostgreSQL (EXPLAIN FORMAT JSON), MySQL / MariaDB (EXPLAIN /
// ANALYZE FORMAT=JSON), SQLite (EXPLAIN QUERY PLAN), SQL Server (SHOWPLAN_XML) and Azure Synapse (EXPLAIN). Each
// node says what the engine does, on what, with how many rows and how much it costs, plus the warnings worth
// acting on.
// Pure functions (SQL Server's needs a DOMParser): dev/plan-check.ts tests them on real plans.

export interface PlanNode {
  /** What the engine does: "Seq Scan", "Hash Join", "Búsqueda por índice"… */
  op: string;
  /** On what: table (alias), index. */
  target: string;
  /** Estimated rows. */
  rows: number | null;
  /** Estimated cost (the engine's units; PostgreSQL and SQL Server: including the children). */
  cost: number | null;
  /** With ANALYZE: rows really produced (per loop × loops for PostgreSQL), time in ms and loops. */
  actualRows: number | null;
  timeMs: number | null;
  loops: number | null;
  details: [string, string][];
  warnings: string[];
  children: PlanNode[];
}

export interface Plan {
  engine: string;
  root: PlanNode;
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
}

const node = (op: string, target = ""): PlanNode => ({ op, target, rows: null, cost: null, actualRows: null, timeMs: null, loops: null, details: [], warnings: [], children: [] });
const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string => (Array.isArray(value) ? value.map(text).join(", ") : value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
const fmt = (n: number) => Math.round(n).toLocaleString("es-ES");

/** A big full scan, with the rows it reads. */
const FULL_SCAN_ROWS = 10_000;

// ---------------------------------------------------------------- PostgreSQL

type PgNode = Record<string, unknown> & { Plans?: PgNode[] };

/** EXPLAIN (FORMAT JSON [, ANALYZE]) output: the JSON text of its single cell. */
export function parsePostgresPlan(json: string): Plan {
  const parsed = JSON.parse(json) as { Plan: PgNode; "Planning Time"?: number; "Execution Time"?: number }[];
  const top = parsed[0];
  const analyzed = top.Plan["Actual Total Time"] !== undefined;
  return { engine: "PostgreSQL", root: pgNode(top.Plan), analyzed, planningMs: num(top["Planning Time"]), executionMs: num(top["Execution Time"]) };
}

const PG_DETAILS = ["Index Cond", "Recheck Cond", "Filter", "Join Filter", "Hash Cond", "Merge Cond", "Sort Key", "Group Key", "Presorted Key", "Strategy", "Partial Mode", "Scan Direction", "Rows Removed by Filter", "Rows Removed by Index Recheck", "Rows Removed by Join Filter", "Sort Method", "Sort Space Used", "Sort Space Type", "Peak Memory Usage", "Workers Planned", "Workers Launched", "Shared Hit Blocks", "Shared Read Blocks", "Temp Read Blocks", "Temp Written Blocks", "Heap Fetches", "Subplan Name", "Parent Relationship", "Output"];

/**
 * `procs`: processes running this node at the same time (under a Gather: the workers plus the leader). Their
 * loops overlap, so the wall time is the per-loop average × loops ÷ processes.
 */
function pgNode(p: PgNode, underLimit = false, procs = 1): PlanNode {
  const type = text(p["Node Type"]);
  const join = p["Join Type"] && p["Join Type"] !== "Inner" ? ` (${text(p["Join Type"])})` : "";
  const op = `${type}${join}${p["Parallel Aware"] === true ? " paralelo" : ""}`;
  const relation = p["Relation Name"] ? `${p.Schema ? `${text(p.Schema)}.` : ""}${text(p["Relation Name"])}${p.Alias && p.Alias !== p["Relation Name"] ? ` ${text(p.Alias)}` : ""}` : p["CTE Name"] ? `CTE ${text(p["CTE Name"])}` : p["Function Name"] ? `${text(p["Function Name"])}()` : "";
  const index = p["Index Name"] ? `índice ${text(p["Index Name"])}` : "";
  const n = node(op, [relation, index].filter(Boolean).join(" · "));
  n.rows = num(p["Plan Rows"]);
  n.cost = num(p["Total Cost"]);
  n.loops = num(p["Actual Loops"]);
  const perLoop = num(p["Actual Rows"]);
  n.actualRows = perLoop === null ? null : perLoop * (n.loops ?? 1);
  const time = num(p["Actual Total Time"]);
  n.timeMs = time === null ? null : time * Math.max(1, (n.loops ?? 1) / procs);
  const KB = new Set(["Sort Space Used", "Peak Memory Usage"]);
  for (const key of PG_DETAILS) if (p[key] !== undefined) n.details.push([key, `${text(p[key])}${KB.has(key) ? " kB" : ""}`]);
  // Warnings worth acting on.
  if (/^Seq Scan/.test(type) && p.Filter !== undefined) {
    const removed = num(p["Rows Removed by Filter"]);
    if (n.actualRows !== null && removed !== null) {
      // Measured: worth an index when the filter throws most of a big table away.
      const kept = n.actualRows;
      const total = kept + removed * (n.loops ?? 1);
      if (total >= FULL_SCAN_ROWS && removed * (n.loops ?? 1) > kept) n.warnings.push(`Lee las ${fmt(total)} filas de la tabla y descarta ${fmt(total - kept)} por el filtro: un índice sobre sus columnas lo evitaría.`);
    } else if ((n.rows ?? 0) >= FULL_SCAN_ROWS / 10) {
      n.warnings.push("Recorre toda la tabla filtrando fila a fila: si el filtro es selectivo, un índice sobre sus columnas lo evitaría.");
    }
  }
  if (perLoop !== null && n.rows !== null) {
    const estimated = n.rows;
    const actual = perLoop;
    // Under a LIMIT fewer rows than estimated is expected (the plan stops early); more is always news.
    const over = estimated > Math.max(actual, 1) * 10 && !underLimit;
    if (Math.max(actual, estimated) >= 100 && (actual > estimated * 10 || over)) {
      n.warnings.push(`El planificador esperaba ${fmt(estimated)} filas y salieron ${fmt(actual)}: las estadísticas pueden estar desfasadas (ANALYZE en la tabla).`);
    }
  }
  if (p["Sort Space Type"] === "Disk" || /external/i.test(text(p["Sort Method"]))) n.warnings.push("La ordenación no cabe en memoria (work_mem) y usa disco.");
  if ((num(p["Temp Written Blocks"]) ?? 0) > 0 && !n.warnings.some((w) => w.includes("disco"))) n.warnings.push("Escribe datos temporales en disco.");
  const gather = /^Gather/.test(type) ? (num(p["Workers Launched"]) ?? num(p["Workers Planned"]) ?? 0) + 1 : procs;
  n.children = (p.Plans ?? []).map((child) => pgNode(child, underLimit || type === "Limit", gather));
  return n;
}

// ---------------------------------------------------------------- MySQL / MariaDB

type Json = Record<string, unknown>;

const ACCESS: Record<string, string> = {
  ALL: "Recorrido completo",
  index: "Recorrido de índice",
  range: "Rango de índice",
  ref: "Búsqueda por índice",
  eq_ref: "Búsqueda única por índice",
  ref_or_null: "Búsqueda por índice (o NULL)",
  const: "Fila constante",
  system: "Fila única",
  fulltext: "Búsqueda de texto completo",
  index_merge: "Unión de índices",
  unique_subquery: "Subconsulta por índice único",
  index_subquery: "Subconsulta por índice",
};

/** EXPLAIN FORMAT=JSON (MySQL 8, MariaDB) and MariaDB's ANALYZE FORMAT=JSON. */
export function parseMysqlPlan(json: string): Plan {
  const parsed = JSON.parse(json) as Json;
  const block = parsed.query_block as Json | undefined;
  if (!block || typeof block !== "object") throw new Error("El servidor no devolvió un plan para esta sentencia");
  const analyzed = block?.r_loops !== undefined || block?.r_total_time_ms !== undefined;
  const root = mysqlNode("query_block", block);
  const total = num((parsed.query_optimization as Json | undefined)?.r_total_time_ms);
  return { engine: "MySQL", root, analyzed, planningMs: null, executionMs: analyzed ? num(block.r_total_time_ms) ?? total : null };
}

const MYSQL_WRAPPERS: Record<string, string> = {
  query_block: "Consulta",
  nested_loop: "Bucle anidado",
  filesort: "Ordenación",
  ordering_operation: "Ordenación",
  grouping_operation: "Agrupación",
  temporary_table: "Tabla temporal",
  duplicates_removal: "Quitar duplicados",
  union_result: "Unión",
  materialized_from_subquery: "Subconsulta materializada",
  subqueries: "Subconsultas",
  attached_subqueries: "Subconsultas",
  optimized_away_subqueries: "Subconsultas resueltas al planificar",
  having_subqueries: "Subconsultas del HAVING",
  window_functions_computation: "Funciones de ventana",
  read_sorted_file: "Lectura ordenada",
  buffer_result: "Resultado en búfer",
};

function mysqlNode(key: string, value: unknown): PlanNode {
  const obj = (value ?? {}) as Json;
  if (key === "table") return mysqlTable(obj);
  const n = node(MYSQL_WRAPPERS[key] ?? key.replace(/_/g, " "));
  const costInfo = obj.cost_info as Json | undefined;
  n.cost = num(obj.cost) ?? num(costInfo?.query_cost) ?? num(costInfo?.sort_cost);
  n.timeMs = num(obj.r_total_time_ms);
  n.loops = num(obj.r_loops);
  if (obj.sort_key !== undefined) n.details.push(["Orden", text(obj.sort_key)]);
  if (obj.select_id !== undefined) n.details.push(["select_id", text(obj.select_id)]);
  if (obj.using_filesort === true) n.details.push(["Ordenación", "filesort"]);
  if (obj.using_temporary_table === true) n.details.push(["Tabla temporal", "sí"]);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "table") n.children.push(mysqlTable(v as Json));
    else if (Array.isArray(v)) n.children.push(...mysqlList(k, v));
    else if (v && typeof v === "object" && k in MYSQL_WRAPPERS) n.children.push(mysqlNode(k, v));
  }
  return n;
}

/** nested_loop: [{ table }…]; subqueries: [{ query_block }…]. Arrays of plain values (used_columns…) give nothing. */
function mysqlList(key: string, items: unknown[]): PlanNode[] {
  const list = node(MYSQL_WRAPPERS[key] ?? key.replace(/_/g, " "));
  for (const item of items) {
    if (item && typeof item === "object") for (const [ik, iv] of Object.entries(item as Json)) if (iv && typeof iv === "object" && !Array.isArray(iv)) list.children.push(mysqlNode(ik, iv));
  }
  if (key === "nested_loop" && list.children.length) return [list];
  return list.children.length === 1 ? list.children : list.children.length ? [list] : [];
}

function mysqlTable(t: Json): PlanNode {
  const access = text(t.access_type);
  const n = node(ACCESS[access] ?? (access || "Tabla"), [text(t.table_name), t.key ? `índice ${text(t.key)}` : ""].filter(Boolean).join(" · "));
  const costInfo = t.cost_info as Json | undefined;
  n.rows = num(t.rows) ?? num(t.rows_examined_per_scan);
  n.cost = num(t.cost) ?? num(costInfo?.prefix_cost);
  n.actualRows = num(t.r_rows);
  n.loops = num(t.r_loops) ?? num(t.loops);
  const tableMs = num(t.r_table_time_ms);
  n.timeMs = tableMs === null ? null : tableMs + (num(t.r_other_time_ms) ?? 0);
  const pairs: [string, unknown][] = [
    ["Claves posibles", t.possible_keys],
    ["Partes del índice", t.used_key_parts],
    ["ref", t.ref],
    ["Condición", t.attached_condition],
    ["Condición en el índice", t.index_condition],
    ["Filtrado", t.filtered !== undefined ? `${text(t.filtered)} %` : undefined],
    ["Filtrado real", t.r_filtered !== undefined ? `${text(t.r_filtered)} %` : undefined],
    ["Solo índice", t.using_index === true ? "sí" : undefined],
  ];
  for (const [k, v] of pairs) if (v !== undefined && v !== null && text(v) !== "") n.details.push([k, text(v)]);
  if (access === "ALL" && (n.rows ?? 0) >= FULL_SCAN_ROWS) n.warnings.push(`Recorre toda la tabla (~${fmt(n.rows ?? 0)} filas)${t.attached_condition ? ": un índice sobre la condición lo evitaría" : ""}.`);
  if (n.actualRows !== null && n.rows !== null && Math.max(n.rows, n.actualRows) >= 100 && (n.actualRows > n.rows * 10 || n.rows > Math.max(n.actualRows, 1) * 10)) {
    n.warnings.push(`Se esperaban ${fmt(n.rows)} filas y salieron ${fmt(n.actualRows)}: ANALYZE TABLE actualiza las estadísticas.`);
  }
  for (const [k, v] of Object.entries(t)) {
    if (!(k in MYSQL_WRAPPERS)) continue;
    // attached_subqueries hang from the table that runs them.
    if (Array.isArray(v)) n.children.push(...mysqlList(k, v));
    else if (v && typeof v === "object") n.children.push(mysqlNode(k, v));
  }
  return n;
}

// ---------------------------------------------------------------- SQLite

/** EXPLAIN QUERY PLAN rows: id, parent, notused, detail. */
export function parseSqlitePlan(rows: unknown[][]): Plan {
  const root = node("Consulta");
  const byId = new Map<number, PlanNode>([[0, root]]);
  for (const row of rows) {
    const id = Number(row[0]);
    const parent = Number(row[1]);
    const detail = text(row[3]);
    const n = sqliteNode(detail);
    byId.set(id, n);
    (byId.get(parent) ?? root).children.push(n);
  }
  return { engine: "SQLite", root, analyzed: false, planningMs: null, executionMs: null };
}

function sqliteNode(detail: string): PlanNode {
  const scan = /^SCAN (\S+)(?: USING (?:COVERING )?INDEX (\S+))?/.exec(detail);
  const search = /^SEARCH (\S+) USING (?:(COVERING )?INDEX (\S+)|INTEGER PRIMARY KEY)\s*(\(.*\))?/.exec(detail);
  let n: PlanNode;
  if (search) n = node(search[3] ? (search[2] ? "Búsqueda por índice (solo índice)" : "Búsqueda por índice") : "Búsqueda por clave primaria", [search[1], search[3] ? `índice ${search[3]}` : "", search[4] ?? ""].filter(Boolean).join(" · "));
  else if (scan) {
    n = node(scan[2] ? "Recorrido de índice" : "Recorrido completo", [scan[1], scan[2] ? `índice ${scan[2]}` : ""].filter(Boolean).join(" · "));
    if (!scan[2]) n.warnings.push("Recorre la tabla entera: si filtras por una columna, un índice sobre ella lo evitaría.");
  } else if (/USE TEMP B-TREE FOR (?:(?:RIGHT PART|LAST TERM) OF )?(ORDER BY|GROUP BY|DISTINCT)/.test(detail)) {
    // "RIGHT PART OF ORDER BY" / "LAST TERM OF ORDER BY": an index already gives the first columns of the order.
    const [, part, what] = /FOR (?:((?:RIGHT PART|LAST TERM)) OF )?(ORDER BY|GROUP BY|DISTINCT)/.exec(detail)!;
    n = node(what === "ORDER BY" ? "Ordenación temporal" : what === "GROUP BY" ? "Agrupación temporal" : "DISTINCT temporal");
    if (part) n.target = "solo las últimas columnas";
    n.warnings.push(`Ordena en una estructura temporal: un índice que siga ${part ? "todo " : ""}el ${what} se la ahorraría.`);
  } else if (/^(CO-ROUTINE|MATERIALIZE|SUBQUERY|CORRELATED|COMPOUND|UNION|MULTI-INDEX)/.test(detail)) n = node(detail.split(" ")[0].replace(/-/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), detail.split(" ").slice(1).join(" "));
  else n = node(detail);
  n.details.push(["Detalle", detail]);
  return n;
}

// ---------------------------------------------------------------- SQL Server

/** SHOWPLAN_XML (needs a DOMParser: the app's WebView, or a polyfill in tests). */
export function parseMssqlPlan(xml: string, parser: { parseFromString(s: string, type: string): Document } = new DOMParser()): Plan {
  const doc = parser.parseFromString(xml, "application/xml");
  const plan = doc.getElementsByTagName("QueryPlan")[0];
  if (!plan) throw new Error("SQL Server no devolvió un plan para esta sentencia");
  const top = childRelOps(plan)[0];
  const root = top ? mssqlNode(top) : node("Consulta");
  const missing = [...plan.getElementsByTagName("MissingIndexGroup")];
  for (const group of missing) {
    const impact = group.getAttribute("Impact");
    const index = group.getElementsByTagName("MissingIndex")[0];
    const table = index ? `${index.getAttribute("Schema") ?? ""}.${index.getAttribute("Table") ?? ""}`.replace(/[[\]]/g, "") : "";
    const cols = [...group.getElementsByTagName("Column")].map((c) => c.getAttribute("Name")?.replace(/[[\]]/g, "")).filter(Boolean);
    root.warnings.push(`SQL Server sugiere un índice en ${table} (${cols.join(", ")})${impact ? `: mejora estimada del ${Math.round(Number(impact))} %` : ""}.`);
  }
  return { engine: "SQL Server", root, analyzed: false, planningMs: null, executionMs: null };
}

/** The RelOp elements whose nearest RelOp ancestor is `el` (its operator children). */
function childRelOps(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of [...parent.children]) {
      if (child.localName === "RelOp") out.push(child);
      else walk(child);
    }
  };
  walk(el);
  return out;
}

function mssqlNode(rel: Element): PlanNode {
  const physical = rel.getAttribute("PhysicalOp") ?? "";
  const logical = rel.getAttribute("LogicalOp") ?? "";
  // Its own object only (a Hash Match has none; the tables belong to the operators below it).
  const object = [...rel.children].flatMap((c) => [...c.getElementsByTagName("Object")]).find((o) => o.closest("RelOp") === rel);
  const clean = (s: string | null) => (s ?? "").replace(/[[\]]/g, "");
  const target = object ? [clean(object.getAttribute("Table")), object.getAttribute("Index") ? `índice ${clean(object.getAttribute("Index"))}` : ""].filter(Boolean).join(" · ") : "";
  const n = node(physical === logical || !logical ? physical : `${physical} (${logical})`, target);
  n.rows = num(rel.getAttribute("EstimateRows"));
  n.cost = num(rel.getAttribute("EstimatedTotalSubtreeCost"));
  for (const attr of ["EstimateIO", "EstimateCPU", "AvgRowSize", "Parallel"]) {
    const v = rel.getAttribute(attr);
    if (v !== null) n.details.push([attr, v]);
  }
  const predicate = [...rel.getElementsByTagName("Predicate")].find((p) => p.closest("RelOp") === rel);
  const scalar = predicate?.getElementsByTagName("ScalarOperator")[0]?.getAttribute("ScalarString");
  if (scalar) n.details.push(["Predicado", scalar]);
  const warnings = [...rel.children].find((c) => c.localName === "Warnings");
  if (warnings) {
    if (warnings.getAttribute("NoJoinPredicate") === "true") n.warnings.push("Join sin condición: producto cartesiano.");
    if (warnings.getElementsByTagName("ColumnsWithNoStatistics").length) n.warnings.push("Hay columnas sin estadísticas.");
    if (warnings.getElementsByTagName("SpillToTempDb").length) n.warnings.push("Se desborda a tempdb (memoria insuficiente).");
  }
  if (/Table Scan|Clustered Index Scan/.test(physical) && (n.rows ?? 0) >= FULL_SCAN_ROWS) n.warnings.push(`Recorre toda la tabla (~${fmt(n.rows ?? 0)} filas).`);
  n.children = childRelOps(rel).map(mssqlNode);
  return n;
}

// ---------------------------------------------------------------- Azure Synapse dedicated / PDW

/**
 * EXPLAIN de Azure Synapse dedicated / PDW (no tiene SHOWPLAN_XML): el plan distribuido, un nodo por paso
 * (movimientos de datos entre distribuciones, SQL en los nodos, devolución del resultado).
 */
export function parseSynapsePlan(xml: string, parser: { parseFromString(s: string, type: string): Document } = new DOMParser()): Plan {
  const doc = parser.parseFromString(xml, "application/xml");
  const ops = doc.getElementsByTagName("dsql_operations")[0];
  if (!ops) throw new Error("Azure Synapse no devolvió un plan para esta sentencia");
  const root = node("Consulta distribuida");
  root.cost = num(ops.getAttribute("total_cost"));
  const total = ops.getAttribute("total_number_operations");
  if (total) root.details.push(["Pasos", total]);
  for (const op of [...ops.children].filter((c) => c.localName === "dsql_operation")) {
    const type = op.getAttribute("operation_type") ?? "";
    const first = (tag: string) => op.getElementsByTagName(tag)[0] as Element | undefined;
    const content = (tag: string) => first(tag)?.textContent?.trim() ?? "";
    const n = node(type, [content("destination_table"), first("location")?.getAttribute("distribution") ?? ""].filter(Boolean).join(" · "));
    const cost = first("operation_cost");
    if (cost) {
      n.rows = num(cost.getAttribute("output_rows"));
      n.cost = num(cost.getAttribute("accumulative_cost"));
      for (const attr of ["cost", "average_rowsize"]) {
        const v = cost.getAttribute(attr);
        if (v !== null) n.details.push([attr, v]);
      }
    }
    if (content("shuffle_columns")) n.details.push(["Columnas de reparto", content("shuffle_columns")]);
    const statement = content("source_statement") || content("select") || content("sql_operation");
    if (statement) n.details.push(["SQL", statement]);
    if (/^(BROADCAST|SHUFFLE)_MOVE$/.test(type) && (n.rows ?? 0) >= FULL_SCAN_ROWS) {
      n.warnings.push(`Mueve ~${fmt(n.rows ?? 0)} filas entre distribuciones${type === "BROADCAST_MOVE" ? " (una copia a cada nodo)" : ""}.`);
    }
    root.children.push(n);
  }
  return { engine: "Azure Synapse", root, analyzed: false, planningMs: null, executionMs: null };
}

// ---------------------------------------------------------------- helpers for the view

/** Every node, depth first. */
export function flatten(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** The plan as indented text (to copy or paste in a ticket). */
export function planText(plan: Plan): string {
  const lines: string[] = [];
  const walk = (n: PlanNode, depth: number) => {
    const metrics = [n.rows !== null ? `filas≈${fmt(n.rows)}` : "", n.actualRows !== null ? `reales=${fmt(n.actualRows)}` : "", n.cost !== null ? `coste=${n.cost}` : "", n.timeMs !== null ? `${n.timeMs.toFixed(2)} ms` : ""].filter(Boolean).join(" ");
    lines.push(`${"  ".repeat(depth)}${depth ? "-> " : ""}${n.op}${n.target ? ` [${n.target}]` : ""}${metrics ? `  (${metrics})` : ""}`);
    for (const w of n.warnings) lines.push(`${"  ".repeat(depth + 2)}! ${w}`);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(plan.root, 0);
  if (plan.planningMs !== null) lines.push(`Planificación: ${plan.planningMs} ms`);
  if (plan.executionMs !== null) lines.push(`Ejecución: ${plan.executionMs} ms`);
  return lines.join("\n");
}
