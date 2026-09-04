// ============================================================================
// Finance Agent OS — Registry Tests
// Comprehensive tests for AgentRegistry, ToolRegistry, PluginRegistry,
// StrategyRegistry, and ServiceRegistry
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentRegistry,
  ToolRegistry,
  PluginRegistry,
  StrategyRegistry,
  ServiceRegistry,
} from "../src/registries.js";
import { BaseAgent } from "../src/agent.js";
import type { FinanceEvent, ToolDefinition, StrategyConfig, PluginInfo } from "@finance/shared";
import type { ToolHandler, StrategyHandler, PluginLifecycle, ServiceLifecycle, ServiceInfo } from "../src/registries.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

class TestAgent extends BaseAgent {
  async handleEvent(_event: FinanceEvent): Promise<void> {
    this.recordActivity();
  }
}

const testToolDef: ToolDefinition = {
  id: "test-tool",
  name: "Test Tool",
  description: "A test tool",
  inputSchema: { type: "object", properties: { x: { type: "number" } } },
  outputSchema: { type: "object", properties: { result: { type: "number" } } },
  permissions: { required: false },
};

const testToolHandler: ToolHandler = {
  execute: async (input) => ({ result: (input.x as number) * 2 }),
};

const testStrategyConfig: StrategyConfig = {
  id: "test-strategy",
  name: "Test Strategy",
  version: "1.0.0",
  description: "A test strategy",
  enabled: true,
  timeframe: "tick",
  parameters: {},
};

const testStrategyHandler: StrategyHandler = {
  calculate: () => ({ side: "hold", confidence: 0.5, reasoning: "test" }),
  generateSignal: () => ({ side: "hold", confidence: 0.5, reasoning: "test" }),
};

class TestPlugin implements PluginLifecycle {
  private status: PluginInfo["status"] = "registered";
  async initialize(): Promise<void> { this.status = "initialized"; }
  async start(): Promise<void> { this.status = "active"; }
  async stop(): Promise<void> { this.status = "stopped"; }
  getHealth(): PluginInfo { return { id: "test-plugin", name: "Test Plugin", version: "1.0.0", description: "test", status: this.status }; }
}

class TestService implements ServiceLifecycle {
  private status: ServiceInfo["status"] = "registered";
  async initialize(): Promise<void> { this.status = "initialized"; }
  async start(): Promise<void> { this.status = "active"; }
  async stop(): Promise<void> { this.status = "stopped"; }
  getHealth(): ServiceInfo { return { id: "test-service", name: "Test Service", version: "1.0.0", description: "test", status: this.status }; }
}

// ===========================================================================
// AgentRegistry
// ===========================================================================

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it("should register and retrieve agents", () => {
    const agent = new TestAgent({ id: "test-1", name: "Test Agent", version: "1.0.0", description: "test", capabilities: ["test"] });
    registry.register(agent);
    expect(registry.size()).toBe(1);
    expect(registry.get("test-1")).toBe(agent);
  });

  it("should throw on duplicate registration", () => {
    const agent = new TestAgent({ id: "dup", name: "Dup", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    expect(() => registry.register(agent)).toThrow("already registered");
  });

  it("should return false for unregister of non-existent id", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("should unregister agents", () => {
    const agent = new TestAgent({ id: "rm", name: "RM", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    expect(registry.unregister("rm")).toBe(true);
    expect(registry.get("rm")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("should check has() correctly", () => {
    expect(registry.has("test-1")).toBe(false);
    registry.register(new TestAgent({ id: "test-1", name: "T", version: "1.0.0", description: "", capabilities: [] }));
    expect(registry.has("test-1")).toBe(true);
    expect(registry.has("other")).toBe(false);
  });

  it("should list all agents", () => {
    registry.register(new TestAgent({ id: "a", name: "A", version: "1.0.0", description: "", capabilities: [] }));
    registry.register(new TestAgent({ id: "b", name: "B", version: "1.0.0", description: "", capabilities: [] }));
    expect(registry.list()).toHaveLength(2);
  });

  it("should list manifests for agents", () => {
    registry.register(new TestAgent({ id: "m1", name: "M1", version: "1.0.0", description: "manifest test", capabilities: ["cap-a"] }));
    const manifests = registry.listManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.id).toBe("m1");
    expect(manifests[0]!.capabilities).toEqual(["cap-a"]);
    expect(manifests[0]!.tools).toEqual([]);
    expect(manifests[0]!.subscriptions).toEqual([]);
  });

  it("should start and stop all agents", async () => {
    registry.register(new TestAgent({ id: "s1", name: "S1", version: "1.0.0", description: "", capabilities: [] }));
    registry.register(new TestAgent({ id: "s2", name: "S2", version: "1.0.0", description: "", capabilities: [] }));
    await registry.startAll();
    expect(registry.get("s1")!.getStatus()).toBe("running");
    expect(registry.get("s2")!.getStatus()).toBe("running");
    await registry.stopAll();
    expect(registry.get("s1")!.getStatus()).toBe("stopped");
  });

  it("should restart an agent", async () => {
    const agent = new TestAgent({ id: "r1", name: "R1", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    await agent.start();
    expect(agent.getStatus()).toBe("running");
    await registry.restart("r1");
    expect(agent.getStatus()).toBe("running");
  });

  it("should throw on restart of non-existent agent", async () => {
    await expect(registry.restart("nope")).rejects.toThrow("not found");
  });

  it("should return health for all agents", async () => {
    registry.register(new TestAgent({ id: "h1", name: "H1", version: "1.0.0", description: "", capabilities: [] }));
    await registry.startAll();
    const health = await registry.health();
    expect(health.h1).toBeDefined();
    expect(health.h1.status).toBe("running");
  });

  it("should handle startAll errors gracefully", async () => {
    const badAgent = new TestAgent({ id: "bad", name: "Bad", version: "1.0.0", description: "", capabilities: [] });
    // Override start to throw
    badAgent.start = async () => { throw new Error("start failed"); };
    registry.register(badAgent);
    registry.register(new TestAgent({ id: "good", name: "Good", version: "1.0.0", description: "", capabilities: [] }));
    // Should not throw
    await registry.startAll();
    expect(registry.get("good")!.getStatus()).toBe("running");
  });

  it("should handle stopAll errors gracefully", async () => {
    const badAgent = new TestAgent({ id: "bad", name: "Bad", version: "1.0.0", description: "", capabilities: [] });
    badAgent.stop = async () => { throw new Error("stop failed"); };
    registry.register(badAgent);
    await registry.startAll();
    // Should not throw
    await registry.stopAll();
  });
});

// ===========================================================================
// ToolRegistry
// ===========================================================================

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register and retrieve tools", () => {
    registry.register(testToolDef, testToolHandler);
    expect(registry.size()).toBe(1);
    const tool = registry.get("test-tool");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("test-tool");
    expect(tool!.name).toBe("Test Tool");
  });

  it("should throw on duplicate registration", () => {
    registry.register(testToolDef, testToolHandler);
    expect(() => registry.register(testToolDef, testToolHandler)).toThrow("already registered");
  });

  it("should check has() correctly", () => {
    expect(registry.has("test-tool")).toBe(false);
    registry.register(testToolDef, testToolHandler);
    expect(registry.has("test-tool")).toBe(true);
  });

  it("should unregister tools", () => {
    registry.register(testToolDef, testToolHandler);
    expect(registry.unregister("test-tool")).toBe(true);
    expect(registry.get("test-tool")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("should return false for unregister of non-existent id", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("should list tools without handlers", () => {
    registry.register(testToolDef, testToolHandler);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("test-tool");
    // Should not expose handler
    expect((list[0] as Record<string, unknown>).handler).toBeUndefined();
  });

  it("should execute a tool", async () => {
    registry.register(testToolDef, testToolHandler);
    const result = await registry.execute("test-tool", { x: 21 });
    expect(result).toEqual({ result: 42 });
  });

  it("should throw on execute of non-existent tool", async () => {
    await expect(registry.execute("nope", {})).rejects.toThrow("not found");
  });

  it("should return correct size", () => {
    expect(registry.size()).toBe(0);
    registry.register(testToolDef, testToolHandler);
    expect(registry.size()).toBe(1);
  });
});

// ===========================================================================
// PluginRegistry
// ===========================================================================

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it("should register plugins", () => {
    const plugin = new TestPlugin();
    registry.register({ id: "p1", name: "Plugin 1", version: "1.0.0", description: "test", status: "registered" }, plugin);
    expect(registry.size()).toBe(1);
  });

  it("should throw on duplicate registration", () => {
    const plugin = new TestPlugin();
    const info: PluginInfo = { id: "dup", name: "Dup", version: "1.0.0", description: "", status: "registered" };
    registry.register(info, plugin);
    expect(() => registry.register(info, plugin)).toThrow("already registered");
  });

  it("should check has() correctly", () => {
    expect(registry.has("p1")).toBe(false);
    registry.register({ id: "p1", name: "P1", version: "1.0.0", description: "", status: "registered" }, new TestPlugin());
    expect(registry.has("p1")).toBe(true);
  });

  it("should unregister plugins", () => {
    registry.register({ id: "p1", name: "P1", version: "1.0.0", description: "", status: "registered" }, new TestPlugin());
    expect(registry.unregister("p1")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("should return false for unregister of non-existent id", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("should initialize, start, and stop all plugins", async () => {
    registry.register({ id: "p1", name: "P1", version: "1.0.0", description: "", status: "registered" }, new TestPlugin());
    registry.register({ id: "p2", name: "P2", version: "1.0.0", description: "", status: "registered" }, new TestPlugin());

    await registry.initializeAll();
    await registry.startAll();

    const list = registry.list();
    expect(list.every((p) => p.status === "active")).toBe(true);

    await registry.stopAll();
    const listAfter = registry.list();
    expect(listAfter.every((p) => p.status === "stopped")).toBe(true);
  });

  it("should list plugin info", () => {
    const plugin = new TestPlugin();
    registry.register({ id: "p1", name: "P1", version: "1.0.0", description: "desc", status: "registered" }, plugin);
    const list = registry.list();
    expect(list).toHaveLength(1);
    // list() calls lifecycle.getHealth() which returns the plugin's own info
    expect(list[0]!.id).toBe("test-plugin");
    expect(list[0]!.name).toBe("Test Plugin");
  });

  it("should handle initialization errors gracefully", async () => {
    const badPlugin: PluginLifecycle = {
      initialize: async () => { throw new Error("init failed"); },
      start: async () => {},
      stop: async () => {},
      getHealth: () => ({ id: "bad", name: "Bad", version: "1.0.0", description: "", status: "registered" }),
    };
    registry.register({ id: "bad", name: "Bad", version: "1.0.0", description: "", status: "registered" }, badPlugin);
    registry.register({ id: "good", name: "Good", version: "1.0.0", description: "", status: "registered" }, new TestPlugin());
    // Should not throw
    await registry.initializeAll();
    await registry.startAll();
    // good plugin should still be active
    const good = registry.get("good");
    expect(good).toBeDefined();
  });
});

// ===========================================================================
// StrategyRegistry
// ===========================================================================

describe("StrategyRegistry", () => {
  let registry: StrategyRegistry;

  beforeEach(() => {
    registry = new StrategyRegistry();
  });

  it("should register and retrieve strategies", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    expect(registry.size()).toBe(1);
    const s = registry.get("test-strategy");
    expect(s).toBeDefined();
    expect(s!.id).toBe("test-strategy");
  });

  it("should throw on duplicate registration", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    expect(() => registry.register(testStrategyConfig, testStrategyHandler)).toThrow("already registered");
  });

  it("should check has() correctly", () => {
    expect(registry.has("test-strategy")).toBe(false);
    registry.register(testStrategyConfig, testStrategyHandler);
    expect(registry.has("test-strategy")).toBe(true);
  });

  it("should remove strategies", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    expect(registry.remove("test-strategy")).toBe(true);
    expect(registry.get("test-strategy")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("should return false for remove of non-existent id", () => {
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("should list strategy configs without handlers", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("test-strategy");
    expect((list[0] as Record<string, unknown>).handler).toBeUndefined();
  });

  it("should enable and disable strategies", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    registry.disable("test-strategy");
    expect(registry.get("test-strategy")!.enabled).toBe(false);
    registry.enable("test-strategy");
    expect(registry.get("test-strategy")!.enabled).toBe(true);
  });

  it("should get only enabled strategies", () => {
    registry.register({ ...testStrategyConfig, id: "s1", enabled: true }, testStrategyHandler);
    registry.register({ ...testStrategyConfig, id: "s2", enabled: false }, testStrategyHandler);
    const enabled = registry.getEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.id).toBe("s1");
  });

  it("should update strategy config", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    registry.updateConfig("test-strategy", { timeframe: "1m" });
    expect(registry.get("test-strategy")!.timeframe).toBe("1m");
  });

  it("should unregister strategies", () => {
    registry.register(testStrategyConfig, testStrategyHandler);
    expect(registry.unregister("test-strategy")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("should handle enable/disable of non-existent strategy gracefully", () => {
    // Should not throw
    registry.enable("nonexistent");
    registry.disable("nonexistent");
  });
});

// ===========================================================================
// ServiceRegistry
// ===========================================================================

describe("ServiceRegistry", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it("should register services", () => {
    registry.register(new TestService());
    expect(registry.size()).toBe(1);
  });

  it("should throw on duplicate registration", () => {
    const service = new TestService();
    registry.register(service);
    // Registering with same ID will throw
    expect(() => registry.register(service)).toThrow("already registered");
  });

  it("should check has() correctly", () => {
    expect(registry.has("test-service")).toBe(false);
    registry.register(new TestService());
    expect(registry.has("test-service")).toBe(true);
  });

  it("should unregister services", () => {
    registry.register(new TestService());
    expect(registry.unregister("test-service")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("should return false for unregister of non-existent id", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("should get service by id", () => {
    registry.register(new TestService());
    const svc = registry.get("test-service");
    expect(svc).toBeDefined();
  });

  it("should list services", () => {
    registry.register(new TestService());
    const list = registry.list();
    expect(list).toHaveLength(1);
  });

  it("should list service info", () => {
    registry.register(new TestService());
    const info = registry.listInfo();
    expect(info).toHaveLength(1);
    expect(info[0]!.id).toBe("test-service");
  });

  it("should initialize, start, and stop all services", async () => {
    registry.register(new TestService());
    await registry.initializeAll();
    await registry.startAll();
    const info = registry.listInfo();
    expect(info[0]!.status).toBe("active");

    await registry.stopAll();
    const infoAfter = registry.listInfo();
    expect(infoAfter[0]!.status).toBe("stopped");
  });

  it("should handle initialization errors gracefully", async () => {
    const badService: ServiceLifecycle = {
      initialize: async () => { throw new Error("init failed"); },
      start: async () => {},
      stop: async () => {},
      getHealth: () => ({ id: "bad-svc", name: "Bad", version: "1.0.0", description: "", status: "registered" }),
    };
    registry.register(badService);
    registry.register(new TestService());
    // Should not throw
    await registry.initializeAll();
    await registry.startAll();
    expect(registry.size()).toBe(2);
  });
});
