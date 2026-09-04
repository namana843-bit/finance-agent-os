import { EventBus } from "./eventBus.js";
import { AgentRegistry } from "./agentRegistry.js";
import { ToolRegistry } from "./toolRegistry.js";
import type { FinanceAgent, LegacyAgent } from "./agent.js";
import { adaptLegacyAgent } from "./agent.js";
import type { Tool } from "./tool.js";

// ---------------------------------------------------------------------------
// FinanceRuntime — owns bus + agent registry + tool registry + lifecycle
// Reuses the existing EventBus implementation; no duplicate event system.
// ---------------------------------------------------------------------------

export interface FinanceRuntimeOptions {
  bus?: EventBus;
  maxHistory?: number;
}

export interface RuntimeHealth {
  uptimeMs: number;
  agents: ReturnType<AgentRegistry["health"]>;
  tools: string[];
  events: number;
  subscribers: number;
}

export class FinanceRuntime {
  readonly bus: EventBus;
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  private startedAt: number | null = null;

  constructor(opts: FinanceRuntimeOptions = {}) {
    this.bus = opts.bus ?? new EventBus({ maxHistory: opts.maxHistory ?? 10_000 });
    this.agents = new AgentRegistry();
    this.tools = new ToolRegistry(this.bus);
  }

  /** Register a first-class FinanceAgent. */
  registerAgent(agent: FinanceAgent): FinanceAgent {
    return this.agents.register(agent);
  }

  /** Reuse path for the 5 existing agents — wraps without rewriting them. */
  registerLegacyAgent(id: string, legacy: LegacyAgent, meta?: Partial<FinanceAgent>): FinanceAgent {
    const adapted = adaptLegacyAgent(id, legacy, meta);
    return this.agents.register(adapted);
  }

  registerTool(tool: Tool): Tool {
    return this.tools.register(tool);
  }

  async start(): Promise<void> {
    await this.agents.startAll();
    this.startedAt = Date.now();
    this.bus.publish({ type: "system.ready", data: { agents: this.agents.ids(), timestamp: Date.now() } });
  }

  async stop(): Promise<void> {
    await this.agents.stopAll();
    this.bus.publish({ type: "system.stopped", data: { timestamp: Date.now() } });
  }

  /** Multi-loop verification: run fn N times (agent pipeline ticks). */
  async runLoops<T>(iterations: number, fn: (i: number) => T | Promise<T>): Promise<T[]> {
    return this.agents.runLoops(iterations, fn);
  }

  health(): RuntimeHealth {
    return {
      uptimeMs: this.startedAt !== null ? Date.now() - this.startedAt : 0,
      agents: this.agents.health(),
      tools: this.tools.list().map((t) => t.name),
      events: this.bus.size(),
      subscribers: this.bus.subscriberCount(),
    };
  }

  getBus(): EventBus {
    return this.bus;
  }
}

export function createFinanceRuntime(opts?: FinanceRuntimeOptions): FinanceRuntime {
  return new FinanceRuntime(opts);
}

export default FinanceRuntime;
