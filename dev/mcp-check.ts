// Checks for src/mcpModel.ts: node --experimental-strip-types dev/mcp-check.ts
import assert from "node:assert/strict";
import { actsInApp, aiTabTitle, callText, clientText, isTyping, mcpLabel, mcpPlaces, mcpTooltip, staleClients, timeAgo, toolLabel, TYPING_MS } from "../src/mcpModel.ts";
import type { McpStatus } from "../src/types.ts";

const now = 1_760_000_000_000;

// ---------------------------------------------------------------- time
assert.equal(timeAgo(now - 10_000, now), "ahora");
assert.equal(timeAgo(now - 3 * 60_000, now), "hace 3 min");
assert.equal(timeAgo(now - 2 * 3_600_000, now), "hace 2 h");
assert.equal(timeAgo(now - 26 * 3_600_000, now), "ayer");
assert.equal(timeAgo(now - 5 * 86_400_000, now), "hace 5 días");
assert.equal(timeAgo(now + 5_000, now), "ahora", "a clock a little ahead is not the future");

// ---------------------------------------------------------------- where the clients run
const both: McpStatus = {
  appControl: false,
  enabled: true,
  clients: [
    { name: "Claude Code", place: "WSL (Ubuntu)", state: "yes" },
    { name: "Claude Desktop", place: "Windows", state: "yes" },
    { name: "Claude Code", place: "Windows", state: "yes" },
    { name: "Claude Code", place: "WSL (Debian)", state: "stale" },
  ],
  wslChecked: true,
  lastCall: { at: now - 120_000, tool: "run_query", connName: "Ventas", ok: true, client: "WSL (Ubuntu)", clientApp: "claude-code" },
};
assert.equal(mcpPlaces(both), "Windows + WSL (Ubuntu, Debian)", "Windows first, the distros together");
assert.equal(mcpLabel(both), "MCP · Windows + WSL (Ubuntu, Debian)");
assert.equal(mcpLabel({ clients: [{ name: "Claude Code", place: "WSL (Ubuntu)", state: "yes" }] }), "MCP · WSL (Ubuntu)");
assert.equal(mcpLabel({ clients: [] }), "MCP · activo", "on, but no client registered yet");
assert.deepEqual(staleClients(both), ["Claude Code en WSL (Debian)"]);
assert.equal(callText(both.lastCall!), "run_query · Ventas · WSL (Ubuntu)");

const tip = mcpTooltip(both, now, "Clic: Ajustes › IA y MCP").split("\n");
assert.match(tip[0], /^Servidor MCP activo/);
assert.equal(tip[1], "Clientes: Claude Code en WSL (Ubuntu), Claude Desktop en Windows, Claude Code en Windows, Claude Code en WSL (Debian)");
assert.equal(tip[2], "⚠ Claude Code en WSL (Debian) usa otra ruta de Celer: vuelve a registrarlo");
assert.equal(tip[3], "Última llamada: hace 2 min · run_query · Ventas · WSL (Ubuntu)");
assert.equal(tip[4], "Clic: Ajustes › IA y MCP");
const quiet = mcpTooltip({ enabled: true, appControl: false, clients: [], wslChecked: false, lastCall: { at: now, tool: "execute_statement", ok: false } }, now, "x").split("\n");
assert.equal(quiet[1], "Buscando clientes…", "WSL not read yet");
assert.equal(quiet[2], "Última llamada: ahora · execute_statement (rechazada)");

// ---------------------------------------------------------------- the AI acting in the app (#100)
assert.equal(clientText({ client: "WSL (Ubuntu)", clientApp: "claude-code" }), "claude-code · WSL (Ubuntu)");
assert.equal(clientText({ client: "Windows" }), "Windows");
assert.equal(clientText({}), "", "entries written before the client was kept");
assert.equal(toolLabel({ tool: "open_console", detail: "[ejecutar] SELECT 1" }), "Abrió y ejecutó una consola");
assert.equal(toolLabel({ tool: "open_console", detail: "SELECT 1" }), "Abrió una consola");
assert.equal(toolLabel({ tool: "run_query" }), "Consulta de lectura");
assert.equal(toolLabel({ tool: "some_future_tool" }), "some_future_tool");
assert.ok(actsInApp("open_table") && actsInApp("add_library_script") && !actsInApp("list_library") && !actsInApp("run_query"));
assert.equal(isTyping(now - 1000, now, true), true);
assert.equal(isTyping(now - 1000, now, false), false, "a window without the focus is not being typed in");
assert.equal(isTyping(now - TYPING_MS - 1, now, true), false);
assert.equal(isTyping(0, now, true), false, "nothing typed yet");
assert.equal(aiTabTitle(now - 3 * 60_000, now, "claude-code · Windows"), "Abierto por la IA · hace 3 min (claude-code · Windows)");
assert.equal(aiTabTitle(now - 5_000, now), "Abierto por la IA · ahora");

console.log("mcp-check: all good");
