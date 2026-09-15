// ============================================================================
// Phase 4: Risk Gate Test Suite
// Covers:
// - approved order
// - oversized order
// - exposure breach
// - margin failure
// - leverage failure
// - daily loss
// - drawdown
// - stale data
// - malformed approval ticket
// - expired approval ticket
// - Risk unavailable / fail-closed
// - Risk exception handling
// - duplicate request / ticket replay attempt
// - direct broker bypass attempt blocked
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { RiskEngine } from "../src/risk-engine/risk-engine.js";
import { RiskAgent } from "../src/agents/risk/index.js";
import { PaperBroker } from "../src/broker/paper-broker.js";
import { FinanceGateway } from "../src/gateway/finance-gateway.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import { OrderManager } from "../src/order-manager/order-manager.js";
import { issueRiskTicket, verifyRiskTicket, markTicketRedeemed, resetUsedTickets } from "../src/risk-engine/ticket.js";

describe("Phase 4 — Risk Gate & Enforcement", () => {
  beforeEach(() => {
    resetUsedTickets();
  });

  describe("RiskEngine check matrix", () => {
    it("approves valid order and issues cryptographically signed RiskApprovalTicket", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus);
      const req = {
        id: "req-1",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.1,
        price: 50_000, // notional: 5,000 <= maxOrderSize 10,000
        confidence: 0.85,
        strategy: "rsi",
        agentId: "agent-1",
        timestamp: Date.now(),
        correlationId: "corr-1",
      };
      const pf = {
        cash: 50_000,
        equity: 50_000,
        positions: [],
        dailyPnl: 0,
        peakEquity: 50_000,
      };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("APPROVED");
      expect(decision.ticket).toBeDefined();
      expect(decision.ticket!.symbol).toBe("BTCUSDT");
      expect(decision.ticket!.side).toBe("buy");
      expect(decision.ticket!.maxQuantity).toBe(0.1);

      // Verify the cryptographic ticket
      const verified = verifyRiskTicket(decision.ticket, {
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        price: 50_000,
        correlationId: "corr-1",
      });
      expect(verified.valid).toBe(true);
    });

    it("clamps or rejects oversized order", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { maxOrderSize: 5000 });
      const req = {
        id: "req-2",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 1,
        price: 50_000, // 50,000 > maxOrderSize 5000
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c2",
      };
      const pf = { cash: 100_000, equity: 100_000, positions: [], dailyPnl: 0, peakEquity: 100_000 };

      const decision = engine.evaluate(req, pf);
      // It clamped approvedQuantity to floor(5000/50000) = 0 or rejected
      if (decision.decision === "APPROVED") {
        expect(decision.approvedQuantity * 50_000).toBeLessThanOrEqual(5000);
      } else {
        expect(decision.decision).toBe("REJECTED");
      }
    });

    it("rejects order on exposure breach", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { maxOrderSize: 100_000, maxPortfolioExposure: 50 });
      const req = {
        id: "req-exp",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 1,
        price: 60_000, // 60k < maxOrderSize 100k
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c-exp",
      };
      // Portfolio equity is 100k, existing positions 40k -> new 60k makes 100k = 100% > 50%
      const pf = {
        cash: 60_000,
        equity: 100_000,
        positions: [{ symbol: "ETHUSDT", quantity: 10, entryPrice: 4000, currentPrice: 4000, side: "long" as const }],
        dailyPnl: 0,
        peakEquity: 100_000,
      };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/exposure/i);
    });

    it("rejects order on margin / insufficient cash failure", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { maxLeverage: 1 });
      const req = {
        id: "req-margin",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.1,
        price: 50_000, // requires 5,000 cash
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c-margin",
      };
      const pf = { cash: 100, equity: 100, positions: [], dailyPnl: 0, peakEquity: 100 }; // only 100 cash

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/cash|margin/i);
    });

    it("rejects order on leverage failure", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, {
        maxLeverage: 1.5,
        maxOrderSize: 20_000,
        maxSymbolExposure: 200,
        maxPortfolioExposure: 200,
      });
      // Existing position is 4,000; new order is 8,000 (total position 12,000)
      // Cash is 7,000. Required margin for new order is 8,000 / 1.5 = 5,333 <= 7,000 cash
      // But total leverage = 12,000 / 7,000 = 1.71x > 1.5x maxLeverage!
      const req = {
        id: "req-lev",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.16,
        price: 50_000, // 8,000
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c-lev",
      };
      const pf = {
        cash: 7_000,
        equity: 11_000,
        positions: [{ symbol: "ETHUSDT", quantity: 1, entryPrice: 4000, currentPrice: 4000, side: "long" as const }],
        dailyPnl: 0,
        peakEquity: 11_000,
      };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/leverage/i);
    });

    it("rejects order on daily loss breach", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { maxDailyLoss: 5 });
      engine.updateDailyPnl(-6_000); // 6k loss on 100k = 6% > 5%
      const req = {
        id: "req-loss",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.05,
        price: 50_000,
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c-loss",
      };
      const pf = { cash: 94_000, equity: 94_000, positions: [], dailyPnl: -6000, peakEquity: 100_000 };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/daily loss/i);
    });

    it("rejects order on drawdown breach", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { maxDrawdown: 10 });
      // peak was 100k, current equity is 85k -> 15% drawdown > 10%
      const pf = { cash: 85_000, equity: 85_000, positions: [], dailyPnl: 0, peakEquity: 100_000 };
      const req = {
        id: "req-dd",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.05,
        price: 50_000,
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c-dd",
      };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/drawdown/i);
    });

    it("rejects order on stale market data", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { staleThresholdMs: 10_000 });
      const req = {
        id: "req-stale",
        symbol: "BTCUSDT",
        side: "buy" as const,
        quantity: 0.05,
        price: 50_000,
        confidence: 0.9,
        strategy: "test",
        agentId: "a1",
        timestamp: Date.now() - 45_000, // 45 seconds old > 10s
        correlationId: "c-stale",
      };
      const pf = { cash: 100_000, equity: 100_000, positions: [], dailyPnl: 0, peakEquity: 100_000 };

      const decision = engine.evaluate(req, pf);
      expect(decision.decision).toBe("REJECTED");
      expect(decision.reason).toMatch(/stale/i);
    });

    it("rejects order on restricted / non-allowed symbol", () => {
      const bus = new TypedEventBus();
      const engine = new RiskEngine(bus, { blockedSymbols: ["DOGEUSDT"], allowedSymbols: ["BTCUSDT", "ETHUSDT"] });
      const pf = { cash: 100_000, equity: 100_000, positions: [], dailyPnl: 0, peakEquity: 100_000 };

      const rBlocked = engine.evaluate({
        id: "r1",
        symbol: "DOGEUSDT",
        side: "buy",
        quantity: 100,
        price: 0.1,
        confidence: 0.9,
        strategy: "t",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c1",
      }, pf);
      expect(rBlocked.decision).toBe("REJECTED");
      expect(rBlocked.reason).toMatch(/restricted|blacklisted/i);

      const rNotAllowed = engine.evaluate({
        id: "r2",
        symbol: "SOLUSDT",
        side: "buy",
        quantity: 1,
        price: 100,
        confidence: 0.9,
        strategy: "t",
        agentId: "a1",
        timestamp: Date.now(),
        correlationId: "c2",
      }, pf);
      expect(rNotAllowed.decision).toBe("REJECTED");
      expect(rNotAllowed.reason).toMatch(/allowed/i);
    });
  });

  describe("Ticket verification, tampering, expiration & anti-replay", () => {
    it("detects malformed or tampered tickets", () => {
      const ticket = issueRiskTicket({
        correlationId: "c-tamp",
        riskDecisionId: "d-tamp",
        symbol: "BTCUSDT",
        side: "buy",
        maxQuantity: 1,
        maxPrice: 50_000,
        agentId: "a1",
      });

      // Tampering quantity
      const tamperedTicket = { ...ticket, maxQuantity: 10 };
      const res = verifyRiskTicket(tamperedTicket, { symbol: "BTCUSDT", side: "buy", quantity: 10, price: 50_000 });
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/signature mismatch/i);
    });

    it("rejects expired tickets", () => {
      const ticket = issueRiskTicket({
        correlationId: "c-exp",
        riskDecisionId: "d-exp",
        symbol: "BTCUSDT",
        side: "buy",
        maxQuantity: 1,
        maxPrice: 50_000,
        agentId: "a1",
        ttlMs: -1000, // already expired
      });

      const res = verifyRiskTicket(ticket, { symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000 });
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/expired/i);
    });

    it("prevents ticket replay attack (double redemption)", () => {
      const ticket = issueRiskTicket({
        correlationId: "c-rep",
        riskDecisionId: "d-rep",
        symbol: "BTCUSDT",
        side: "buy",
        maxQuantity: 1,
        maxPrice: 50_000,
        agentId: "a1",
      });

      // First verification and redemption
      const v1 = verifyRiskTicket(ticket, { symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000 });
      expect(v1.valid).toBe(true);

      markTicketRedeemed(ticket.ticketId, ticket.expiresAt);

      // Second attempt with same ticket must fail
      const v2 = verifyRiskTicket(ticket, { symbol: "BTCUSDT", side: "buy", quantity: 1, price: 50_000 });
      expect(v2.valid).toBe(false);
      expect(v2.reason).toMatch(/replay/i);
    });
  });

  describe("Broker boundary & bypass hunter", () => {
    it("PaperBroker blocks direct order placement when requireRiskApproval is enabled and ticket is missing", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { requireRiskApproval: true, latencyMs: 0 });
      broker.priceCache.set("BTCUSDT", 50_000);

      const audits: string[] = [];
      bus.subscribe(e => {
        if (e.type === "audit.risk_bypass_attempt") audits.push(e.type);
      });

      // Attempt direct order creation without passing a risk ticket
      const order = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(order.status).toBe("rejected");
      expect(order.reason).toMatch(/Risk approval missing/i);
      expect(audits).toContain("audit.risk_bypass_attempt");
    });

    it("PaperBroker accepts order when valid RiskApprovalTicket is provided", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { requireRiskApproval: true, latencyMs: 0 });
      broker.priceCache.set("BTCUSDT", 50_000);

      const ticket = issueRiskTicket({
        correlationId: "corr-legit",
        riskDecisionId: "dec-legit",
        symbol: "BTCUSDT",
        side: "buy",
        maxQuantity: 1,
        maxPrice: 50_000,
        agentId: "agent-legit",
      });

      const order = await broker.createOrder("BTCUSDT", "buy", 1, "market", 50_000, {
        riskApprovalTicket: ticket,
        correlationId: "corr-legit",
      });

      expect(order.status).toBe("filled");
      expect(order.symbol).toBe("BTCUSDT");
      expect(order.quantity).toBe(1);
    });

    it("ExecutionPipeline enforces Risk approval and rejects if Risk throws exception (fail closed)", async () => {
      const bus = new TypedEventBus();
      const riskAgent = new RiskAgent(bus);
      // Simulate Risk throwing unexpected internal exception
      riskAgent.evaluate = () => {
        throw new Error("Catastrophic risk engine crash");
      };

      const gateway = new FinanceGateway(bus);
      const broker = new PaperBroker(bus, { latencyMs: 0, requireRiskApproval: true });
      broker.priceCache.set("BTCUSDT", 50_000);
      const om = new OrderManager(bus, { autoPersist: false });

      const pipeline = new ExecutionPipeline({
        bus,
        riskAgent,
        gateway,
        paperBroker: broker,
        orderManager: om,
        config: { requireRiskApproval: true },
      });

      const res = await pipeline.execute({
        id: "sig-crash",
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 1,
        price: 50_000,
        agentId: "a1",
        confidence: 0.9,
      });

      expect(res.success).toBe(false);
      expect(res.stage).toBe("risk");
      expect(res.reason).toMatch(/risk error/i);
    });

    it("complete audit trail: signal -> risk decision -> ticket -> order -> fill", async () => {
      const bus = new TypedEventBus();
      const riskAgent = new RiskAgent(bus, { confidenceThreshold: 0.5, maxPositionPct: 100, maxOpenPositions: 10 });
      const gateway = new FinanceGateway(bus);
      const broker = new PaperBroker(bus, { latencyMs: 0, requireRiskApproval: true });
      broker.priceCache.set("BTCUSDT", 50_000);
      const om = new OrderManager(bus, { autoPersist: false });

      const pipeline = new ExecutionPipeline({
        bus,
        riskAgent,
        gateway,
        paperBroker: broker,
        orderManager: om,
        config: { requireRiskApproval: true },
      });

      const corId = "corr-audit-trace-1";
      const events: string[] = [];
      bus.subscribe(e => events.push(e.type));

      const res = await pipeline.execute({
        id: "sig-trace",
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        price: 50_000,
        agentId: "agent-trace",
        confidence: 0.95,
        correlationId: corId,
      });

      expect(res.success).toBe(true);
      expect(events).toContain("risk.approved");
      expect(events).toContain("audit.risk_approved");
      expect(events).toContain("execution.pipeline_risk_checked");
      expect(events).toContain("order.created");
      expect(events).toContain("order.filled");
    });
  });
});
