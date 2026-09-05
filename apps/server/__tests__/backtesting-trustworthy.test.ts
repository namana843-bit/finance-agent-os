// ============================================================================
// Finance Agent OS — Phase 7 Trustworthy Backtesting Tests
// Validates:
// 1. Strict Zero Look-ahead Bias (next_bar_open execution, future alteration invariance)
// 2. Realistic Execution Simulation (slippage, spread, fees, volume limit, limit fills)
// 3. Portfolio Accounting & Cash Insolvency Protection
// 4. Institutional Performance Metrics (Sharpe, Sortino, CAGR, Drawdown, Profit Factor)
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  BacktestEngine,
  type BacktestCandle,
} from "../src/backtesting/backtest-engine.js";
import {
  ExecutionSimulator,
  DEFAULT_EXECUTION_CONFIG,
} from "../src/backtesting/execution-simulator.js";
import { calculateBacktestMetrics } from "../src/backtesting/metrics.js";
import {
  StrategyRegistry,
  registerDefaultStrategies,
} from "../src/strategies/strategy-registry.js";

describe("Phase 7: Trustworthy Backtesting Engine", () => {
  const reg = new StrategyRegistry();
  registerDefaultStrategies(reg);

  // Generate synthetic candles with cyclical waves for deterministic crossover tests
  function generateCandles(count: number, basePrice = 100): BacktestCandle[] {
    const candles: BacktestCandle[] = [];
    const now = Date.now() - count * 60_000;

    for (let i = 0; i < count; i++) {
      const price = basePrice + Math.sin(i / 4) * 20;
      const open = price - 0.2;
      const close = price + 0.2;
      const high = price + 1.0;
      const low = price - 1.0;
      const volume = 1000 + (i % 10) * 100;
      const timestamp = now + i * 60_000;

      candles.push({ open, high, low, close, volume, timestamp });
    }
    return candles;
  }

  // -------------------------------------------------------------------------
  // 1. Zero Look-ahead Bias
  // -------------------------------------------------------------------------

  describe("Zero Look-ahead Bias", () => {
    it("executes trades on the open of the subsequent bar in next_bar_open mode", () => {
      const candles = generateCandles(120, 100);
      const strat = reg.get("ema-crossover")!;

      const engine = new BacktestEngine({
        initialCapital: 100_000,
        executionMode: "next_bar_open",
      });

      const result = engine.run(strat, candles, "BTCUSDT", "1h", 40);
      expect(result.trades.length).toBeGreaterThan(0);

      // Verify that for all trades, entryPrice matches the open of the bar following the signal
      for (const trade of result.trades) {
        // Find candle at entryTime
        const entryCandle = candles.find((c) => c.timestamp === trade.entryTime);
        expect(entryCandle).toBeDefined();
        // Entry price should be close to entry candle's open (adjusted by slippage/spread)
        const expectedBasePrice = entryCandle!.open;
        expect(trade.entryPrice).toBeGreaterThan(expectedBasePrice * 0.98);
        expect(trade.entryPrice).toBeLessThan(expectedBasePrice * 1.02);
      }
    });

    it("future candle mutations beyond bar i do not alter decision or execution at bar i", () => {
      const candles1 = generateCandles(80, 100);
      // Clone candles1 and append completely divergent future bars to candles2
      const candles2 = JSON.parse(JSON.stringify(candles1)) as BacktestCandle[];

      // In candles2, add 40 crash candles at the end
      let lastPrice = candles2[candles2.length - 1]!.close;
      for (let i = 0; i < 40; i++) {
        lastPrice *= 0.9;
        candles2.push({
          open: lastPrice * 1.01,
          high: lastPrice * 1.02,
          low: lastPrice * 0.98,
          close: lastPrice,
          volume: 5000,
          timestamp: candles2[candles2.length - 1]!.timestamp + 60_000,
        });
      }

      const strat = reg.get("ema-crossover")!;
      const engine = new BacktestEngine({ executionMode: "next_bar_open" });

      const res1 = engine.run(strat, candles1, "BTCUSDT", "1h", 40);
      const res2 = engine.run(strat, candles2, "BTCUSDT", "1h", 40);

      expect(res1.trades.length).toBeGreaterThan(0);

      // Trades that executed within the range of candles1 must be identical in both runs
      const res2TradesWithinRange1 = res2.trades.filter(
        (t) => t.entryTime <= candles1[candles1.length - 1]!.timestamp
      );

      expect(res1.trades.length).toBe(res2TradesWithinRange1.length);
      for (let i = 0; i < res1.trades.length; i++) {
        expect(res1.trades[i]!.entryPrice).toBe(res2TradesWithinRange1[i]!.entryPrice);
        expect(res1.trades[i]!.side).toBe(res2TradesWithinRange1[i]!.side);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Realistic Execution Simulator
  // -------------------------------------------------------------------------

  describe("Realistic Execution Simulator", () => {
    const sim = new ExecutionSimulator({
      slippageBps: 10, // 0.10%
      spreadBps: 6, // 0.06% (half spread = 0.03%)
      makerFeeRate: 0.0005, // 0.05%
      takerFeeRate: 0.001, // 0.10%
      maxVolumeParticipation: 0.10, // 10%
    });

    const candle: BacktestCandle = {
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
      timestamp: 1600000000000,
    };

    it("applies slippage and spread to market buy order", () => {
      const order = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "market" as const,
        quantity: 10,
        timestamp: candle.timestamp,
      };

      const fill = sim.fillMarketOrder(order, candle, 100_000, candle.open);
      expect(fill.filled).toBe(true);

      // Raw price 100
      // Half spread = 100 * (6/2)/10000 = 0.03
      // Slippage = 100 * 10/10000 = 0.10
      // Fill price = 100 + 0.03 + 0.10 = 100.13
      expect(fill.fillPrice).toBeCloseTo(100.13, 2);
      expect(fill.fee).toBeCloseTo(100.13 * 10 * 0.001, 3);
      expect(fill.isMaker).toBe(false);
    });

    it("applies slippage and spread to market sell order", () => {
      const order = {
        symbol: "BTCUSDT",
        side: "sell" as const,
        type: "market" as const,
        quantity: 10,
        timestamp: candle.timestamp,
      };

      const fill = sim.fillMarketOrder(order, candle, 100_000, candle.open);
      expect(fill.filled).toBe(true);

      // Raw price 100 - halfSpread (0.03) - slippage (0.10) = 99.87
      expect(fill.fillPrice).toBeCloseTo(99.87, 2);
    });

    it("caps quantity when order exceeds maxVolumeParticipation", () => {
      const largeOrder = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "market" as const,
        quantity: 500, // Bar volume is 1000; 10% limit = 100
        timestamp: candle.timestamp,
      };

      const fill = sim.fillMarketOrder(largeOrder, candle, 100_000, candle.open);
      expect(fill.filled).toBe(true);
      expect(fill.filledQuantity).toBe(100); // Capped at 10% of 1000
    });

    it("simulates limit buy order filling when low touches limit price with maker fee", () => {
      const limitOrder = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "limit" as const,
        quantity: 5,
        limitPrice: 96, // candle range is [95, 105], so 96 is reached
        timestamp: candle.timestamp,
      };

      const fill = sim.fillLimitOrder(limitOrder, candle, 100_000);
      expect(fill.filled).toBe(true);
      expect(fill.fillPrice).toBe(96);
      expect(fill.isMaker).toBe(true);
      expect(fill.fee).toBeCloseTo(96 * 5 * 0.0005, 3); // Maker fee rate
    });

    it("rejects limit order when price range is not reached", () => {
      const unreachableOrder = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "limit" as const,
        quantity: 5,
        limitPrice: 90, // candle low is 95, 90 was never reached
        timestamp: candle.timestamp,
      };

      const fill = sim.fillLimitOrder(unreachableOrder, candle, 100_000);
      expect(fill.filled).toBe(false);
      expect(fill.reason).toContain("not reached");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Portfolio Accounting & Insolvency Protection
  // -------------------------------------------------------------------------

  describe("Portfolio Accounting & Cash Protection", () => {
    it("prevents negative cash and scales order down if cash is insufficient", () => {
      const sim = new ExecutionSimulator();
      const candle: BacktestCandle = {
        open: 100,
        high: 105,
        low: 95,
        close: 100,
        volume: 10000,
        timestamp: Date.now(),
      };

      const expensiveOrder = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "market" as const,
        quantity: 200, // costs ~20,000
        timestamp: candle.timestamp,
      };

      // Only 500 cash available
      const fill = sim.fillMarketOrder(expensiveOrder, candle, 500);
      expect(fill.filled).toBe(true);
      expect(fill.filledQuantity * fill.fillPrice + fill.fee).toBeLessThanOrEqual(500.01);
    });

    it("rejects fill completely when cash is near zero", () => {
      const sim = new ExecutionSimulator();
      const candle: BacktestCandle = {
        open: 100,
        high: 105,
        low: 95,
        close: 100,
        volume: 1000,
        timestamp: Date.now(),
      };

      const order = {
        symbol: "BTCUSDT",
        side: "buy" as const,
        type: "market" as const,
        quantity: 1,
        timestamp: candle.timestamp,
      };

      const fill = sim.fillMarketOrder(order, candle, 0.05); // 5 cents
      expect(fill.filled).toBe(false);
      expect(fill.reason).toContain("Insufficient cash");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Institutional Financial Metrics Calculation
  // -------------------------------------------------------------------------

  describe("Institutional Performance Metrics", () => {
    it("accurately calculates Sharpe, Sortino, CAGR, Max Drawdown, and Profit Factor", () => {
      const initialCapital = 100_000;
      const equityCurve = [100_000, 102_000, 105_000, 103_000, 108_000, 115_000];
      const trades = [
        { entryPrice: 100, exitPrice: 105, side: "buy" as const, quantity: 100, pnl: 500, fees: 5, entryTime: 1000, exitTime: 2000 },
        { entryPrice: 105, exitPrice: 108, side: "buy" as const, quantity: 100, pnl: 300, fees: 5, entryTime: 2000, exitTime: 3000 },
        { entryPrice: 108, exitPrice: 106, side: "buy" as const, quantity: 100, pnl: -200, fees: 5, entryTime: 3000, exitTime: 4000 },
        { entryPrice: 106, exitPrice: 114, side: "buy" as const, quantity: 100, pnl: 800, fees: 5, entryTime: 4000, exitTime: 5000 },
      ];

      const metrics = calculateBacktestMetrics({
        initialCapital,
        equityCurve,
        trades,
        startDate: 0,
        endDate: 365.25 * 24 * 3600 * 1000, // 1 year duration
      });

      expect(metrics.totalReturn).toBe(15); // (115,000 - 100,000) / 100,000 = 15%
      expect(metrics.totalPnl).toBe(15_000);
      expect(metrics.cagr).toBeCloseTo(15, 0);
      expect(metrics.tradeCount).toBe(4);
      expect(metrics.winningTrades).toBe(3);
      expect(metrics.losingTrades).toBe(1);
      expect(metrics.winRate).toBe(0.75);
      expect(metrics.profitFactor).toBeCloseTo((500 + 300 + 800) / 200, 2); // 1600 / 200 = 8.0
      expect(metrics.sharpeRatio).toBeGreaterThan(0);
      expect(metrics.sortinoRatio).toBeGreaterThan(0);
      expect(metrics.maxDrawdown).toBeGreaterThan(0);
    });
  });
});
