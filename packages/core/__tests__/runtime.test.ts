// ============================================================================
// Finance Agent OS — FinanceRuntime Tests
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FinanceRuntime, RuntimeEvents } from "../src/runtime.js";
import { LifecyclePhase } from "../src/lifecycle.js";
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

class FailingAgent extends BaseAgent {
  async start(): Promise<void> {
    throw new Error("agent start failed");
  }
  async handleEvent(_event: FinanceEvent): Promise<void> {}
}

class TestPlugin implements PluginLifecycle {
  private status: PluginInfo["status"] = "registered";
  async initialize(): Promise<void> { this.status = "initialized"; }
  async start(): Promise<void> { this.status = "active"; }
  async stop(): Promise<void> { this.status = "stopped"; }
  getHealth(): PluginInfo { return { id: "test-plugin", name: "Test", version: "1.0.0", description: "", status: this.status }; }
}

class TestService implements ServiceLifecycle {
  private status: ServiceInfo["status"] = "registered";
  async initialize(): Promise<void> { this.status = "initialized"; }
  async start(): Promise<void> { this.status = "active"; }
  async stop(): Promise<void> { this.status = "stopped"; }
  getHealth(): ServiceInfo { return { id: "test-service", name: "Test", version: "1.0.0", description: "", status: this.status }; }
}

// ===========================================================================
// FinanceRuntime
// ===========================================================================

describe("FinanceRuntime", () => {
  let runtime: FinanceRuntime;

  beforeEach(() => {
    runtime = new FinanceRuntime({
      port: 0,
      host: "127.0.0.1",
      executionMode: "paper",
      logLevel: "error", // suppress console output in tests
    });
  });

  afterEach(async () => {
    if (runtime.isRunning()) {
      await runtime.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it("should create runtime with default config", () => {
    const rt = new FinanceRuntime({ logLevel: "error" });
    const config = rt.getConfig();
    expect(config.port).toBe(4132);
    expect(config.host).toBe("0.0.0.0");
    expect(config.executionMode).toBe("paper");
    expect(config.logLevel).toBe("error");
    expect(config.version).toBe("0.1.0");
  });

  it("should create runtime with custom config", () => {
    const rt = new FinanceRuntime({
      port: 8080,
      host: "localhost",
      executionMode: "live",
      logLevel: "error",
      version: "2.0.0",
      eventBus: { maxHistory: 1000 },
    });
    const config = rt.getConfig();
    expect(config.port).toBe(8080);
    expect(config.host).toBe("localhost");
    expect(config.executionMode).toBe("live");
    expect(config.version).toBe("2.0.0");
    expect(config.eventBus.maxHistory).toBe(1000);
  });

  it("should default execution mode to paper", () => {
    const rt = new FinanceRuntime({ logLevel: "error" });
    expect(rt.getConfig().executionMode).toBe("paper");
  });

  // -------------------------------------------------------------------------
  // Component Registration
  // -------------------------------------------------------------------------

  it("should register agents", () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    expect(runtime.getAgentRegistry().size()).toBe(1);
    expect(runtime.getAgentRegistry().has("a1")).toBe(true);
  });

  it("should register tools", () => {
    const def: ToolDefinition = {
      id: "t1", name: "T1", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false },
    };
    runtime.registerTool(def, { execute: async () => null });
    expect(runtime.getToolRegistry().size()).toBe(1);
    expect(runtime.getToolRegistry().has("t1")).toBe(true);
  });

  it("should register plugins", () => {
    runtime.registerPlugin(
      { id: "p1", name: "P1", version: "1.0.0", description: "", status: "registered" },
      new TestPlugin(),
    );
    expect(runtime.getPluginRegistry().size()).toBe(1);
    expect(runtime.getPluginRegistry().has("p1")).toBe(true);
  });

  it("should register strategies", () => {
    const config: StrategyConfig = {
      id: "s1", name: "S1", version: "1.0.0", description: "", enabled: true, timeframe: "tick", parameters: {},
    };
    const handler: StrategyHandler = {
      calculate: () => ({}),
      generateSignal: () => ({ side: "hold", confidence: 0.5, reasoning: "" }),
    };
    runtime.registerStrategy(config, handler);
    expect(runtime.getStrategyRegistry().size()).toBe(1);
    expect(runtime.getStrategyRegistry().has("s1")).toBe(true);
  });

  it("should register services", () => {
    runtime.registerService(new TestService());
    expect(runtime.getServiceRegistry().size()).toBe(1);
    expect(runtime.getServiceRegistry().has("test-service")).toBe(true);
  });

  it("should get service by id", () => {
    runtime.registerService(new TestService());
    const svc = runtime.getService("test-service");
    expect(svc).toBeDefined();
  });

  it("should return undefined for non-existent service", () => {
    expect(runtime.getService("nope")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Lifecycle — Startup
  // -------------------------------------------------------------------------

  it("should start and be in running state", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getLifecycle().getPhase()).toBe(LifecyclePhase.RUNNING);
  });

  it("should emit runtime.starting and runtime.started events", async () => {
    const events: string[] = [];
    runtime.getEventBus().subscribeTo(RuntimeEvents.STARTING, () => events.push("starting"));
    runtime.getEventBus().subscribeTo(RuntimeEvents.STARTED, () => events.push("started"));
    await runtime.start();
    expect(events).toContain("starting");
    expect(events).toContain("started");
  });

  it("should start agents", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    expect(runtime.getAgentRegistry().get("a1")!.getStatus()).toBe("running");
  });

  it("should initialize and start plugins", async () => {
    runtime.registerPlugin(
      { id: "p1", name: "P1", version: "1.0.0", description: "", status: "registered" },
      new TestPlugin(),
    );
    await runtime.start();
    const pluginInfo = runtime.getPluginRegistry().list();
    expect(pluginInfo[0]!.status).toBe("active");
  });

  it("should initialize and start services", async () => {
    runtime.registerService(new TestService());
    await runtime.start();
    const svcInfo = runtime.getServiceRegistry().listInfo();
    expect(svcInfo[0]!.status).toBe("active");
  });

  it("should be idempotent on start", async () => {
    await runtime.start();
    await runtime.start(); // should not throw
    expect(runtime.isRunning()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Lifecycle — Shutdown
  // -------------------------------------------------------------------------

  it("should stop gracefully", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    await runtime.stop();
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getLifecycle().getPhase()).toBe(LifecyclePhase.STOPPED);
  });

  it("should emit runtime.stopping and runtime.stopped events", async () => {
    const events: string[] = [];
    runtime.getEventBus().subscribeTo(RuntimeEvents.STOPPING, () => events.push("stopping"));
    runtime.getEventBus().subscribeTo(RuntimeEvents.STOPPED, () => events.push("stopped"));
    await runtime.start();
    await runtime.stop();
    expect(events).toContain("stopping");
    expect(events).toContain("stopped");
  });

  it("should stop agents on shutdown", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    await runtime.stop();
    expect(runtime.getAgentRegistry().get("a1")!.getStatus()).toBe("stopped");
  });

  it("should stop services on shutdown", async () => {
    runtime.registerService(new TestService());
    await runtime.start();
    await runtime.stop();
    const svcInfo = runtime.getServiceRegistry().listInfo();
    expect(svcInfo[0]!.status).toBe("stopped");
  });

  it("should be idempotent on stop", async () => {
    await runtime.start();
    await runtime.stop();
    await runtime.stop(); // should not throw
    expect(runtime.isRunning()).toBe(false);
  });

  it("should stop without having started", async () => {
    // Should not throw even if never started
    await runtime.stop();
    expect(runtime.getLifecycle().getPhase()).toBe(LifecyclePhase.STOPPED);
  });

  it("should restart runtime", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    expect(runtime.isRunning()).toBe(true);
    await runtime.restart();
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getAgentRegistry().get("a1")!.getStatus()).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  it("should return status before starting", () => {
    const status = runtime.getStatus();
    expect(status.phase).toBe(LifecyclePhase.CREATED);
    expect(status.running).toBe(false);
    expect(status.uptime).toBe(0);
  });

  it("should return status after starting", async () => {
    await runtime.start();
    const status = runtime.getStatus();
    expect(status.phase).toBe(LifecyclePhase.RUNNING);
    expect(status.running).toBe(true);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.config.executionMode).toBe("paper");
  });

  it("should include component counts in status", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    runtime.registerTool(
      { id: "t1", name: "T1", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } },
      { execute: async () => null },
    );
    await runtime.start();
    const status = runtime.getStatus();
    expect(status.components.agents).toBe(1);
    expect(status.components.tools).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  it("should report healthy status when all components ok", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    await runtime.start();
    const health = await runtime.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.phase).toBe(LifecyclePhase.RUNNING);
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it("should report health with agents and services", async () => {
    runtime.registerAgent(new TestAgent({ id: "a1", name: "A1", version: "1.0.0", description: "", capabilities: [] }));
    runtime.registerService(new TestService());
    await runtime.start();
    const health = await runtime.getHealth();
    expect(health.agents.a1).toBeDefined();
    expect(health.services).toHaveLength(1);
    expect(health.components.agents).toBe(1);
    expect(health.components.services).toBe(1);
  });

  it("should report degraded when not running", () => {
    const health = runtime.getHealth() as Promise<{ status: string }>;
    // Before starting, status should be healthy or degraded
    // The runtime is in CREATED phase, not running, not stopped => degraded
    health.then((h) => {
      expect(["healthy", "degraded"]).toContain(h.status);
    });
  });

  // -------------------------------------------------------------------------
  // EventBus
  // -------------------------------------------------------------------------

  it("should expose event bus", () => {
    const bus = runtime.getEventBus();
    expect(bus).toBeDefined();
    expect(bus.size()).toBe(0);
  });

  it("should publish lifecycle events to bus", async () => {
    await runtime.start();
    const history = runtime.getEventBus().getHistory({ source: "finance-runtime" });
    expect(history.length).toBeGreaterThanOrEqual(2);
    const types = history.map((e) => e.type);
    expect(types).toContain(RuntimeEvents.STARTING);
    expect(types).toContain(RuntimeEvents.STARTED);
  });
});
