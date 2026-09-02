// ============================================================================
// Finance Agent OS — Registries
// Central registries for agents, tools, plugins, and strategies
// ============================================================================

import type { Agent } from "./agent.js";
import type { ToolDefinition } from "@finance/shared";
import type { StrategyConfig } from "@finance/shared";
import type { PluginInfo } from "@finance/shared";

// ---------------------------------------------------------------------------
// Service Types
// ---------------------------------------------------------------------------

/**
 * Service — an infrastructure component managed by the runtime.
 * Unlike agents (which produce signals and make decisions),
 * services provide capabilities like persistence, logging,
 * market state tracking, and order management.
 */
export interface ServiceLifecycle {
  /** Called once after registration, before start. */
  initialize(): Promise<void>;
  /** Start the service. Idempotent. */
  start(): Promise<void>;
  /** Stop the service gracefully. Idempotent. */
  stop(): Promise<void>;
  /** Get current health/status info. */
  getHealth(): ServiceInfo;
}

export interface ServiceInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: "registered" | "initialized" | "active" | "stopped" | "error";
}

// ---------------------------------------------------------------------------
// Agent Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent '${agent.id}' already registered`);
    }
    this.agents.set(agent.id, agent);
    console.log(`[registry:agent] registered: ${agent.id}`);
  }

  unregister(id: string): boolean {
    const removed = this.agents.delete(id);
    if (removed) console.log(`[registry:agent] unregistered: ${id}`);
    return removed;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  async startAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      try {
        await agent.start();
      } catch (err) {
        console.error(`[registry:agent] failed to start ${agent.id}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      try {
        await agent.stop();
      } catch (err) {
        console.error(`[registry:agent] failed to stop ${agent.id}:`, err);
      }
    }
  }

  async restart(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent '${id}' not found`);
    await agent.restart();
  }

  async health(): Promise<Record<string, ReturnType<Agent["getHealth"]>>> {
    const result: Record<string, ReturnType<Agent["getHealth"]>> = {};
    for (const [id, agent] of this.agents) {
      result[id] = agent.getHealth();
    }
    return result;
  }

  size(): number {
    return this.agents.size;
  }
}

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

export interface ToolHandler {
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition & { handler: ToolHandler }>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.id)) {
      throw new Error(`Tool '${definition.id}' already registered`);
    }
    this.tools.set(definition.id, { ...definition, handler });
    console.log(`[registry:tool] registered: ${definition.id}`);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  get(id: string): (ToolDefinition & { handler: ToolHandler }) | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ handler, ...def }) => def);
  }

  async execute(id: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Tool '${id}' not found`);
    return tool.handler.execute(input);
  }

  size(): number {
    return this.tools.size;
  }
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

export interface PluginLifecycle {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): PluginInfo;
}

export class PluginRegistry {
  private plugins = new Map<string, { info: PluginInfo; lifecycle: PluginLifecycle }>();

  register(info: PluginInfo, lifecycle: PluginLifecycle): void {
    if (this.plugins.has(info.id)) {
      throw new Error(`Plugin '${info.id}' already registered`);
    }
    this.plugins.set(info.id, { info: { ...info, status: "registered" }, lifecycle });
    console.log(`[registry:plugin] registered: ${info.id}`);
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  get(id: string): { info: PluginInfo; lifecycle: PluginLifecycle } | undefined {
    return this.plugins.get(id);
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => p.lifecycle.getHealth());
  }

  async initializeAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.lifecycle.initialize();
      } catch (err) {
        console.error(`[registry:plugin] failed to initialize ${plugin.info.id}:`, err);
      }
    }
  }

  async startAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.lifecycle.start();
      } catch (err) {
        console.error(`[registry:plugin] failed to start ${plugin.info.id}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.lifecycle.stop();
      } catch (err) {
        console.error(`[registry:plugin] failed to stop ${plugin.info.id}:`, err);
      }
    }
  }

  size(): number {
    return this.plugins.size;
  }
}

// ---------------------------------------------------------------------------
// Strategy Registry
// ---------------------------------------------------------------------------

export interface StrategyHandler {
  calculate(prices: number[], params: Record<string, unknown>): Record<string, unknown>;
  generateSignal(data: Record<string, unknown>): { side: string; confidence: number; reasoning: string };
}

export class StrategyRegistry {
  private strategies = new Map<string, StrategyConfig & { handler: StrategyHandler }>();

  register(config: StrategyConfig, handler: StrategyHandler): void {
    if (this.strategies.has(config.id)) {
      throw new Error(`Strategy '${config.id}' already registered`);
    }
    this.strategies.set(config.id, { ...config, handler });
    console.log(`[registry:strategy] registered: ${config.id}`);
  }

  unregister(id: string): boolean {
    return this.strategies.delete(id);
  }

  get(id: string): (StrategyConfig & { handler: StrategyHandler }) | undefined {
    return this.strategies.get(id);
  }

  list(): StrategyConfig[] {
    return [...this.strategies.values()].map(({ handler, ...config }) => config);
  }

  enable(id: string): void {
    const strategy = this.strategies.get(id);
    if (strategy) strategy.enabled = true;
  }

  disable(id: string): void {
    const strategy = this.strategies.get(id);
    if (strategy) strategy.enabled = false;
  }

  updateConfig(id: string, patch: Partial<StrategyConfig>): void {
    const strategy = this.strategies.get(id);
    if (strategy) {
      Object.assign(strategy, patch);
    }
  }

  getEnabled(): (StrategyConfig & { handler: StrategyHandler })[] {
    return [...this.strategies.values()].filter((s) => s.enabled);
  }

  size(): number {
    return this.strategies.size;
  }
}

// ---------------------------------------------------------------------------
// Service Registry
// ---------------------------------------------------------------------------

export class ServiceRegistry {
  private services = new Map<string, ServiceLifecycle>();

  register(service: ServiceLifecycle): void {
    const info = service.getHealth();
    if (this.services.has(info.id)) {
      throw new Error(`Service '${info.id}' already registered`);
    }
    this.services.set(info.id, service);
    console.log(`[registry:service] registered: ${info.id}`);
  }

  unregister(id: string): boolean {
    const removed = this.services.delete(id);
    if (removed) console.log(`[registry:service] unregistered: ${id}`);
    return removed;
  }

  get(id: string): ServiceLifecycle | undefined {
    return this.services.get(id);
  }

  list(): ServiceLifecycle[] {
    return [...this.services.values()];
  }

  listInfo(): ServiceInfo[] {
    return [...this.services.values()].map((s) => s.getHealth());
  }

  async initializeAll(): Promise<void> {
    for (const service of this.services.values()) {
      try {
        await service.initialize();
      } catch (err) {
        console.error(`[registry:service] failed to initialize:`, err);
      }
    }
  }

  async startAll(): Promise<void> {
    for (const service of this.services.values()) {
      try {
        await service.start();
      } catch (err) {
        console.error(`[registry:service] failed to start:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const service of this.services.values()) {
      try {
        await service.stop();
      } catch (err) {
        console.error(`[registry:service] failed to stop:`, err);
      }
    }
  }

  size(): number {
    return this.services.size;
  }
}
