import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../eventBus.js";
import { BaseAgent } from "../agent.js";
import type { FinanceEvent } from "../eventBus.js";

class EchoAgent extends BaseAgent {
  seen: FinanceEvent[] = [];
  constructor(bus: EventBus) {
    super({ id: "echo", name: "Echo Agent", bus });
  }
  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}
  override handleEvent(e: FinanceEvent): void {
    this.seen.push(e);
  }
}

describe("Agent lifecycle (BaseAgent)", () => {
  it("starts/stops idempotently with status transitions", async () => {
    const bus = new EventBus();
    const agent = new EchoAgent(bus);
    assert.equal(agent.getStatus(), "idle");
    await agent.start();
    assert.equal(agent.getStatus(), "running");
    assert.ok(agent.isRunning());
    await agent.start(); // idempotent
    assert.ok(agent.isRunning());
    await agent.stop();
    assert.equal(agent.getStatus(), "stopped");
    assert.ok(!agent.isRunning());
  });

  it("routes bus events to handleEvent and publishes lifecycle events", async () => {
    const bus = new EventBus();
    const agent = new EchoAgent(bus);
    await agent.start();
    bus.publish({ type: "market:tick", data: { symbol: "AAPL", price: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(agent.seen.some((e) => e.type === "market:tick"));
    assert.ok(bus.getHistory({ type: "agent.started" }).length >= 1);
    await agent.stop();
    assert.ok(bus.getHistory({ type: "agent.stopped" }).length >= 1);
  });

  it("requires id and name", () => {
    const bus = new EventBus();
    assert.throws(() => new EchoAgentNoId(bus), /non-empty id/);
  });
});

class EchoAgentNoId extends BaseAgent {
  constructor(bus: EventBus) {
    super({ id: "  ", name: "x", bus });
  }
  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}
}

describe("adaptLegacyAgent", () => {
  it("wraps legacy start/stop/isRunning without rewrites", async () => {
    const { adaptLegacyAgent } = await import("../agent.js");
    let running = false;
    const legacy = {
      name: "Legacy",
      start: () => void (running = true),
      stop: () => void (running = false),
      isRunning: () => running,
    };
    const adapted = adaptLegacyAgent("legacy", legacy);
    assert.equal(adapted.id, "legacy");
    await adapted.start();
    assert.ok(adapted.isRunning());
    assert.equal(adapted.getStatus(), "running");
    await adapted.stop();
    assert.ok(!adapted.isRunning());
  });
});
