// The MCP server as the interface shows it, without the app around it: the status bar's indicator (which clients
// have Celer registered, in Windows and in WSL, and the last call). Pure functions, tested by dev/mcp-check.ts;
// mcpStatus.ts reads the core.
import type { McpAuditEntry, McpStatus } from "./types";

/** "hace 3 min": how long ago, for tooltips and the activity list. */
export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "ahora";
  const min = Math.round(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
}

/** Where the clients run: "Windows + WSL (Ubuntu, Debian)" (Windows first), "" when none is registered. */
export function mcpPlaces(status: Pick<McpStatus, "clients">): string {
  const native: string[] = [];
  const wsl: string[] = [];
  for (const client of status.clients) {
    const distro = /^WSL \((.*)\)$/.exec(client.place);
    if (distro) {
      if (!wsl.includes(distro[1])) wsl.push(distro[1]);
    } else if (!native.includes(client.place)) native.push(client.place);
  }
  return [...native, ...(wsl.length ? [`WSL (${wsl.join(", ")})`] : [])].join(" + ");
}

/** The indicator's text: "MCP · Windows + WSL (Ubuntu)", or "MCP · activo" while no client is registered. */
export function mcpLabel(status: Pick<McpStatus, "clients">): string {
  return `MCP · ${mcpPlaces(status) || "activo"}`;
}

/** A client registered with another path of celer.exe (an update or a reinstall moved it): register it again. */
export function staleClients(status: Pick<McpStatus, "clients">): string[] {
  return status.clients.filter((c) => c.state === "stale").map((c) => `${c.name} en ${c.place}`);
}

/** "run_query · Demo · WSL (Ubuntu)": one call of the audit log in a line. */
export function callText(entry: McpAuditEntry): string {
  return [entry.tool, entry.connName, entry.client].filter(Boolean).join(" · ");
}

/** The indicator's tooltip: the clients, the last call and what a click does. */
export function mcpTooltip(status: McpStatus, now: number, click: string): string {
  const lines = ["Servidor MCP activo: los asistentes usan tus conexiones con los permisos de Ajustes › IA y MCP"];
  lines.push(status.clients.length ? `Clientes: ${status.clients.map((c) => `${c.name} en ${c.place}`).join(", ")}` : status.wslChecked ? "Ningún cliente registrado todavía" : "Buscando clientes…");
  for (const stale of staleClients(status)) lines.push(`⚠ ${stale} usa otra ruta de Celer: vuelve a registrarlo`);
  lines.push(status.lastCall ? `Última llamada: ${timeAgo(status.lastCall.at, now)} · ${callText(status.lastCall)}${status.lastCall.ok ? "" : " (rechazada)"}` : "Sin llamadas todavía");
  lines.push(click);
  return lines.join("\n");
}

/** "claude-code · WSL (Ubuntu)": who called, as the audit log has it. */
export function clientText(entry: { client?: string | null; clientApp?: string | null }): string {
  return [entry.clientApp, entry.client].filter(Boolean).join(" · ");
}

const TOOL_LABELS: Record<string, string> = {
  list_connections: "Listó las conexiones",
  list_databases: "Listó las bases de datos",
  list_tables: "Listó las tablas",
  describe_table: "Describió una tabla",
  search_objects: "Buscó tablas y columnas",
  sample_rows: "Leyó filas de ejemplo",
  run_query: "Consulta de lectura",
  execute_statement: "Sentencia que modifica",
  get_app_state: "Miró qué tienes abierto",
  list_library: "Listó la biblioteca",
  get_library_script: "Leyó un script de la biblioteca",
  add_library_script: "Añadió un script a la biblioteca",
  open_console: "Abrió una consola",
  open_table: "Abrió una tabla",
  open_er_diagram: "Mostró un diagrama E-R",
  open_object: "Mostró una definición",
};

/** What an audit entry did, in Spanish, for «Actividad de la IA». */
export function toolLabel(entry: Pick<McpAuditEntry, "tool" | "detail">): string {
  if (entry.tool === "open_console" && entry.detail?.startsWith("[ejecutar]")) return "Abrió y ejecutó una consola";
  return TOOL_LABELS[entry.tool] ?? entry.tool;
}

/** The tool acted in the app (opened something, wrote to the library) rather than only reading. */
export function actsInApp(tool: string): boolean {
  return tool.startsWith("open_") || tool === "add_library_script";
}

/** How long after the last key the user still counts as typing: an assistant's tab then opens in the background. */
export const TYPING_MS = 4000;

export function isTyping(lastKey: number, now: number, focused: boolean): boolean {
  return focused && lastKey > 0 && now - lastKey < TYPING_MS;
}

/** The tooltip of a tab an assistant opened: «Abierto por la IA · hace 3 min (claude-code · WSL (Ubuntu))». */
export function aiTabTitle(at: number, now: number, client?: string): string {
  return `Abierto por la IA · ${timeAgo(at, now)}${client ? ` (${client})` : ""}`;
}
