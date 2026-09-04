// ============================================================================
// Finance Agent OS — Gateway, Audit, Memory Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@finance/core";
import { FinanceGateway } from "../src/gateway/finance-gateway.js";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { AgentMemory } from "../src/memory/agent-memory.js";

// ---------------------------------------------------------------------------
// Finance Gateway
// ---------------------------------------------------------------------------

describe("FinanceGateway", () => {
  it("should reject requests when agent cannot trade", async () => {
    const bus = new TypedEventBus();
    const gateway = new FinanceGateway(bus);
    gateway.setAgentPermissions("test-agent", { canTrade: false });

    const decision = await gateway.submitRequest({
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: 68000,
      agentId: "test-agent",
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("not allowed to trade");
  });

  it("should reject when order size exceeds agent limit", async () => {
    const bus = new TypedEventBus();
    const gateway = new FinanceGateway(bus);
    gateway.setAgentPermissions("small-agent", { maxOrderSize: 100 });

    const decision = await gateway.submitRequest({
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: 68000, // 680 > 100
      agentId: "small-agent",
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("exceeds max");
  });

  it("should reject when symbol not in allowed list", async () => {
    const bus = new TypedEventBus();
    const gateway = new FinanceGateway(bus);
    gateway.setAgentPermissions("limited-agent", { allowedSymbols: ["ETHUSDT"] });

    const decision = await gateway.submitRequest({
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: 68000,
      agentId: "limited-agent",
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("not in allowed list");
  });

  it("should validate request fields", async () => {
    const bus = new TypedEventBus();
    const gateway = new FinanceGateway(bus);

    const decision = await gateway.submitRequest({
      symbol: "",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: 68000,
      agentId: "test",
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("Symbol is required");
  });

  it("should track stats", async () => {
    const bus = new TypedEventBus();
    const gateway = new FinanceGateway(bus, { requestTimeoutMs: 2000 });

    // Auto-approve risk requests for this test
    bus.subscribeTo("gateway.trade_request", (event) => {
      const data = event.data as { correlationId?: string };
      // Simulate risk approval after a short delay
      setTimeout(() => {
        bus.publish({ type: "risk.approved", data: { correlationId: data?.correlationId, id: data?.correlationId }, source: "risk-test" });
      }, 10);
    });

    await gateway.submitRequest({
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: 68000,
      agentId: "test",
    });

    const stats = gateway.getStats();
    expect(stats.totalRequests).toBeGreaterThanOrEqual(1);
    expect(stats.approvedRequests).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Audit Logger
// ---------------------------------------------------------------------------

describe("AuditLogger", () => {
  it("should record events as audit records", () => {
    const bus = new TypedEventBus();
    const logger = new AuditLogger(bus);
    logger.start();

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });
    bus.publish({ type: "quant.signal", data: { symbol: "BTCUSDT", side: "buy" }, source: "quant" });

    expect(logger.size()).toBe(2);

    const records = logger.getRecords();
    expect(records[0]!.eventType).toBe("market.tick");
    expect(records[1]!.eventType).toBe("quant.signal");
  });

  it("should filter records by event type", () => {
    const bus = new TypedEventBus();
    const logger = new AuditLogger(bus);
    logger.start();

    bus.publish({ type: "market.tick", data: {}, source: "test" });
    bus.publish({ type: "risk.approved", data: {}, source: "risk" });
    bus.publish({ type: "market.tick", data: {}, source: "test" });

    const marketRecords = logger.getRecords({ eventType: "market.tick" });
    expect(marketRecords).toHaveLength(2);

    const riskRecords = logger.getRecords({ eventType: "risk.approved" });
    expect(riskRecords).toHaveLength(1);
  });

  it("should respect limit parameter", () => {
    const bus = new TypedEventBus();
    const logger = new AuditLogger(bus);
    logger.start();

    for (let i = 0; i < 10; i++) {
      bus.publish({ type: "test.event", data: { i }, source: "test" });
    }

    const limited = logger.getRecords({ limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Agent Memory
// ---------------------------------------------------------------------------

describe("AgentMemory", () => {
  it("should store and retrieve memories", () => {
    const memory = new AgentMemory();
    memory.set("quant", "signal", "last-signal", { side: "buy", price: 68000 });

    const value = memory.get("quant", "signal", "last-signal");
    expect(value).toEqual({ side: "buy", price: 68000 });
  });

  it("should return undefined for missing memory", () => {
    const memory = new AgentMemory();
    expect(memory.get("quant", "signal", "missing")).toBeUndefined();
  });

  it("should delete memories", () => {
    const memory = new AgentMemory();
    memory.set("risk", "decision", "last", { approved: true });
    expect(memory.delete("risk", "decision", "last")).toBe(true);
    expect(memory.get("risk", "decision", "last")).toBeUndefined();
  });

  it("should retrieve by agent", () => {
    const memory = new AgentMemory();
    memory.set("quant", "signal", "s1", { side: "buy" });
    memory.set("quant", "trade", "t1", { pnl: 100 });
    memory.set("risk", "decision", "d1", { approved: false });

    const quantMemories = memory.getByAgent("quant");
    expect(quantMemories).toHaveLength(2);
  });

  it("should retrieve recent memories", () => {
    const memory = new AgentMemory();
    for (let i = 0; i < 5; i++) {
      memory.set("quant", "signal", `s${i}`, { i });
    }

    const recent = memory.getRecent("quant", "signal", 2);
    expect(recent).toHaveLength(2);
  });

  it("should support TTL expiration", async () => {
    const memory = new AgentMemory();
    memory.set("test", "state", "temp", "value", 1); // 1ms TTL

    expect(memory.get("test", "state", "temp")).toBe("value");

    // Wait for TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(memory.get("test", "state", "temp")).toBeUndefined();
  });

  it("should cleanup expired entries", async () => {
    const memory = new AgentMemory();
    memory.set("test", "state", "expired", "value", 1);
    memory.set("test", "state", "permanent", "value");

    await new Promise((r) => setTimeout(r, 10));
    const removed = memory.cleanup();
    expect(removed).toBe(1);
    expect(memory.get("test", "state", "permanent")).toBe("value");
  });
});
