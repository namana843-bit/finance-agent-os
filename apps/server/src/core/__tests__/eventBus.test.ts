import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus, normalizeEventType, eventTypesEqual } from "../eventBus.js";

describe("EventBus foundation", () => {
  it("publishes with id + timestamp and stores history", () => {
    const bus = new EventBus();
    const e = bus.publish({ type: "market:tick", data: { symbol: "BTCUSDT", price: 1 } });
    assert.ok(e.id);
    assert.ok(e.timestamp > 0);
    assert.equal(bus.size(), 1);
    assert.equal(bus.getHistory()[0]!.type, "market:tick");
  });

  it("normalizes dot notation to canonical colon form", () => {
    const bus = new EventBus();
    const e = bus.publish({ type: "market.tick", data: {} });
    assert.equal(e.type, "market:tick");
    assert.equal(normalizeEventType("quant.signal"), "quant:signal");
    assert.ok(eventTypesEqual("market.tick", "market:tick"));
  });

  it("keeps agent.* / tool.* / system.* dotted", () => {
    assert.equal(normalizeEventType("agent.started"), "agent.started");
    assert.equal(normalizeEventType("system.ready"), "system.ready");
  });

  it("filters by type ignoring dot/colon style, plus correlationId", () => {
    const bus = new EventBus();
    bus.publish({ type: "market:tick", data: {}, correlationId: "c1" });
    bus.publish({ type: "signal:buy", data: {}, correlationId: "c1" });
    bus.publish({ type: "market:tick", data: {}, correlationId: "c2" });
    assert.equal(bus.getHistory({ type: "market.tick" }).length, 2);
    assert.equal(bus.getHistory({ correlationId: "c1" }).length, 2);
  });

  it("replays history to handler", async () => {
    const bus = new EventBus();
    bus.publish({ type: "a", data: 1 });
    bus.publish({ type: "b", data: 2 });
    const seen: string[] = [];
    const n = await bus.replay((e) => void seen.push(e.type));
    assert.equal(n, 2);
    assert.deepEqual(seen, ["a", "b"]);
  });

  it("isolates subscriber errors", () => {
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    let got = false;
    bus.subscribe(() => void (got = true));
    bus.publish({ type: "x", data: null });
    assert.equal(got, true);
  });
});
