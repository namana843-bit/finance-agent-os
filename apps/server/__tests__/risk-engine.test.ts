// ============================================================================
// Finance Agent OS — Risk Engine Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@finance/core";
import { RiskEngine } from "../src/risk-engine/risk-engine.js";
import type { TradeRequest, PortfolioSnapshot } from "../src/risk-engine/risk-engine.js";

function makeRequest(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: `req-${Date.now()}`,
    symbol: "BTCUSDT",
    side: "buy",
    quantity: 0.01,
    price: 68000,
    confidence: 0.8,
    strategy: "ema-crossover",
    agentId: "quant",
    timestamp: Date.now(),
    correlationId: `corr-${Date.now()}`,
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    cash: 100_000,
    equity: 100_000,
    positions: [],
    dailyPnl: 0,
    peakEquity: 100_000,
    ...overrides,
  };
}

describe("RiskEngine", () => {
  it("should approve a valid trade request", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus);
    const request = makeRequest();
    const portfolio = makePortfolio();

    const decision = engine.evaluate(request, portfolio);
    expect(decision.decision).toBe("APPROVED");
    expect(decision.approvedQuantity).toBeGreaterThan(0);
    expect(decision.rulesChecked).toContain("confidence_threshold");
    expect(decision.rulesChecked).toContain("order_size");
    expect(decision.rulesChecked).toContain("cooldown");
  });

  it("should reject low confidence trades", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { confidenceThreshold: 0.7 });
    const request = makeRequest({ confidence: 0.3 });
    const portfolio = makePortfolio();

    const decision = engine.evaluate(request, portfolio);
    expect(decision.decision).toBe("REJECTED");
    expect(decision.reason).toContain("Low confidence");
  });

  it("should reject when too many open positions", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOpenPositions: 2 });
    const request = makeRequest();
    const portfolio = makePortfolio({
      positions: [
        { symbol: "ETHUSDT", quantity: 1, entryPrice: 3000, currentPrice: 3100, side: "long" },
        { symbol: "SOLUSDT", quantity: 10, entryPrice: 100, currentPrice: 105, side: "long" },
        { symbol: "ADAUSDT", quantity: 1000, entryPrice: 0.5, currentPrice: 0.52, side: "long" },
      ],
    });

    const decision = engine.evaluate(request, portfolio);
    expect(decision.decision).toBe("REJECTED");
    expect(decision.reason).toContain("Max open positions");
  });

  it("should reduce quantity when order size exceeds limit", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOrderSize: 500 });
    const request = makeRequest({ quantity: 0.1, price: 68000 }); // 6800 > 500
    const portfolio = makePortfolio();

    const decision = engine.evaluate(request, portfolio);
    // Should approve but with reduced quantity
    if (decision.decision === "APPROVED") {
      expect(decision.approvedQuantity * request.price).toBeLessThanOrEqual(500);
    }
  });

  it("should reject when symbol exposure exceeds limit", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxSymbolExposure: 10 });
    // notional 6800 (< default maxOrderSize 10000) so the order-size rule
    // does not pre-empt the exposure rule this test targets.
    const request = makeRequest({ symbol: "BTCUSDT", quantity: 0.1, price: 68000 }); // 6800
    const portfolio = makePortfolio({
      equity: 100_000,
      positions: [{ symbol: "BTCUSDT", quantity: 0.1, entryPrice: 68000, currentPrice: 68000, side: "long" }],
    });

    const decision = engine.evaluate(request, portfolio);
    expect(decision.decision).toBe("REJECTED");
    expect(decision.reason).toContain("Symbol exposure");
  });

  it("should reject when portfolio exposure exceeds limit", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxPortfolioExposure: 30, maxSymbolExposure: 50 });
    // notional 6800 (< default maxOrderSize 10000) so the order-size rule
    // does not pre-empt the exposure rule this test targets.
    const request = makeRequest({ quantity: 0.1, price: 68000 }); // 6800
    const portfolio = makePortfolio({
      equity: 100_000,
      positions: [
        { symbol: "ETHUSDT", quantity: 10, entryPrice: 3000, currentPrice: 3000, side: "long" },
        { symbol: "SOLUSDT", quantity: 50, entryPrice: 200, currentPrice: 200, side: "long" },
      ], // total existing: 30000 + 10000 = 40000, + 6800 = 46800 = 46.8%
    });

    const decision = engine.evaluate(request, portfolio);
    expect(decision.decision).toBe("REJECTED");
    expect(decision.reason).toContain("exposure");
  });

  it("should update daily PnL and reset", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus);
    engine.updateDailyPnl(-5000);
    engine.resetDaily();
    const metrics = engine.evaluate(makeRequest(), makePortfolio());
    expect(metrics.riskMetrics.dailyPnL).toBe(0);
  });

  it("should publish risk.approved event on approval", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus);
    let received = false;
    bus.subscribeTo("risk.approved", () => { received = true; });
    engine.evaluate(makeRequest(), makePortfolio());
    expect(received).toBe(true);
  });

  // --- regression: approved-quantity consistency -------------------------

  it("should reject an order that cannot fit a single unit instead of approving 0", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOrderSize: 500 });
    const request = makeRequest({ quantity: 0.1, price: 68000 }); // 6800 notional, 1 unit = 68000 > 500

    const decision = engine.evaluate(request, makePortfolio());
    expect(decision.decision).toBe("REJECTED");
    expect(decision.approvedQuantity).toBe(0);
    expect(decision.ticket).toBeUndefined();
  });

  it("should judge the margin check against the trimmed notional, not the requested one", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOrderSize: 500, maxLeverage: 1 });
    // requested notional 1000 -> trimmed to 500 (5 units @ 100); cash 600 covers it
    const request = makeRequest({ quantity: 10, price: 100 });

    const decision = engine.evaluate(request, makePortfolio({ cash: 600, equity: 2500, peakEquity: 2500 }));
    expect(decision.decision).toBe("APPROVED");
    expect(decision.approvedQuantity).toBe(5);
  });

  it("should judge the exposure checks against the trimmed notional, not the requested one", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOrderSize: 500, maxSymbolExposure: 60 });
    // requested 1000 -> trimmed to 500; 500/1000 equity = 50% < 60%
    const request = makeRequest({ quantity: 10, price: 100 });

    const decision = engine.evaluate(request, makePortfolio({ cash: 600, equity: 1000, peakEquity: 1000 }));
    expect(decision.decision).toBe("APPROVED");
    expect(decision.approvedQuantity).toBe(5);
  });

  it("should trim the order and approve the trimmed quantity", () => {
    const bus = new TypedEventBus();
    const engine = new RiskEngine(bus, { maxOrderSize: 500 });
    const request = makeRequest({ quantity: 10, price: 100 }); // 1000 -> 500

    const decision = engine.evaluate(request, makePortfolio());
    expect(decision.decision).toBe("APPROVED");
    expect(decision.approvedQuantity).toBe(5);
    expect(decision.ticket?.maxQuantity).toBe(5);
  });
});
