// ============================================================================
// Finance Agent OS — Agent Abstraction
// Base interface and lifecycle for all finance agents
// ============================================================================

import type { FinanceEvent, AgentHealth, AgentStatus } from "@finance/shared";

export interface AgentConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: string[];

  /** Start the agent. Idempotent. */
  start(): Promise<void>;

  /** Stop the agent gracefully. Idempotent. */
  stop(): Promise<void>;

  /** Restart the agent (stop then start). */
  restart(): Promise<void>;

  /** Get current status. */
  getStatus(): AgentStatus;

  /** Get health metrics. */
  getHealth(): AgentHealth;

  /** Handle an incoming event. Called by the event bus. */
  handleEvent(event: FinanceEvent): Promise<void>;
}

/**
 * Base agent class with common lifecycle management.
 * Concrete agents extend this and implement handleEvent().
 */
export abstract class BaseAgent implements Agent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: string[];

  protected _status: AgentStatus = "idle";
  protected _startedAt: number = 0;
  protected _errorCount: number = 0;
  protected _eventsProcessed: number = 0;
  protected _lastActivity: number = 0;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.version = config.version;
    this.description = config.description;
    this.capabilities = [...config.capabilities];
  }

  async start(): Promise<void> {
    if (this._status === "running") return;
    this._status = "running";
    this._startedAt = Date.now();
    this._lastActivity = Date.now();
    console.log(`[agent:${this.id}] started`);
  }

  async stop(): Promise<void> {
    if (this._status === "stopped") return;
    this._status = "stopped";
    console.log(`[agent:${this.id}] stopped`);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): AgentStatus {
    return this._status;
  }

  getHealth(): AgentHealth {
    return {
      status: this._status,
      uptime: this._status === "running" ? Date.now() - this._startedAt : 0,
      lastActivity: this._lastActivity,
      errorCount: this._errorCount,
      eventsProcessed: this._eventsProcessed,
    };
  }

  abstract handleEvent(event: FinanceEvent): Promise<void>;

  protected recordActivity(): void {
    this._lastActivity = Date.now();
    this._eventsProcessed++;
  }

  protected recordError(err: unknown): void {
    this._errorCount++;
    console.error(`[agent:${this.id}] error:`, err);
  }
}
