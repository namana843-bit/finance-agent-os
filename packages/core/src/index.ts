// Finance Agent OS — Core Package
// Central exports for the core runtime

// Event Bus
export { TypedEventBus } from "./event-bus.js";
export type { EventBusOptions } from "./event-bus.js";

// Agent Abstraction
export { BaseAgent } from "./agent.js";
export type { Agent, AgentConfig } from "./agent.js";

// Registries
export {
  AgentRegistry,
  ToolRegistry,
  PluginRegistry,
  StrategyRegistry,
  ServiceRegistry,
} from "./registries.js";
export type {
  ToolHandler,
  StrategyHandler,
  PluginLifecycle,
  ServiceLifecycle,
  ServiceInfo,
} from "./registries.js";

// Shared re-exports for convenience
export type {
  AgentManifest,
  PluginManifest,
  StrategyConfig,
  ToolDefinition,
} from "@finance/shared";

// Lifecycle Manager
export { LifecycleManager, LifecyclePhase } from "./lifecycle.js";
export type { LifecycleEvent, LifecycleHook } from "./lifecycle.js";

// Finance Runtime
export { FinanceRuntime, RuntimeEvents } from "./runtime.js";
export type {
  RuntimeConfig,
  ResolvedRuntimeConfig,
  EventBusConfig,
  RuntimeStatus,
  RuntimeHealth,
  ComponentCounts,
} from "./runtime.js";
