// ============================================================================
// Event Log tool — query recent bus events. Read-only coordination helper.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import type { ToolContext } from "./finance-tools.js";

export function eventLogTool(): ToolDefinition {
  return {
    id: "event_log",
    name: "Event Log",
    description: "Read recent events from the bus (read-only coordination helper)",
    inputSchema: { type: "object", properties: { type: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 200 } } },
    outputSchema: { type: "object", properties: { events: { type: "array" } } },
    permissions: { required: false },
  };
}

export function executeEventLog(
  ctx: ToolContext,
  input: Record<string, unknown>,
): { events: Array<{ id: string; type: string; timestamp: number }> } {
  const limit = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 200);
  const events = ctx.bus.getHistory(input.type ? { type: String(input.type) } : undefined, limit);
  return { events: events.map((e) => ({ id: e.id, type: e.type, timestamp: e.timestamp })) };
}
