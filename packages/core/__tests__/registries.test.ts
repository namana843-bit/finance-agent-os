// ============================================================================
// Finance Agent OS — Agent Registry Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/registries.js";
import { BaseAgent } from "../src/agent.js";
import type { FinanceEvent } from "@finance/shared";

class TestAgent extends BaseAgent {
  async handleEvent(_event: FinanceEvent): Promise<void> {
    this.recordActivity();
  }
}

describe("AgentRegistry", () => {
  it("should register and retrieve agents", () => {
    const registry = new AgentRegistry();
    const agent = new TestAgent({ id: "test-1", name: "Test Agent", version: "1.0.0", description: "test", capabilities: ["test"] });
    registry.register(agent);
    expect(registry.size()).toBe(1);
    expect(registry.get("test-1")).toBe(agent);
  });

  it("should throw on duplicate registration", () => {
    const registry = new AgentRegistry();
    const agent = new TestAgent({ id: "dup", name: "Dup", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    expect(() => registry.register(agent)).toThrow("already registered");
  });

  it("should unregister agents", () => {
    const registry = new AgentRegistry();
    const agent = new TestAgent({ id: "rm", name: "RM", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    expect(registry.unregister("rm")).toBe(true);
    expect(registry.get("rm")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("should list all agents", () => {
    const registry = new AgentRegistry();
    registry.register(new TestAgent({ id: "a", name: "A", version: "1.0.0", description: "", capabilities: [] }));
    registry.register(new TestAgent({ id: "b", name: "B", version: "1.0.0", description: "", capabilities: [] }));
    expect(registry.list()).toHaveLength(2);
  });

  it("should start and stop all agents", async () => {
    const registry = new AgentRegistry();
    registry.register(new TestAgent({ id: "s1", name: "S1", version: "1.0.0", description: "", capabilities: [] }));
    registry.register(new TestAgent({ id: "s2", name: "S2", version: "1.0.0", description: "", capabilities: [] }));
    await registry.startAll();
    expect(registry.get("s1")!.getStatus()).toBe("running");
    expect(registry.get("s2")!.getStatus()).toBe("running");
    await registry.stopAll();
    expect(registry.get("s1")!.getStatus()).toBe("stopped");
  });

  it("should restart an agent", async () => {
    const registry = new AgentRegistry();
    const agent = new TestAgent({ id: "r1", name: "R1", version: "1.0.0", description: "", capabilities: [] });
    registry.register(agent);
    await agent.start();
    expect(agent.getStatus()).toBe("running");
    await registry.restart("r1");
    expect(agent.getStatus()).toBe("running");
  });

  it("should return health for all agents", async () => {
    const registry = new AgentRegistry();
    registry.register(new TestAgent({ id: "h1", name: "H1", version: "1.0.0", description: "", capabilities: [] }));
    await registry.startAll();
    const health = await registry.health();
    expect(health.h1).toBeDefined();
    expect(health.h1.status).toBe("running");
  });
});
