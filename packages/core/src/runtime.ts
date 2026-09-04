// ============================================================================
// Finance Agent OS — Finance Runtime
// Central orchestrator that manages the lifecycle of all components.
// ============================================================================

import { TypedEventBus } from "./event-bus.js";
import {
  AgentRegistry,
  ToolRegistry,
  PluginRegistry,
  StrategyRegistry,
  ServiceRegistry,
} from "./registries.js";
import {
  LifecycleManager,
  LifecyclePhase,
} from "./lifecycle.js";
import type { Agent } from "./agent.js";
import type { ToolDefinition, StrategyConfig, PluginInfo } from "@finance/shared";
import type {
  PluginLifecycle,
  ToolHandler,
  StrategyHandler,
  ServiceLifecycle,
  ServiceInfo,
} from "./registries.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EventBusConfig {
  /** Maximum events to retain in history. Default: 50_000 */
  maxHistory?: number;
}

export interface RuntimeConfig {
  /** Server port. Default: 4132 */
  port?: number;
  /** Server host. Default: "0.0.0.0" */
  host?: string;
  /** Execution mode — paper or live. Default: "paper" */
  executionMode?: "paper" | "live";
  /** Log level. Default: "info" */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Runtime version. Default: "0.1.0" */
  version?: string;
  /** Event bus configuration. */
  eventBus?: EventBusConfig;
}

/** Resolved configuration with all defaults applied. */
export interface ResolvedRuntimeConfig {
  port: number;
  host: string;
  executionMode: "paper" | "live";
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
  eventBus: Required<EventBusConfig>;
}

// ---------------------------------------------------------------------------
// Status & Health
// ---------------------------------------------------------------------------

export interface ComponentCounts {
  agents: number;
  tools: number;
  plugins: number;
  strategies: number;
  services: number;
}

export interface RuntimeStatus {
  /** Canonical lifecycle phase. */
  phase: LifecyclePhase;
  /** Whether the runtime is fully operational. */
  running: boolean;
  /** Milliseconds since the runtime started (0 if not started). */
  uptime: number;
  /** Resolved configuration (no undefined fields). */
  config: Readonly<ResolvedRuntimeConfig>;
  /** Component counts. */
  components: ComponentCounts;
  /** Event bus size. */
  eventBusSize: number;
  /** Number of lifecycle transitions so far. */
  lifecycleTransitions: number;
}

export interface RuntimeHealth {
  /** Aggregate health: "healthy" if all components ok, "degraded" if any warning, "unhealthy" if any critical. */
  status: "healthy" | "degraded" | "unhealthy";
  /** Current lifecycle phase. */
  phase: LifecyclePhase;
  /** Milliseconds since started. */
  uptime: number;
  /** Per-agent health. */
  agents: Record<string, ReturnType<Agent["getHealth"]>>;
  /** Per-plugin status. */
  plugins: ReturnType<PluginRegistry["list"]>;
  /** Per-service status. */
  services: ServiceInfo[];
  /** Component counts. */
  components: ComponentCounts;
  /** Event bus size. */
  eventBusSize: number;
}

// ---------------------------------------------------------------------------
// Runtime Events
// ---------------------------------------------------------------------------

export const RuntimeEvents = {
  STARTING: "runtime.starting",
  STARTED: "runtime.started",
  STOPPING: "runtime.stopping",
  STOPPED: "runtime.stopped",
  ERROR: "runtime.error",
  HEALTH_CHECK: "runtime.health_check",
} as const;

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ResolvedRuntimeConfig = {
  port: 4132,
  host: "0.0.0.0",
  executionMode: "paper",
  logLevel: "info",
  version: "0.1.0",
  eventBus: { maxHistory: 50_000 },
};

function resolveConfig(input: RuntimeConfig): ResolvedRuntimeConfig {
  return {
    port: input.port ?? DEFAULT_CONFIG.port,
    host: input.host ?? DEFAULT_CONFIG.host,
    executionMode: input.executionMode ?? DEFAULT_CONFIG.executionMode,
    logLevel: input.logLevel ?? DEFAULT_CONFIG.logLevel,
    version: input.version ?? DEFAULT_CONFIG.version,
    eventBus: {
      maxHistory: input.eventBus?.maxHistory ?? DEFAULT_CONFIG.eventBus.maxHistory,
    },
  };
}

// ---------------------------------------------------------------------------
// FinanceRuntime
// ---------------------------------------------------------------------------

/**
 * The Finance Runtime is the central orchestrator.
 *
 * It manages the full lifecycle of all components:
 * - Agents — business logic, signal generation, decision-making
 * - Tools — callable capabilities
 * - Plugins — external data sources with lifecycle
 * - Strategies — pluggable trading strategies
 * - Services — infrastructure with lifecycle
 *
 * Lifecycle phases (in order):
 *   CREATED → REGISTERING → INITIALIZING → STARTING → RUNNING → STOPPING → DRAINING → STOPPED
 */
export class FinanceRuntime {
  private readonly config: ResolvedRuntimeConfig;
  private readonly eventBus: TypedEventBus;
  private readonly agentRegistry: AgentRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly pluginRegistry: PluginRegistry;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly serviceRegistry: ServiceRegistry;
  private readonly lifecycle: LifecycleManager;
  private startedAt: number = 0;

  constructor(input: RuntimeConfig = {}) {
    this.config = resolveConfig(input);

    this.eventBus = new TypedEventBus({
      maxHistory: this.config.eventBus.maxHistory,
    });
    this.agentRegistry = new AgentRegistry();
    this.toolRegistry = new ToolRegistry();
    this.pluginRegistry = new PluginRegistry();
    this.strategyRegistry = new StrategyRegistry();
    this.serviceRegistry = new ServiceRegistry();
    this.lifecycle = new LifecycleManager();

    this.log("info", `Finance Runtime v${this.config.version} created`);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the runtime through all lifecycle phases.
   * Phases: REGISTERING → INITIALIZING → STARTING → RUNNING
   */
  async start(): Promise<void> {
    if (this.lifecycle.isRunning()) return;

    // If previously stopped, reset to CREATED so we can go through phases again
    if (this.lifecycle.isStopped()) {
      this.lifecycle.reset();
    }

    this.log("info", "Starting Finance Runtime...");

    // Phase: REGISTERING → INITIALIZING
    // (registration happens during createRuntime, so we advance past REGISTERING)
    await this.lifecycle.advance(); // → REGISTERING
    await this.lifecycle.advance(); // → INITIALIZING

    this.emit(RuntimeEvents.STARTING, {
      version: this.config.version,
      executionMode: this.config.executionMode,
    });

    // Initialize and start plugins
    this.log("info", "Initializing plugins...");
    await this.pluginRegistry.initializeAll();
    await this.pluginRegistry.startAll();

    // Initialize and start services
    this.log("info", "Initializing services...");
    await this.serviceRegistry.initializeAll();
    await this.serviceRegistry.startAll();

    // Phase: INITIALIZING → STARTING
    await this.lifecycle.advance(); // → STARTING

    // Start agents
    this.log("info", "Starting agents...");
    await this.agentRegistry.startAll();

    // Phase: STARTING → RUNNING
    await this.lifecycle.advance(); // → RUNNING
    this.startedAt = Date.now();

    const counts = this.getComponentCounts();
    this.log("info", `Finance Runtime started on ${this.config.host}:${this.config.port}`);
    this.log("info", `Execution mode: ${this.config.executionMode}`);
    this.log(
      "info",
      `Components: ${counts.agents} agents, ${counts.tools} tools, ${counts.plugins} plugins, ${counts.strategies} strategies, ${counts.services} services`,
    );

    this.emit(RuntimeEvents.STARTED, {
      version: this.config.version,
      host: this.config.host,
      port: this.config.port,
      executionMode: this.config.executionMode,
      components: counts,
    });
  }

  /**
   * Stop the runtime through all shutdown phases.
   * Phases: STOPPING → DRAINING → STOPPED
   */
  async stop(): Promise<void> {
    if (this.lifecycle.isStopped()) return;
    if (this.lifecycle.getPhase() === LifecyclePhase.CREATED) {
      // Never started — transition directly to STOPPED
      await this.lifecycle.transitionTo(LifecyclePhase.STOPPING);
      await this.lifecycle.transitionTo(LifecyclePhase.DRAINING);
      await this.lifecycle.transitionTo(LifecyclePhase.STOPPED);
      return;
    }

    this.log("info", "Stopping Finance Runtime...");

    this.emit(RuntimeEvents.STOPPING, {});

    // If we haven't started yet, jump to STOPPING
    if (this.lifecycle.getPhase() !== LifecyclePhase.RUNNING) {
      await this.lifecycle.transitionTo(LifecyclePhase.STOPPING);
    } else {
      await this.lifecycle.transitionTo(LifecyclePhase.STOPPING); // → STOPPING
    }

    // Stop agents first (they produce events)
    await this.agentRegistry.stopAll();

    // Phase: STOPPING → DRAINING
    await this.lifecycle.transitionTo(LifecyclePhase.DRAINING);

    // Stop services and plugins (infrastructure)
    await this.serviceRegistry.stopAll();
    await this.pluginRegistry.stopAll();

    // Phase: DRAINING → STOPPED
    await this.lifecycle.transitionTo(LifecyclePhase.STOPPED);

    this.log("info", "Finance Runtime stopped");

    this.emit(RuntimeEvents.STOPPED, {
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    });
  }

  /**
   * Stop then start the runtime.
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  registerAgent(agent: Agent): void {
    this.agentRegistry.register(agent);
  }

  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.toolRegistry.register(definition, handler);
  }

  registerPlugin(info: PluginInfo, lifecycle: PluginLifecycle): void {
    this.pluginRegistry.register(info, lifecycle);
  }

  registerStrategy(config: StrategyConfig, handler: StrategyHandler): void {
    this.strategyRegistry.register(config, handler);
  }

  registerService(service: ServiceLifecycle): void {
    this.serviceRegistry.register(service);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  getEventBus(): TypedEventBus {
    return this.eventBus;
  }

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPluginRegistry(): PluginRegistry {
    return this.pluginRegistry;
  }

  getStrategyRegistry(): StrategyRegistry {
    return this.strategyRegistry;
  }

  getServiceRegistry(): ServiceRegistry {
    return this.serviceRegistry;
  }

  getService<T extends ServiceLifecycle>(id: string): T | undefined {
    return this.serviceRegistry.get(id) as T | undefined;
  }

  getLifecycle(): LifecycleManager {
    return this.lifecycle;
  }

  getConfig(): Readonly<ResolvedRuntimeConfig> {
    return this.config;
  }

  // -------------------------------------------------------------------------
  // Status & Health
  // -------------------------------------------------------------------------

  /**
   * Get the current runtime status — a lightweight snapshot of the runtime state.
   */
  getStatus(): RuntimeStatus {
    const phase = this.lifecycle.getPhase();
    return {
      phase,
      running: this.lifecycle.isRunning(),
      uptime: this.lifecycle.isRunning() ? Date.now() - this.startedAt : 0,
      config: { ...this.config },
      components: this.getComponentCounts(),
      eventBusSize: this.eventBus.size(),
      lifecycleTransitions: this.lifecycle.getLog().length,
    };
  }

  /**
   * Get comprehensive health information including per-component status.
   */
  async getHealth(): Promise<RuntimeHealth> {
    const agents = await this.agentRegistry.health();
    const plugins = this.pluginRegistry.list();
    const services = this.serviceRegistry.listInfo();
    const components = this.getComponentCounts();

    // Compute aggregate status
    const aggregateStatus = this.computeAggregateStatus(agents, services);

    return {
      status: aggregateStatus,
      phase: this.lifecycle.getPhase(),
      uptime: this.lifecycle.isRunning() ? Date.now() - this.startedAt : 0,
      agents,
      plugins,
      services,
      components,
      eventBusSize: this.eventBus.size(),
    };
  }

  /**
   * Check if the runtime is in a fully operational state.
   */
  isRunning(): boolean {
    return this.lifecycle.isRunning();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getComponentCounts(): ComponentCounts {
    return {
      agents: this.agentRegistry.size(),
      tools: this.toolRegistry.size(),
      plugins: this.pluginRegistry.size(),
      strategies: this.strategyRegistry.size(),
      services: this.serviceRegistry.size(),
    };
  }

  private emit(type: string, data: unknown): void {
    this.eventBus.publish({
      type,
      data,
      source: "finance-runtime",
    });
  }

  private computeAggregateStatus(
    agents: Record<string, ReturnType<Agent["getHealth"]>>,
    services: ServiceInfo[],
  ): "healthy" | "degraded" | "unhealthy" {
    let worst: "healthy" | "degraded" | "unhealthy" = "healthy";

    for (const agentHealth of Object.values(agents)) {
      if (agentHealth.status === "error") return "unhealthy";
      if (agentHealth.status === "stopped") worst = "degraded";
    }

    for (const svc of services) {
      if (svc.status === "error") return "unhealthy";
      if (svc.status === "stopped" || svc.status === "registered") worst = "degraded";
    }

    if (!this.lifecycle.isRunning() && !this.lifecycle.isStopped()) {
      worst = "degraded";
    }

    return worst;
  }

  private log(level: string, message: string): void {
    const levels = ["debug", "info", "warn", "error"];
    const configLevel = levels.indexOf(this.config.logLevel);
    const msgLevel = levels.indexOf(level);
    if (msgLevel >= configLevel) {
      console.log(`[runtime:${level}] ${message}`);
    }
  }
}
