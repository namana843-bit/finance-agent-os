// ============================================================================
// Finance Agent OS — Finance Runtime
// Core application runtime that orchestrates all components
// ============================================================================

import { TypedEventBus } from "./event-bus.js";
import { AgentRegistry, ToolRegistry, PluginRegistry, StrategyRegistry, ServiceRegistry } from "./registries.js";
import type { Agent } from "./agent.js";
import type { ToolDefinition, StrategyConfig, PluginInfo } from "@finance/shared";
import type { PluginLifecycle, ToolHandler, StrategyHandler, ServiceLifecycle } from "./registries.js";

export interface RuntimeConfig {
  port?: number;
  host?: string;
  executionMode?: "paper" | "live";
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface RuntimeHealth {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  agents: Record<string, ReturnType<Agent["getHealth"]>>;
  plugins: ReturnType<PluginRegistry["list"]>;
  services: ReturnType<ServiceRegistry["listInfo"]>;
  tools: number;
  strategies: number;
  eventBusSize: number;
}

/**
 * The Finance Runtime is the central orchestrator.
 * It manages the lifecycle of all agents, tools, plugins, and strategies.
 */
export class FinanceRuntime {
  private config: RuntimeConfig;
  private eventBus: TypedEventBus;
  private agentRegistry: AgentRegistry;
  private toolRegistry: ToolRegistry;
  private pluginRegistry: PluginRegistry;
  private strategyRegistry: StrategyRegistry;
  private serviceRegistry: ServiceRegistry;
  private startedAt: number = 0;
  private running = false;

  constructor(config: RuntimeConfig = {}) {
    this.config = {
      port: config.port ?? 4132,
      host: config.host ?? "0.0.0.0",
      executionMode: config.executionMode ?? "paper",
      logLevel: config.logLevel ?? "info",
    };

    this.eventBus = new TypedEventBus({ maxHistory: 50_000 });
    this.agentRegistry = new AgentRegistry();
    this.toolRegistry = new ToolRegistry();
    this.pluginRegistry = new PluginRegistry();
    this.strategyRegistry = new StrategyRegistry();
    this.serviceRegistry = new ServiceRegistry();

    this.log("info", "Finance Runtime created");
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.log("info", "Starting Finance Runtime...");
    this.startedAt = Date.now();

    await this.pluginRegistry.initializeAll();
    await this.pluginRegistry.startAll();
    await this.serviceRegistry.initializeAll();
    await this.serviceRegistry.startAll();
    await this.agentRegistry.startAll();

    this.running = true;
    this.log("info", `Finance Runtime started on ${this.config.host}:${this.config.port}`);
    this.log("info", `Execution mode: ${this.config.executionMode}`);
    this.log("info", `Components: ${this.agentRegistry.size()} agents, ${this.toolRegistry.size()} tools, ${this.pluginRegistry.size()} plugins, ${this.strategyRegistry.size()} strategies, ${this.serviceRegistry.size()} services`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.log("info", "Stopping Finance Runtime...");
    await this.agentRegistry.stopAll();
    await this.serviceRegistry.stopAll();
    await this.pluginRegistry.stopAll();

    this.running = false;
    this.log("info", "Finance Runtime stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

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

  getConfig(): Readonly<RuntimeConfig> {
    return { ...this.config };
  }

  async getHealth(): Promise<RuntimeHealth> {
    const agents = await this.agentRegistry.health();
    const plugins = this.pluginRegistry.list();
    const services = this.serviceRegistry.listInfo();
    const allHealthy = Object.values(agents).every((a) => a.status === "running" || a.status === "idle");

    return {
      status: allHealthy ? "healthy" : "degraded",
      uptime: this.running ? Date.now() - this.startedAt : 0,
      agents,
      plugins,
      services,
      tools: this.toolRegistry.size(),
      strategies: this.strategyRegistry.size(),
      eventBusSize: this.eventBus.size(),
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  private log(level: string, message: string): void {
    const levels = ["debug", "info", "warn", "error"];
    const configLevel = levels.indexOf(this.config.logLevel ?? "info");
    const msgLevel = levels.indexOf(level);
    if (msgLevel >= configLevel) {
      console.log(`[runtime:${level}] ${message}`);
    }
  }
}
