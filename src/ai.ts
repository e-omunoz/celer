import Anthropic from "@anthropic-ai/sdk";
import { api, errorText } from "./api";
import { activeSql, connectionById, notify, openInspector, setState, state } from "./state";
import { engineOf } from "./types";
import { aiVariableLines, findVariables } from "./variables";
import { resolvedFor, scopeText } from "./variableStore";

export type AiModel = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-4-5";

export const AI_MODELS: { id: AiModel; label: string; hint: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "El más capaz · recomendado" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Rápido y capaz" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "El más rápido y económico" },
];

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
  /** What the user asked for, shown instead of the full prompt with context. */
  label?: string;
  streaming?: boolean;
  error?: boolean;
}

export type AiAction = "ask" | "generate" | "explain" | "fix" | "optimize";

const MAX_SCHEMA_CHARS = 24_000;

/** Schema summary for the prompt: table names with column names (no data). */
function schemaContext(): { text: string; tables: number } {
  const tab = activeSql();
  const connId = tab?.connId;
  if (!connId) return { text: "", tables: 0 };
  const tables = tab?.completion?.tables ?? state.catalog[connId]?.tables ?? [];
  let text = "";
  let count = 0;
  for (const table of tables) {
    const line = `${table.schema && table.schema !== "main" ? `${table.schema}.` : ""}${table.name}(${table.columns.join(", ")})\n`;
    if (text.length + line.length > MAX_SCHEMA_CHARS) break;
    text += line;
    count++;
  }
  return { text, tables: count };
}

/** What will be sent to the model, so the panel can show it before sending. */
export function aiContextSummary() {
  const tab = activeSql();
  const conn = connectionById(tab?.connId);
  const schema = schemaContext();
  return {
    engine: conn ? engineOf(conn.kind).label : "",
    database: tab?.database ?? "",
    tables: schema.tables,
    hasSql: Boolean(tab?.sql.trim()),
    hasError: Boolean(tab?.error),
  };
}

/**
 * Whether the assistant may see data of a connection: the AI access level of Ajustes › IA lets it read rows ("read" or
 * "write"). Variable values are data: below that level only their names are sent.
 */
async function dataAllowed(connId: string | null | undefined): Promise<boolean> {
  if (!connId) return false;
  try {
    const level = (await api().mcpConfigGet()).connections[connId]?.level ?? "none";
    return level === "read" || level === "write";
  } catch {
    return false;
  }
}

/** The ${variables} of the SQL sent: their names and scope always, their values only where data is allowed. */
async function variablesContext(): Promise<string> {
  const tab = activeSql();
  if (!tab) return "";
  const kind = connectionById(tab.connId)?.kind;
  const names = [...new Set(findVariables(tab.selection.trim() || tab.sql, kind).map((ref) => ref.name))];
  if (!names.length) return "";
  const resolved = resolvedFor(tab);
  const values = await dataAllowed(tab.connId);
  const lines = aiVariableLines(names, resolved, values, (variable) => scopeText(variable, tab.connId), kind);
  return `<variables nota="\${nombre} es una variable de Celer: se sustituye por su valor al ejecutar">\n${lines.join("\n")}\n</variables>`;
}

function buildPrompt(action: AiAction, request: string, variables = ""): { system: string; user: string } {
  const tab = activeSql();
  const conn = connectionById(tab?.connId);
  const engine = conn ? engineOf(conn.kind).label : "SQL estándar";
  const schema = schemaContext();
  const system = [
    "Eres el asistente SQL integrado en Celer, un cliente de bases de datos de escritorio.",
    `El usuario trabaja con ${engine}${tab?.database ? `, base de datos «${tab.database}»` : ""}. Escribe SQL válido para ese motor.`,
    "Responde en español, de forma breve y directa. Cuando propongas una consulta, ponla en un único bloque ```sql para que el usuario pueda insertarla o ejecutarla.",
    "Usa solo las tablas y columnas del esquema que se te da; si falta información o el esquema no contiene lo necesario, dilo en lugar de inventar nombres.",
    "Para sentencias que modifican datos (UPDATE, DELETE, DDL), avisa del efecto y sugiere un WHERE o una transacción cuando sea prudente.",
    "Las referencias ${nombre} son variables de Celer: déjalas tal cual en el SQL que propongas.",
  ].join("\n");
  const parts: string[] = [];
  if (schema.text) parts.push(`<esquema tablas="${schema.tables}">\n${schema.text}</esquema>`);
  const sql = tab?.selection.trim() || tab?.sql.trim() || "";
  if (sql && action !== "generate") parts.push(`<sql_actual>\n${sql.slice(0, 12_000)}\n</sql_actual>`);
  if (variables && action !== "generate") parts.push(variables);
  if (action === "fix" && tab?.error) parts.push(`<error_del_servidor>\n${tab.error.slice(0, 4000)}\n</error_del_servidor>`);
  const task: Record<AiAction, string> = {
    ask: request,
    generate: `Escribe la consulta SQL para: ${request}`,
    explain: "Explica qué hace esta consulta, paso a paso y en pocas líneas, y señala cualquier problema de rendimiento o de corrección.",
    fix: "La consulta ha fallado con el error indicado. Explica la causa en una frase y da la consulta corregida.",
    optimize: "Propón una versión más eficiente de esta consulta si la hay, y los índices que ayudarían. Explica el porqué en pocas líneas.",
  };
  parts.push(task[action]);
  return { system, user: parts.join("\n\n") };
}

let controller: AbortController | null = null;

async function apiKey(): Promise<string | null> {
  try {
    return await api().aiKeyGet();
  } catch {
    return null;
  }
}

export async function askAi(action: AiAction, request = "") {
  if (state.ai.running) return;
  const key = await apiKey();
  openInspector("ai");
  if (!key) {
    setState("ai", "needsKey", true);
    return;
  }
  const { system, user } = buildPrompt(action, request, await variablesContext());
  const labels: Record<AiAction, string> = {
    ask: request,
    generate: `Generar SQL: ${request}`,
    explain: "Explicar la consulta",
    fix: "Corregir el error",
    optimize: "Optimizar la consulta",
  };
  // Earlier turns are sent as plain text so follow-up questions keep their context.
  const history: Anthropic.MessageParam[] = state.ai.messages
    .filter((message) => !message.error && !message.streaming)
    .slice(-8)
    .map((message) => ({ role: message.role, content: message.text }));
  const turn: AiMessage[] = [
    { role: "user", text: user, label: labels[action] },
    { role: "assistant", text: "", streaming: true },
  ];
  setState("ai", "messages", (list) => [...list, ...turn]);
  setState("ai", "running", true);
  const index = state.ai.messages.length - 1;
  const turnRef = state.ai.messages[index];
  // The conversation can be cleared while this answer streams: only write while our message is still there.
  const alive = () => state.ai.messages[index] === turnRef;
  controller = new AbortController();
  const model = state.settings.aiModel as AiModel;
  try {
    // The key never leaves this machine except towards api.anthropic.com.
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const params: Record<string, unknown> = {
      model,
      max_tokens: 16000,
      system,
      messages: [...history, { role: "user", content: user }],
    };
    if (model !== "claude-haiku-4-5") {
      // Opus 5.5 / Sonnet 5.5: explicit effort, plus server-side fallback if a safety classifier declines.
      params.output_config = { effort: "medium" };
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const stream = client.beta.messages.stream(params as never, { signal: controller.signal });
    stream.on("text", (delta) => alive() && setState("ai", "messages", index, "text", (text) => text + delta));
    const final = await stream.finalMessage();
    if (!alive()) return;
    if (final.stop_reason === "refusal") {
      setState("ai", "messages", index, { text: "El modelo no ha respondido a esta petición. Reformúlala o prueba otra pregunta.", error: true });
    } else if (final.stop_reason === "max_tokens") {
      setState("ai", "messages", index, "text", (text) => `${text}\n\n_(respuesta cortada por longitud)_`);
    }
  } catch (err) {
    const aborted = controller?.signal.aborted;
    let message = errorText(err);
    if (err instanceof Anthropic.AuthenticationError) message = "La clave de API no es válida. Cámbiala en Ajustes › IA.";
    else if (err instanceof Anthropic.RateLimitError) message = "Límite de uso alcanzado. Espera un momento y vuelve a intentarlo.";
    else if (err instanceof Anthropic.APIConnectionError) message = "Sin conexión con la API de Anthropic.";
    else if (err instanceof Anthropic.APIError) message = `Error de la API (${err.status}): ${err.message}`;
    if (alive()) setState("ai", "messages", index, aborted ? { text: state.ai.messages[index].text || "Detenido." } : { text: message, error: true });
  } finally {
    setState("ai", "running", false);
    controller = null;
    if (alive()) setState("ai", "messages", index, "streaming", false);
  }
}

export function stopAi() {
  controller?.abort();
}

export function clearAi() {
  stopAi();
  setState("ai", "messages", []);
}

export async function saveAiKey(key: string) {
  try {
    await api().aiKeySet(key.trim());
    setState("ai", { hasKey: Boolean(key.trim()), needsKey: false });
    notify(key.trim() ? "Clave guardada en el almacén seguro del sistema" : "Clave eliminada", "success");
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export async function refreshAiKeyStatus() {
  try {
    setState("ai", "hasKey", await api().aiKeyStatus());
  } catch {
    setState("ai", "hasKey", false);
  }
}

/** Extracts the SQL code blocks of an answer, in order. */
export function sqlBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:sql|SQL|postgresql|mysql|tsql)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(match[1].trim());
  return out;
}
