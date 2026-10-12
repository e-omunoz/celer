// The status bar's MCP indicator: whether the MCP server is on, which clients have Celer registered (Windows and
// WSL distros) and the last call, read from the core now and then (src-tauri/src/mcp.rs, `status`). The text and
// tooltip are worked out in mcpModel.ts.
import { createSignal } from "solid-js";
import { api } from "./api";
import type { McpStatus } from "./types";

const [mcpStatus, setMcpStatus] = createSignal<McpStatus | null>(null);
export { mcpStatus };

let started = false;

export async function refreshMcpStatus() {
  try {
    setMcpStatus(await api().mcpStatus());
  } catch {
    // The last one stays: the indicator is only informative.
  }
}

/** Reads the status now, every 15 s while the window is visible, and whenever it gets the focus. */
export function startMcpStatus() {
  if (started) return;
  started = true;
  void refreshMcpStatus();
  window.setInterval(() => {
    if (!document.hidden) void refreshMcpStatus();
  }, 15_000);
  window.addEventListener("focus", () => void refreshMcpStatus());
}
