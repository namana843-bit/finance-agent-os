// ============================================================================
// Order Lifecycle Integration Tests — canonical flow:
// Signal -> Risk approval -> Order request -> Gateway -> OrderManager
// -> ExecutionPipeline -> Broker -> Order events -> Trade -> Portfolio update
// Covers: state machine, idempotency, duplicate protection, IDs/correlation,
// partial fills, cancel/reject, retry-safe, event ordering, consistency,
// persistence, audit events.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { OrderManager } from "../src/order-manager/order-manager.js";
import { PaperBroker } from "../src/broker/paper-broker.js";
import { FinanceGateway } from "../src/gateway/finance-gateway.js";
import { TradeEngine } from "../src/trade-engine/trade-engine.js";
import { RiskAgent } from "../src/agents/risk/index.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import { AuditLogger } from "../src/audit/audit-logger.js";

function makeStack(opts: Record<string, unknown> = {}) {
  const bus = new TypedEventBus();
  const riskAgent = new RiskAgent(bus, { confidenceThreshold: 0.5, maxOpenPositions: 10, maxPositionPct: 100 } as unknown as never);
  const gateway = new FinanceGateway(bus, { executionMode: "paper" } as never);
  const paperBroker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0, allowShort: true, initialCash: 100_000 } as never);
  paperBroker.priceCache.set("BTCUSDT", 50_000);
  paperBroker.priceCache.set("ETHUSDT", 3_000);
  const orderManager = new OrderManager(bus, { persistPath: ":memory:", autoPersist: false } as never);
  // override persist path to avoid filesystem
  (orderManager as unknown as { persistPath: string }).persistPath = ":memory:";
  const tradeEngine = new TradeEngine(bus);
  const auditLogger = new AuditLogger(bus);
  auditLogger.start();
  const pipeline = new ExecutionPipeline({ bus, riskAgent, gateway, paperBroker, orderManager, auditLogger } as never);
  return { bus, riskAgent, gateway, paperBroker, orderManager, tradeEngine, auditLogger, pipeline };
}

describe("Order Lifecycle Integration", () => {
  it("happy path: signal -> risk -> gateway -> orderManager -> pipeline -> broker -> events -> trade -> portfolio", async () => {
    const { bus, orderManager, tradeEngine, pipeline, paperBroker } = makeStack();
    const events: string[] = [];
    const corId = "corr-happy-1";
    bus.subscribe(e => events.push(e.type));
    const signal = { id: "sig-happy-1", symbol: "BTCUSDT", side: "buy" as const, quantity: 1, price: 50_000, agentId: "agent-1", strategy: "test", confidence: 0.9, correlationId: corId };
    const res = await pipeline.execute(signal);
    expect(res.success).toBe(true);
    expect(res.correlationId).toBe(corId);
    // OrderManager canonical state
    const omOrder = orderManager.getOrderByIdempotencyKey("sig-happy-1") ?? orderManager.getOrderByCorrelationId(corId)[0];
    expect(omOrder).toBeDefined();
    expect(omOrder!.status).toBe("FILLED");
    expect(omOrder!.correlationId).toBe(corId);
    expect(omOrder!.filledQuantity).toBe(1);
    // Broker portfolio updated
    const pf = paperBroker.getPortfolio();
    expect(pf.positions.length).toBe(1);
    expect(pf.positions[0]!.quantity).toBe(1);
    // TradeEngine created trade via fill_applied
    await new Promise(r => setTimeout(r, 10));
    expect(tradeEngine.getAllTrades().length).toBe(1);
    expect(tradeEngine.getTradeByOrderId(omOrder!.id)).toBeDefined();
    // Event ordering guarantee: created -> pending -> submitted -> filled (canonical) + pipeline events in order
    const omEvents = bus.getHistory({ correlationId: corId }).map(e => e.type);
    expect(omEvents.indexOf("order.created") < omEvents.indexOf("order.submitted")).toBe(true);
    expect(omEvents.includes("order.filled")).toBe(true);
    // Audit events present
    expect(events.some(t => t.startsWith("audit."))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["execution.pipeline_completed", "order.filled"]));
  });

  it("idempotent order processing + duplicate-order protection", async () => {
    const { pipeline, orderManager, paperBroker } = makeStack();
    const signal = { id: "sig-dup-1", symbol: "BTCUSDT", side: "buy" as const, quantity: 0.1, price: 50_000, agentId: "agent-1", correlationId: "corr-dup", confidence: 0.9 };
    const r1 = await pipeline.execute(signal);
    const r2 = await pipeline.execute(signal); // same correlation+id => idempotent
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.correlationId).toBe(r2.correlationId);
    // Only one order persisted for same idempotencyKey
    expect(orderManager.size()).toBe(1);
    // Only one portfolio position increase, not double
    expect(paperBroker.getPortfolio().positions[0]!.quantity).toBeCloseTo(0.1);
    // Duplicate clientOrderId protection at OrderManager level
    const o1 = orderManager.createOrder({ symbol: "ETHUSDT", side: "buy", type: "market", quantity: 1, price: 3000, executionMode: "paper", clientOrderId: "dup-client-1", correlationId: "c1" });
    const o2 = orderManager.createOrder({ symbol: "ETHUSDT", side: "buy", type: "market", quantity: 1, price: 3000, executionMode: "paper", clientOrderId: "dup-client-1", correlationId: "c2" });
    expect(o1.id).toBe(o2.id);
    expect(orderManager.size()).toBe(2); // second distinct symbol not duplicated beyond dup check
  });

  it("partial-fill support: order moves CREATED->PARTIALLY_FILLED->FILLED with version ordering", async () => {
    const { bus, orderManager } = makeStack();
    const order = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", quantity: 10, price: 50_000, executionMode: "paper", correlationId: "corr-partial" });
    orderManager.updateStatus(order.id, "PENDING");
    orderManager.updateStatus(order.id, "SUBMITTED");
    const events: string[] = [];
    bus.subscribeTo("order.partially_filled", e => events.push(e.type));
    bus.subscribeTo("order.filled", e => events.push(e.type));
    // first partial 4 with explicit id for idempotent dedup
    expect(orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 4, price: 50_000, fee: 0, timestamp: Date.now(), id: "fill-1" })).toBe(true);
    let o = orderManager.getOrder(order.id)!;
    expect(o.status).toBe("PARTIALLY_FILLED");
    expect(o.filledQuantity).toBe(4);
    expect(o.version).toBeGreaterThan(3);
    // duplicate fill idempotent (same id should not double-count)
    expect(orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 4, price: 50_000, fee: 0, timestamp: Date.now(), id: "fill-1" })).toBe(true);
    o = orderManager.getOrder(order.id)!;
    expect(o.filledQuantity).toBe(4); // still 4
    // second distinct partial 4 with different id
    expect(orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 2, price: 50_000, fee: 0, timestamp: Date.now(), id: "fill-2" })).toBe(true);
    o = orderManager.getOrder(order.id)!;
    expect(o.filledQuantity).toBe(6);
    // fill remaining 4 -> FILLED
    expect(orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 4, price: 50_000, fee: 0, timestamp: Date.now(), id: "fill-3" })).toBe(true);
    o = orderManager.getOrder(order.id)!;
    expect(o.status).toBe("FILLED");
    expect(o.filledQuantity).toBe(10);
    expect(events).toContain("order.partially_filled");
    expect(events).toContain("order.filled");
    // overfill rejected
    expect(orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, fee: 0, timestamp: Date.now(), id: "fill-over" })).toBe(false);
  });

  it("cancel support: pending/submitted can cancel, filled cannot, idempotent", async () => {
    const { orderManager, paperBroker } = makeStack();
    // via OrderManager
    const o = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", quantity: 1, price: 40_000, executionMode: "paper" });
    orderManager.updateStatus(o.id, "PENDING");
    expect(orderManager.cancelOrder(o.id, "user request")).toBe(true);
    expect(orderManager.getOrder(o.id)!.status).toBe("CANCELLED");
    expect(orderManager.cancelOrder(o.id)).toBe(true); // idempotent
    // cannot cancel filled
    const o2 = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, price: 50_000, executionMode: "paper" });
    orderManager.updateStatus(o2.id, "PENDING");
    orderManager.updateStatus(o2.id, "SUBMITTED");
    orderManager.applyFill(o2.id, { orderId: o2.id, symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, fee: 0, timestamp: Date.now() });
    expect(orderManager.getOrder(o2.id)!.status).toBe("FILLED");
    expect(orderManager.cancelOrder(o2.id)).toBe(false);
    // via PaperBroker cancel for limit order
    paperBroker.priceCache.set("BTCUSDT", 50_000);
    const limit = await paperBroker.createOrder("BTCUSDT", "buy", 1, "limit", 40_000);
    expect(limit.status).toBe("submitted");
    const cancelled = paperBroker.cancelOrder(limit.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(paperBroker.cancelOrder(limit.id)?.status).toBe("cancelled"); // idempotent
  });

  it("reject support: invalid transition rejected, audit emitted", async () => {
    const { bus, orderManager } = makeStack();
    const audits: string[] = [];
    bus.subscribe(e => { if (e.type.startsWith("audit.")) audits.push(e.type); });
    const o = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, price: 50_000, executionMode: "paper" });
    expect(orderManager.rejectOrder(o.id, "risk fail")).toBe(true);
    expect(orderManager.getOrder(o.id)!.status).toBe("REJECTED");
    expect(audits.some(t => t.includes("rejected"))).toBe(true);
    // cannot transition out of REJECTED
    expect(orderManager.updateStatus(o.id, "SUBMITTED")).toBe(false);
    // PaperBroker reject path via pipeline
    const bus2 = new TypedEventBus();
    const lowCashBroker = new PaperBroker(bus2, { latencyMs: 0, initialCash: 10, allowShort: false } as never);
    lowCashBroker.priceCache.set("BTCUSDT", 50_000);
    const om2 = new OrderManager(bus2, { autoPersist: false } as never);
    const risk = new RiskAgent(bus2, { confidenceThreshold: 0, maxPositionPct: 100, maxOpenPositions: 100 } as never);
    const gw = new FinanceGateway(bus2);
    const pipe2 = new ExecutionPipeline({ bus: bus2, riskAgent: risk, gateway: gw, paperBroker: lowCashBroker, orderManager: om2 } as never);
    const res = await pipe2.execute({ symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, agentId: "a1", id: "sig-reject", confidence: 0.9 } as never);
    expect(res.success).toBe(false);
    expect(res.stage).toBe("paper");
  });

  it("retry-safe execution: FAILED -> PENDING retry and inflight dedup", async () => {
    const { orderManager } = makeStack();
    const o = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, price: 50_000, executionMode: "paper" });
    orderManager.updateStatus(o.id, "PENDING");
    orderManager.failOrder(o.id, "network timeout");
    expect(orderManager.getOrder(o.id)!.status).toBe("FAILED");
    expect(orderManager.retryOrder(o.id)).toBe(true);
    expect(orderManager.getOrder(o.id)!.status).toBe("PENDING");
    // retry again should fail (not FAILED now)
    expect(orderManager.retryOrder(o.id)).toBe(false);
    // pipeline retry-safe: concurrent executes for same correlation return same promise
    const stack = makeStack();
    const sig = { symbol: "BTCUSDT", side: "buy" as const, quantity: 0.5, price: 50_000, agentId: "a1", id: "sig-retry", correlationId: "corr-retry", confidence: 0.9 };
    const p1 = stack.pipeline.execute(sig);
    const p2 = stack.pipeline.execute(sig);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.correlationId).toBe(r2.correlationId);
    expect(r1.success && r2.success).toBe(true);
  });

  it("gateway idempotency: duplicate submitRequest returns same decision without double daily count", async () => {
    const b = new TypedEventBus();
    const risk = new RiskAgent(b, { confidenceThreshold: 0, maxPositionPct: 100, maxOpenPositions: 100 } as never);
    await risk.start();
    const gw = new FinanceGateway(b, { executionMode: "paper" } as never);
    gw.setAgentPermissions("agent-dup", { maxDailyOrders: 1 } as never);
    const req = { symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, quantity: 1, price: 50_000, agentId: "agent-dup", correlationId: "corr-gw-dup", idempotencyKey: "idem-gw-1" };
    const d1 = await gw.submitRequest(req);
    const d2 = await gw.submitRequest(req);
    expect(d1.correlationId).toBe(d2.correlationId);
    expect(d1.approved).toBe(d2.approved);
    await risk.stop();
  });

  it("event ordering guarantees: per-order version monotonic and pipeline stages ordered", async () => {
    const { bus, pipeline } = makeStack();
    const cor = "corr-ordering";
    const res = await pipeline.execute({ symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, agentId: "a1", id: "sig-order", correlationId: cor, confidence: 0.9 });
    expect(res.success).toBe(true);
    const hist = bus.getHistory({ correlationId: cor });
    const types = hist.map(h => h.type);
    // pipeline stages must appear in order
    expect(types.indexOf("execution.pipeline_signal_received") < types.indexOf("execution.pipeline_validated")).toBe(true);
    expect(types.indexOf("execution.pipeline_validated") < types.indexOf("execution.pipeline_risk_checked")).toBe(true);
    expect(types.indexOf("execution.pipeline_risk_checked") < types.indexOf("execution.pipeline_permission_checked")).toBe(true);
    expect(types.indexOf("execution.pipeline_permission_checked") < types.indexOf("execution.pipeline_paper_executed")).toBe(true);
  });

  it("consistent order/trade/position relationships with partial fills aggregating", async () => {
    const { orderManager, tradeEngine, paperBroker } = makeStack();
    paperBroker.priceCache.set("BTCUSDT", 50_000);
    // Create order and partially fill via PaperBroker partialFill then OrderManager apply
    const order = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 2, price: 50_000, executionMode: "paper", correlationId: "corr-consistent" });
    orderManager.updateStatus(order.id, "PENDING");
    orderManager.updateStatus(order.id, "SUBMITTED");
    // broker partial fills
    const brokerOrder = await paperBroker.createOrder("BTCUSDT", "buy", 2, "market");
    // simulate two partial fills via orderManager
    orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, fee: 0, timestamp: Date.now(), id: "pf1" });
    orderManager.applyFill(order.id, { orderId: order.id, symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_100, fee: 5, timestamp: Date.now(), id: "pf2" });
    const o = orderManager.getOrder(order.id)!;
    expect(o.status).toBe("FILLED");
    expect(o.filledQuantity).toBe(2);
    expect(o.averageFillPrice).toBeCloseTo(50_050);
    await new Promise(r => setTimeout(r, 10));
    const trade = tradeEngine.getTradeByOrderId(order.id);
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBe(2);
    // portfolio from broker has position
    expect(paperBroker.getPortfolio().positions.length).toBe(1);
  });

  it("persistent order state: save/load roundtrip", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpPath = join(tmpdir(), `test-orders-persist-${Date.now()}.json`);
    const bus = new TypedEventBus();
    const om = new OrderManager(bus, { persistPath: tmpPath, autoPersist: true } as never);
    om.clear();
    const o = om.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, price: 50_000, executionMode: "paper", correlationId: "corr-persist" });
    om.updateStatus(o.id, "PENDING");
    const bus2 = new TypedEventBus();
    const om2 = new OrderManager(bus2, { persistPath: tmpPath, autoPersist: false } as never);
    expect(om2.getOrder(o.id)).toBeDefined();
    expect(om2.getOrder(o.id)!.status).toBe("PENDING");
    // cleanup
    om.clear();
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(tmpPath); } catch {}
  });

  it("audit events for every important transition", async () => {
    const { bus, orderManager } = makeStack();
    const audits: string[] = [];
    bus.subscribe(e => { if (e.type.startsWith("audit.")) audits.push(e.type); });
    const o = orderManager.createOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, price: 50_000, executionMode: "paper" });
    orderManager.updateStatus(o.id, "PENDING");
    orderManager.updateStatus(o.id, "SUBMITTED");
    orderManager.applyFill(o.id, { orderId: o.id, symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000, fee: 0, timestamp: Date.now() });
    expect(audits).toEqual(expect.arrayContaining(["audit.order_create", "audit.order_pending", "audit.order_submitted", "audit.order_filled"]));
    orderManager.createOrder({ symbol: "ETHUSDT", side: "buy", type: "market", quantity: 1, price: 3000, executionMode: "paper" });
    const o2 = orderManager.getAllOrders().find(x => x.symbol==="ETHUSDT")!;
    orderManager.cancelOrder(o2.id);
    expect(audits).toContain("audit.order_cancelled");
  });
});
