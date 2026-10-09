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
