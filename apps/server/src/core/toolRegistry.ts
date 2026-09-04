import type { EventBus } from "./eventBus.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateAgainstSchema } from "./tool.js";

// ---------------------------------------------------------------------------
// ToolRegistry — single source of truth for agent-callable tools
// ---------------------------------------------------------------------------

export interface ToolCallResult<T = unknown> {
  ok: boolean;
  tool: string;
  output?: T;
  error?: string;
  durationMs: number;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private bus: EventBus | null;

  constructor(bus?: EventBus) {
    this.bus = bus ?? null;
  }

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  register(tool: Tool): Tool {
    if (!tool || typeof tool !== "object") throw new Error("tool must be an object");
    if (!tool.name || typeof tool.name !== "string" || tool.name.trim() === "") {
      throw new Error("tool.name is required and must be a non-empty string");
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`tool ${tool.name} must implement execute()`);
    }
    const name = tool.name.trim();
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.tools.set(name, tool);
    return tool;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  describe(): Array<{ name: string; description: string; version?: string; requiresApproval?: boolean }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      version: t.version,
      requiresApproval: t.requiresApproval,
    }));
  }

  size(): number {
    return this.tools.size;
  }

  clear(): void {
    this.tools.clear();
  }

  async execute<T = unknown>(name: string, input: unknown, ctx?: ToolContext): Promise<ToolCallResult<T>> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, tool: name, error: `unknown tool: ${name}`, durationMs: Date.now() - started };
    }
    if (tool.requiresApproval) {
      return { ok: false, tool: name, error: "tool requires approval", durationMs: Date.now() - started };
    }
    try {
      if (tool.inputSchema) validateAgainstSchema(input, tool.inputSchema, "input");
      this.emit("tool.called", { tool: name, input, agentId: ctx?.agentId, runId: ctx?.runId });
      const output = (await tool.execute(input, ctx)) as T;
      if (tool.outputSchema) validateAgainstSchema(output, tool.outputSchema, "output");
      this.emit("tool.completed", { tool: name, agentId: ctx?.agentId, runId: ctx?.runId });
      return { ok: true, tool: name, output, durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("tool.failed", { tool: name, error: message, agentId: ctx?.agentId, runId: ctx?.runId });
      return { ok: false, tool: name, error: message, durationMs: Date.now() - started };
    }
  }

  private emit(type: string, data: unknown): void {
    if (!this.bus) return;
    try {
      this.bus.publish({ type, data });
    } catch {
      // tool events must never crash execution
    }
  }
}

export default ToolRegistry;
