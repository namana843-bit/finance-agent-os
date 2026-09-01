// Finance Agent OS — Core Package
// Central exports for the core runtime

export { TypedEventBus } from "./event-bus.js";
export type { EventBusOptions } from "./event-bus.js";

export { BaseAgent } from "./agent.js";
export type { Agent, AgentConfig } from "./agent.js";

export {
  AgentRegistry,
  ToolRegistry,
  PluginRegistry,
  StrategyRegistry,
} from "./registries.js";
export type { ToolHandler, StrategyHandler, PluginLifecycle } from "./registries.js";

export { FinanceRuntime } from "./runtime.js";
export type { RuntimeConfig, RuntimeHealth } from "./runtime.js";
