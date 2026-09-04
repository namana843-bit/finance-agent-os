import { BaseTool } from "../core/tool.js";
import type { EventBus } from "../core/eventBus.js";

// Query recent bus events. Read-only; used by agents for coordination.
export class EventLogTool extends BaseTool<{ type?: string; limit?: number }, { events: Array<{ id: string; type: string; timestamp: number }> }> {
  name = "event-log";
  description = "Read recent events from the bus (read-only coordination helper)";
  version = "0.1.0";
  inputSchema = {
    type: "object",
    properties: { type: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 200 } },
  };

  async execute(
    input: { type?: string; limit?: number },
    ctx?: { bus?: EventBus },
  ): Promise<{ events: Array<{ id: string; type: string; timestamp: number }> }> {
    const bus = ctx?.bus;
    if (!bus) throw new Error("event-log requires bus in context");
    const events = bus.getHistory(input.type ? { type: input.type } : undefined, input.limit ?? 20);
    return { events: events.map((e) => ({ id: e.id, type: e.type, timestamp: e.timestamp })) };
  }
}

export default EventLogTool;
