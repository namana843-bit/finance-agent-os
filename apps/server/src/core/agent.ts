import type { EventBus, FinanceEvent } from "./eventBus.js";

// ---------------------------------------------------------------------------
// Agent lifecycle — OpenMausBot-inspired, finance-specific
// Reuses existing EventBus; no duplicate bus architecture.
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface AgentHealth {
  status: AgentStatus;
  uptimeMs: number | null;
  lastEventAt: number | null;
  lastError: string | null;
  details?: Record<string, unknown>;
}

export interface AgentMetadata {
  /** Unique id, e.g. "market", "quant", "risk", "portfolio", "execution" */
  id: string;
  /** Human-readable name, e.g. "Market Agent" */
  name: string;
  description?: string;
  version?: string;
  /** Ids of agents that must start before this one */
  dependencies?: string[];
  capabilities?: string[];
}

/**
 * Clean agent interface every finance agent must satisfy.
 * Existing agents (Market/Quant/Risk/Portfolio/Execution) already provide
 * start/stop/isRunning — this interface formalizes that contract plus
 * health + event routing so the registry/runtime can manage them uniformly.
 */
export interface FinanceAgent extends AgentMetadata {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  isRunning(): boolean;
  getStatus(): AgentStatus;
  getHealth(): AgentHealth;
  /** Optional event router — called by BaseAgent subscription */
  handleEvent?(event: FinanceEvent): void | Promise<void>;
}

/** Legacy agents expose only start/stop/isRunning + name. Adapt them. */
export interface LegacyAgent {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  isRunning(): boolean;
  handleEvent?(event: FinanceEvent): void | Promise<void>;
}

export interface BaseAgentOptions {
  id: string;
  name: string;
  description?: string;
  version?: string;
  dependencies?: string[];
  capabilities?: string[];
  bus?: EventBus;
}

/**
 * Base class for all new finance agents.
 * - Idempotent start/stop with status transitions
 * - Auto-subscribes to bus and routes to handleEvent with error isolation
 * - Publishes agent lifecycle events (agent.started/stopped/error)
 * - Tracks uptime, last event, last error for health checks
 */
export abstract class BaseAgent implements FinanceAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly dependencies?: string[];
  readonly capabilities?: string[];

  protected bus: EventBus | null;
  private status: AgentStatus = "idle";
  private startedAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private eventTypes: Set<string> | null; // null = all events

  constructor(opts: BaseAgentOptions) {
    if (!opts.id || typeof opts.id !== "string" || opts.id.trim() === "") {
      throw new Error("BaseAgent requires a non-empty id");
    }
    if (!opts.name || typeof opts.name !== "string" || opts.name.trim() === "") {
      throw new Error("BaseAgent requires a non-empty name");
    }
    this.id = opts.id.trim();
    this.name = opts.name;
    this.description = opts.description;
    this.version = opts.version ?? "0.1.0";
    this.dependencies = opts.dependencies ? [...opts.dependencies] : [];
    this.capabilities = opts.capabilities ? [...opts.capabilities] : [];
    this.bus = opts.bus ?? null;
    this.eventTypes = null;
  }

  /** Override to declare interest in a subset of event types. Default: all. */
  protected subscribedEvents(): string[] | null {
    return null;
  }

  /** Override — called once on start after subscription is set up. */
  protected abstract onStart(): void | Promise<void>;

  /** Override — called once on stop before unsubscribing. */
  protected abstract onStop(): void | Promise<void>;

  /** Override — route one event. Default no-op. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleEvent(_event: FinanceEvent): void | Promise<void> {
    return undefined;
  }

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  getBus(): EventBus | null {
    return this.bus;
  }

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") return;
    this.status = "starting";
    try {
      if (this.bus) {
        this.eventTypes = new Set(this.subscribedEvents() ?? []);
        const wantsAll = this.subscribedEvents() === null;
        this.unsubscribe = this.bus.subscribe((event) => {
          this.lastEventAt = Date.now();
          try {
            if (!wantsAll && !this.eventTypes!.has(event.type)) return;
            const result = this.handleEvent(event);
            if (result instanceof Promise) {
              result.catch((err) => this.recordError(err));
            }
          } catch (err) {
            this.recordError(err);
          }
        });
      }
      await this.onStart();
      this.startedAt = Date.now();
      this.status = "running";
      this.publishLifecycle("agent.started");
    } catch (err) {
      this.status = "error";
      this.recordError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "idle" || this.status === "stopped" || this.status === "stopping") {
      return;
    }
    this.status = "stopping";
    try {
      await this.onStop();
    } catch (err) {
      this.recordError(err);
    } finally {
      if (this.unsubscribe) {
        try {
          this.unsubscribe();
        } catch {
          // ignore
        }
        this.unsubscribe = null;
      }
      this.status = "stopped";
      this.publishLifecycle("agent.stopped");
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    this.status = "idle";
    await this.start();
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getHealth(): AgentHealth {
    return {
      status: this.status,
      uptimeMs: this.startedAt !== null ? Date.now() - this.startedAt : null,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      details: { id: this.id, name: this.name, version: this.version },
    };
  }

  protected publish(eventType: string, data: unknown): void {
    if (!this.bus) return;
    try {
      this.bus.publish({ type: eventType, data, agentId: this.id });
    } catch (err) {
      this.recordError(err);
    }
  }

  private publishLifecycle(type: string): void {
    if (!this.bus) return;
    try {
      this.bus.publish({
        type,
        agentId: this.id,
        data: { agentId: this.id, name: this.name, status: this.status, timestamp: Date.now() },
      });
    } catch {
      // lifecycle events must never crash the agent
    }
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = message;
    if (this.status === "running") {
      // stay running but surface error event; only onStart failures flip to error
      this.publishLifecycle("agent.error");
    }
    console.error(`[${this.name}] error:`, err);
  }
}

/**
 * Adapt a legacy agent (Market/Quant/Risk/Portfolio/Execution) to the
 * FinanceAgent contract without rewriting its internals.
 * Reuses existing code — no duplicate architecture.
 */
export function adaptLegacyAgent(id: string, legacy: LegacyAgent, meta?: Partial<AgentMetadata>): FinanceAgent {
  const startedAtHolder: { at: number | null } = { at: null };
  let stopped = false;
  return {
    id,
    name: legacy.name ?? meta?.name ?? id,
    description: meta?.description ?? `Legacy ${id} agent`,
    version: meta?.version ?? "0.1.0",
    dependencies: meta?.dependencies ?? [],
    capabilities: meta?.capabilities ?? [],
    start: async () => {
      await legacy.start();
      if (startedAtHolder.at === null) startedAtHolder.at = Date.now();
      stopped = false;
    },
    stop: async () => {
      await legacy.stop();
      stopped = true;
    },
    isRunning: () => {
      try {
        return legacy.isRunning();
      } catch {
        return !stopped && startedAtHolder.at !== null;
      }
    },
    getStatus: () => {
      try {
        if (legacy.isRunning()) return "running" as AgentStatus;
        return startedAtHolder.at === null ? ("idle" as AgentStatus) : ("stopped" as AgentStatus);
      } catch {
        return "error" as AgentStatus;
      }
    },
    getHealth: () => ({
      status: (() => {
        try {
          if (legacy.isRunning()) return "running" as AgentStatus;
          return startedAtHolder.at === null ? ("idle" as AgentStatus) : ("stopped" as AgentStatus);
        } catch {
          return "error" as AgentStatus;
        }
      })(),
      uptimeMs: startedAtHolder.at !== null ? Date.now() - startedAtHolder.at : null,
      lastEventAt: null,
      lastError: null,
      details: { id, legacy: true },
    }),
    handleEvent: legacy.handleEvent ? (e) => legacy.handleEvent!(e) : undefined,
  };
}

export default BaseAgent;
