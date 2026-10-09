import { Plug, TriangleAlert } from "lucide-solid";
import { onMount, Show } from "solid-js";
import { mcpLabel, mcpTooltip, staleClients } from "../mcpModel";
import { mcpStatus, startMcpStatus } from "../mcpStatus";
import { setState } from "../state";

/**
 * The status bar's MCP indicator: «MCP · Windows + WSL (Ubuntu)» while the MCP server is on (hidden when it is off),
 * with the clients and the last call in its tooltip. A click opens Settings › IA y MCP.
 */
export function McpIndicator() {
  onMount(startMcpStatus);
  const status = () => {
    const s = mcpStatus();
    return s?.enabled ? s : null;
  };
  return (
    <Show when={status()}>
      {(s) => (
        <button
          type="button"
          class="st-mcp"
          classList={{ stale: staleClients(s()).length > 0, idle: !s().clients.length }}
          title={mcpTooltip(s(), Date.now(), "Clic: Ajustes › IA y MCP")}
          onClick={() => setState({ settingsOpen: true, settingsSection: "ai" })}
        >
          <Show when={staleClients(s()).length} fallback={<Plug size={12} />}><TriangleAlert size={12} /></Show>
          <span>{mcpLabel(s())}</span>
        </button>
      )}
    </Show>
  );
}
