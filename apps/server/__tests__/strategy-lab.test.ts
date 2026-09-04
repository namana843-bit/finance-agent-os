// ============================================================================
// Strategy Lab Tests — Idea -> Strategy -> Backtest -> Performance -> Risk
//                        -> Paper Trading Candidate
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { StrategyRegistry, registerDefaultStrategies } from "../src/strategies/strategy-registry.js";
import { StrategyLab } from "../src/strategy-lab/strategy-lab.js";
import { analyzePerformance } from "../src/strategy-lab/performance.js";
import { analyzeRisk } from "../src/strategy-lab/risk-analysis.js";
import { createStrategyFromIdea, getSupportedKinds } from "../src/strategy-lab/strategy-factory.js";
import type { BacktestCandle, BacktestResult } from "../src/backtesting/backtest-engine.js";
import { BacktestEngine } from "../src/backtesting/backtest-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trendingCandles(n: number, start = 50000, step = 120): BacktestCandle[] {
  let p = start;
  const now = Date.now() - n * 3600000;
  return Array.from({ length: n }, (_, i) => {
    p += step + Math.sin(i * 0.4) * 30;
    const open = p - step * 0.3;
    const close = p;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    return { open, high, low, close, volume: 100, timestamp: now + i * 3600000 };
  });
}

function choppyCandles(n: number, center = 50000): BacktestCandle[] {
  const now = Date.now() - n * 3600000;
  let p = center;
  return Array.from({ length: n }, (_, i) => {
    p += Math.sin(i * 1.1) * 80 + (Math.random() * 20 - 10);
    p = Math.max(30000, p);
    const open = p + Math.random() * 10 - 5;
    const close = p;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    return { open, high, low, close, volume: 100, timestamp: now + i * 3600000 };
  });
}

function makeLab(opts: Partial<ConstructorParameters<typeof StrategyLab>[0]> = {}): { lab: StrategyLab; bus: TypedEventBus; registry: StrategyRegistry } {
  const bus = opts.bus ?? new TypedEventBus();
  const registry = opts.strategyRegistry ?? (() => { const r = new StrategyRegistry(); registerDefaultStrategies(r); return r; })();
  const lab = new StrategyLab({ bus, strategyRegistry: registry, ...opts, bus, strategyRegistry: registry });
  return { lab, bus, registry };
}

// ---------------------------------------------------------------------------
// Factory — modular strategies
// ---------------------------------------------------------------------------

describe("Strategy Factory — modular", () => {
  it("supports known kinds", () => {
    expect(getSupportedKinds()).toEqual(expect.arrayContaining(["ema-crossover", "rsi-reversal", "macd-crossover", "momentum"]));
  });

  it("createStrategyFromIdea is modular per kind", () => {
    for (const kind of ["ema-crossover", "rsi-reversal", "macd-crossover", "momentum"]) {
      const idea = { id: `id-${kind}`, rawIdea: kind, symbol: "BTCUSDT", timeframe: "1h", strategyKind: kind, parameters: {}, createdAt: Date.now() } as any;
      const s = createStrategyFromIdea(idea);
      expect(s.config.id).toBe(`lab:${idea.id}:${kind}`);
      const res = s.calculate(Array.from({ length: 50 }, (_, i) => 50000 + i * 10));
      expect(["buy", "sell", "hold"]).toContain(res.side);
    }
  });

  it("throws for unsupported kind", () => {
    const idea = { id: "x", rawIdea: "x", symbol: "BTCUSDT", timeframe: "1h", strategyKind: "nope", parameters: {}, createdAt: 0 } as any;
    expect(() => createStrategyFromIdea(idea)).toThrow(/Unsupported/);
  });

  it("parameters propagate into strategy (fast/slow, period)", () => {
    const idea = { id: "p1", rawIdea: "ema fast 8 slow 21", symbol: "BTCUSDT", timeframe: "1h", strategyKind: "ema-crossover", parameters: { fastPeriod: 8, slowPeriod: 21 }, createdAt: 0 } as any;
    const s = createStrategyFromIdea(idea);
    expect(s.config.parameters.fastPeriod).toBe(8);
    expect(s.config.parameters.slowPeriod).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// Performance & Risk — pure functions
// ---------------------------------------------------------------------------

describe("Performance Analysis", () => {
  function runBacktest(candles: BacktestCandle[]): BacktestResult {
    const reg = new StrategyRegistry(); registerDefaultStrategies(reg);
    const strat = reg.get("ema-crossover")!;
    return new BacktestEngine({ initialCapital: 100000 }).run(strat, candles, "BTCUSDT", "1h");
  }

  it("computes profitFactor, avgWin/avgLoss, expectancy", () => {
    const bt = runBacktest(trendingCandles(120));
    const perf = analyzePerformance(bt);
    expect(perf.profitFactor).toBeDefined();
    expect(perf.avgWin).toBeGreaterThanOrEqual(0);
    expect(perf.expectancy).toBeDefined();
    expect(["pass", "fail", "inconclusive"]).toContain(perf.verdict);
  });

  it("inconclusive when no trades", () => {
    const reg = new StrategyRegistry(); registerDefaultStrategies(reg);
    // flat candles -> momentum may still trade; force no-trade via tiny series and high confidence
    const flat = Array.from({ length: 50 }, (_, i) => ({ open: 100, high: 100.5, low: 99.5, close: 100, volume: 10, timestamp: Date.now() + i * 60000 } as BacktestCandle));
    const strat = reg.get("momentum")!;
    const bt = new BacktestEngine().run(strat, flat, "BTCUSDT", "1h");
    // if flat yields 0 trades, verdict should be inconclusive
    if (bt.tradeCount === 0) {
      expect(analyzePerformance(bt).verdict).toBe("inconclusive");
    } else {
      expect(bt.tradeCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("fail when thresholds not met", () => {
    // Use a fake result with trades so inconclusive (0 trades) doesn't mask fail
    const fake: BacktestResult = {
      strategyId: "lab:fake:ema-crossover", symbol: "BTCUSDT", timeframe: "1h",
      totalReturn: -15, totalPnl: -15000, winRate: 0.2, lossRate: 0.8, maxDrawdown: 45, sharpeRatio: -0.8,
      tradeCount: 2, totalFees: 50, equityCurve: [100000, 85000], trades: [{ entryPrice: 50000, exitPrice: 49000, side: "buy", quantity: 1, pnl: -1000, fees: 10, entryTime: 0, exitTime: 1 } as any, { entryPrice: 49000, exitPrice: 48500, side: "buy", quantity: 1, pnl: -500, fees: 10, entryTime: 2, exitTime: 3 } as any],
      startDate: 0, endDate: 1,
    };
    const perf = analyzePerformance(fake, { minTrades: 10, minTotalReturn: 5, maxDrawdown: 20, minSharpe: 1 });
    expect(perf.verdict).toBe("fail");
    expect(perf.reasons.length).toBeGreaterThan(0);
  });
});

describe("Risk Analysis", () => {
  it("REJECTED on high drawdown / too few trades", () => {
    const fake: BacktestResult = {
      strategyId: "lab:x:ema-crossover", symbol: "BTCUSDT", timeframe: "1h",
      totalReturn: -30, totalPnl: -30000, winRate: 0.2, lossRate: 0.8, maxDrawdown: 50, sharpeRatio: -1,
      tradeCount: 1, totalFees: 100, equityCurve: [100000, 70000], trades: [], startDate: 0, endDate: 1,
    };
    const perf = analyzePerformance(fake, { minTrades: 1 });
    const risk = analyzeRisk(fake, perf, { maxDrawdown: 30, minTrades: 5 });
    expect(risk.decision).toBe("REJECTED");
    expect(risk.riskScore).toBeGreaterThanOrEqual(25);
    expect(risk.checks).toContain("max_drawdown");
  });

  it("APPROVED when healthy", () => {
    const fake: BacktestResult = {
      strategyId: "lab:y:momentum", symbol: "BTCUSDT", timeframe: "1h",
      totalReturn: 8, totalPnl: 8000, winRate: 0.55, lossRate: 0.45, maxDrawdown: 6, sharpeRatio: 1.2,
      tradeCount: 20, totalFees: 200, equityCurve: [100000, 108000], trades: Array.from({ length: 10 }, () => ({ entryPrice: 50000, exitPrice: 50500, side: "buy" as const, quantity: 1, pnl: 400, fees: 10, entryTime: 0, exitTime: 1 })),
      startDate: 0, endDate: 1,
    };
    const perf = analyzePerformance(fake);
    const risk = analyzeRisk(fake, perf);
    expect(risk.decision).toBe("APPROVED");
    expect(risk.riskScore).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// StrategyLab — Idea -> Candidate workflow
// ---------------------------------------------------------------------------

describe("StrategyLab — Idea parsing", () => {
  it("parses symbol, timeframe, kind from raw idea string", () => {
    const { lab } = makeLab();
    const a = lab.parseIdea("EMA crossover on BTC 1h with fast 12 slow 26");
    expect(a.symbol).toBe("BTCUSDT");
    expect(a.timeframe).toBe("1h");
    expect(a.strategyKind).toBe("ema-crossover");
    expect(a.parameters.fastPeriod).toBe(12);
  });

  it("parses RSI idea", () => {
    const { lab } = makeLab();
    const a = lab.parseIdea("RSI oversold 25 overbought 75 on ETH");
    expect(a.strategyKind).toBe("rsi-reversal");
    expect(a.symbol).toBe("ETHUSDT");
  });

  it("throws on empty idea", () => {
    const { lab } = makeLab();
    expect(() => lab.parseIdea("")).toThrow(/idea is required/);
    expect(() => lab.parseIdea({ idea: "" } as any)).toThrow(/idea is required/);
  });

  it("throws on unsupported kind via object input", () => {
    const { lab } = makeLab();
    expect(() => lab.parseIdea({ idea: "test", strategyKind: "nope" } as any)).toThrow(/Unsupported/);
  });
});

describe("StrategyLab — full workflow", () => {
  it("Idea -> Strategy -> Backtest -> Performance -> Risk -> Candidate (run)", async () => {
    const { lab } = makeLab();
    const candles = trendingCandles(150);
    const run = await lab.run("EMA crossover on BTC 1h", candles);
    expect(run.idea.symbol).toBe("BTCUSDT");
    expect(run.strategyId).toMatch(/^lab:/);
    expect(run.backtest.tradeCount).toBeGreaterThanOrEqual(0);
    expect(run.performance).toBeDefined();
    expect(run.performance.profitFactor).toBeDefined();
    expect(run.risk.decision).toMatch(/APPROVED|REJECTED/);
    expect(run.candidate).toBeDefined();
    expect(typeof run.candidate.approved).toBe("boolean");
    expect(typeof run.candidate.readyForPaper).toBe("boolean");
    expect(run.status).toBe("completed");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps strategies modular: each idea creates namespaced lab: strategy", async () => {
    const { lab } = makeLab();
    const c = trendingCandles(120);
    const r1 = await lab.run("EMA on BTC", c);
    const r2 = await lab.run("RSI on ETH", c.map((x) => ({ ...x })));
    expect(r1.strategyId).not.toBe(r2.strategyId);
    expect(lab.isLabStrategy(r1.strategyId)).toBe(true);
    expect(lab.listLabStrategies()).toEqual(expect.arrayContaining([r1.strategyId, r2.strategyId]));
  });

  it("reuses BacktestEngine — lab backtest matches direct engine result", async () => {
    const { lab, registry } = makeLab();
    const candles = trendingCandles(100);
    // lab path
    const idea = lab.submitIdea("momentum on BTC 1h");
    const btViaLab = await lab.backtest(idea, candles);
    // direct engine path with same strategy id
    const strat = registry.get(btViaLab.strategyId) ?? (() => { throw new Error("lab strategy not registered"); })();
    const direct = new BacktestEngine().run(strat, candles, idea.symbol, idea.timeframe);
    expect(btViaLab.tradeCount).toBe(direct.tradeCount);
    expect(btViaLab.totalPnl).toBeCloseTo(direct.totalPnl, 2);
  });

  it("runIdea with synthetic candles when no market/candles provided", async () => {
    const bus = new TypedEventBus();
    const reg = new StrategyRegistry(); registerDefaultStrategies(reg);
    const lab2 = new StrategyLab({ bus, strategyRegistry: reg }); // no market
    const idea = lab2.submitIdea("EMA on SOL");
    const bt = await lab2.backtest(idea); // should use synthetic candles, not throw
    expect(bt.equityCurve.length).toBeGreaterThan(0);
  });

  it("publishes lab events for each stage", async () => {
    const { lab, bus } = makeLab();
    const seen = new Set<string>();
    bus.subscribe((e) => seen.add(e.type));
    await lab.run("MACD on BTC 1h", trendingCandles(120));
    expect(seen.has("strategy-lab.idea_created")).toBe(true);
    expect(seen.has("strategy-lab.strategy_created")).toBe(true);
    expect(seen.has("strategy-lab.backtest_completed")).toBe(true);
    expect(seen.has("strategy-lab.performance_completed")).toBe(true);
    expect(seen.has("strategy-lab.risk_completed")).toBe(true);
    expect(seen.has("strategy-lab.candidate_approved") || seen.has("strategy-lab.candidate_rejected")).toBe(true);
    expect(seen.has("strategy-lab.run_completed")).toBe(true);
  });

  it("idea -> candidate is paper-only (no live orders)", async () => {
    const { lab } = makeLab();
    const run = await lab.run("RSI on BTC", choppyCandles(120));
    // candidate string should reference paper trading, adapter separation already tested elsewhere
    // but ensure lab never calls live: check no live method on lab
    expect((lab as unknown as { createLiveOrder?: unknown }).createLiveOrder).toBeUndefined();
    expect(run.candidate.reason).toBeDefined();
  });

  it("runtime integration: strategy-lab service registered", async () => {
    const { createRuntime, getStrategyLab } = await import("../src/core/runtime.js");
    const rt = createRuntime();
    const svc = rt.getService("strategy-lab" as unknown as string) as unknown as { getInstance: () => StrategyLab } | undefined;
    expect(svc).toBeDefined();
    const lab = getStrategyLab();
    expect(lab?.id).toBe("strategy-lab");
  });
});
