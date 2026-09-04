// ============================================================================
// Finance Environment Tests — market / portfolio / paper trading / backtest
// OpenMausBot-inspired Environment abstraction.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus, FinanceRuntime } from "@finance/core";
import { createFinanceEnvironment, createTestEnvironment } from "../src/environment/index.js";
import { BinanceMarketDataAdapter } from "../src/environment/adapters/binance-market-data.adapter.js";
import { PaperTradingAdapter } from "../src/environment/adapters/paper-trading.adapter.js";
import { MemoryExchangeProvider } from "../src/providers/memory-provider.js";
import { StrategyRegistry, registerDefaultStrategies } from "../src/strategies/strategy-registry.js";
import type { BacktestCandle } from "../src/backtesting/backtest-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandles(n: number, start = 100, vol = 2): BacktestCandle[] {
  let price = start;
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const high = open + Math.random() * vol;
    const low = open - Math.random() * vol;
    const close = low + Math.random() * (high - low);
    price = close;
    return { open, high, low, close, volume: 100 + Math.random() * 50, timestamp: now + i * 60000 };
  });
}

function trendingUp(n: number): BacktestCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 3;
    return { open: close - 1, high: close + 2, low: close - 2, close, volume: 100, timestamp: Date.now() + i * 60000 };
  });
}

// ---------------------------------------------------------------------------
// Market Data — Binance adapter (synthetic fallback, no network)
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — market data (Binance adapter)", () => {
  it("getPrice returns price for known symbol", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus, mode: "paper" });
    const res = await env.market.getPrice("BTCUSDT");
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.price).toBeGreaterThan(0);
    expect(res.source).toBe("binance");
  });

  it("getOHLCV returns candles with OHLCV shape", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus });
    const bars = await env.market.getOHLCV("BTCUSDT", "1h", 5);
    expect(bars).toHaveLength(5);
    for (const b of bars) {
      expect(b.symbol).toBe("BTCUSDT");
      expect(b.open).toBeGreaterThan(0);
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.closed).toBe(true);
    }
  });

  it("getOrderBook returns bids/asks with spread", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus });
    const book = await env.market.getOrderBook("BTCUSDT", 5);
    expect(book.bids).toHaveLength(5);
    expect(book.asks).toHaveLength(5);
    expect(book.bids[0]!.price).toBeLessThan(book.asks[0]!.price);
  });

  it("BinanceMarketDataAdapter is market-only — no trading", async () => {
    const adapter = new BinanceMarketDataAdapter();
    expect((adapter as unknown as { createOrder?: unknown }).createOrder).toBeUndefined();
    expect((adapter as unknown as { getBalance?: unknown }).getBalance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Portfolio — via PaperTradingAdapter
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — portfolio (Paper Trading adapter)", () => {
  it("getBalance / getPortfolio return paper state", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus, mode: "paper" });
    const bal = await env.portfolio.getBalance();
    expect(bal.USDT).toBeDefined();
    expect(bal.USDT!.total).toBe(100000);

    const port = await env.portfolio.getPortfolio();
    expect(port.cash).toBe(100000);
    expect(port.positions).toHaveLength(0);
  });

  it("getPositions filters via environment portfolio", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus });
    // Seed price so paper broker can fill
    const trading = env.trading as unknown as PaperTradingAdapter;
    trading.seedPrice("BTCUSDT", 68000);
    // Initially empty
    expect(await env.portfolio.getPositions()).toHaveLength(0);
    await env.trading.createOrder({ symbol: "BTCUSDT", side: "buy", quantity: 0.1 });
    const positions = await env.portfolio.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe("BTCUSDT");
  });
});

// ---------------------------------------------------------------------------
// Paper Trading — no live orders
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — paper trading (no live orders)", () => {
  let bus: TypedEventBus;
  let env: ReturnType<typeof createFinanceEnvironment>;

  beforeEach(() => {
    bus = new TypedEventBus();
    env = createFinanceEnvironment({ bus, mode: "paper" });
    (env.trading as unknown as PaperTradingAdapter).seedPrice("BTCUSDT", 70000);
    (env.trading as unknown as PaperTradingAdapter).seedPrice("ETHUSDT", 3500);
  });

  it("createOrder buy fills and creates position", async () => {
    const order = await env.trading.createOrder({ symbol: "BTCUSDT", side: "buy", quantity: 0.2 });
    expect(order.status).toBe("filled");
    expect(order.symbol).toBe("BTCUSDT");
    const port = await env.trading.getPortfolio();
    expect(port.positions.some((p) => p.symbol === "BTCUSDT")).toBe(true);
    expect(port.cash).toBeLessThan(100000);
  });

  it("createOrder sell requires position", async () => {
    const rejected = await env.trading.createOrder({ symbol: "BTCUSDT", side: "sell", quantity: 1 });
    expect(rejected.status).toBe("rejected");
  });

  it("buy then sell realizes PnL", async () => {
    await env.trading.createOrder({ symbol: "BTCUSDT", side: "buy", quantity: 0.5 });
    // Move price up
    (env.trading as unknown as PaperTradingAdapter).seedPrice("BTCUSDT", 72000);
    // Need to update position's mark price via tick — paper broker updates via bus tick,
    // but seedPrice directly sets priceCache, so sell will use 72000
    const sell = await env.trading.createOrder({ symbol: "BTCUSDT", side: "sell", quantity: 0.5 });
    expect(sell.status).toBe("filled");
    const port = await env.trading.getPortfolio();
    expect(port.positions).toHaveLength(0);
    expect(port.realizedPnl).toBeGreaterThan(0);
  });

  it("getOrders / getOpenOrders", async () => {
    await env.trading.createOrder({ symbol: "ETHUSDT", side: "buy", quantity: 1 });
    const orders = await env.trading.getOrders();
    expect(orders.length).toBeGreaterThanOrEqual(1);
    const open = await env.trading.getOpenOrders();
    expect(Array.isArray(open)).toBe(true);
  });

  it("cancelOrder is safe (paper only)", async () => {
    const res = await env.trading.cancelOrder("non-existent-id");
    expect(res.status).toBe("not_found");
  });

  it("validates inputs and never hits live exchange", async () => {
    await expect(env.trading.createOrder({ symbol: "", side: "buy", quantity: 1 })).rejects.toThrow(/symbol is required/);
    await expect(env.trading.createOrder({ symbol: "BTCUSDT", side: "buy" as unknown as "sell", quantity: 0 })).rejects.toThrow(/quantity must be a positive/);
    await expect(env.trading.createOrder({ symbol: "BTCUSDT", side: "buy", quantity: 1, type: "limit" })).rejects.toThrow(/price is required for limit/);
    // Ensure no live adapter method is exposed
    expect((env.trading as unknown as { createLiveOrder?: unknown }).createLiveOrder).toBeUndefined();
  });

  it("isPaperTrading true, isBacktest false in paper mode", () => {
    expect(env.isPaperTrading()).toBe(true);
    expect(env.isBacktest()).toBe(false);
    expect(() => env.assertPaperOnly()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Backtesting — via environment
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — backtesting", () => {
  it("run backtest with strategyId and candles", async () => {
    const bus = new TypedEventBus();
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const env = createFinanceEnvironment({ bus, mode: "backtest", strategyRegistry: registry });
    const candles = trendingUp(100);
    const result = await env.backtest.run({ strategyId: "ema-crossover", symbol: "BTCUSDT", candles, timeframe: "1m" });
    expect(result.strategyId).toBe("ema-crossover");
    expect(result.symbol).toBe("BTCUSDT");
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.trades).toBeDefined();
  });

  it("runWithMarketData fetches OHLCV then backtests", async () => {
    const bus = new TypedEventBus();
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    // Use memory market adapter for deterministic candles
    const mem = new MemoryExchangeProvider();
    const env = createFinanceEnvironment({
      bus,
      mode: "backtest",
      strategyRegistry: registry,
      marketAdapter: {
        getPrice: (s) => mem.getPrice(s),
        getOHLCV: (s, tf, lim) => mem.getOHLCV(s, tf, lim),
        getOrderBook: (s, d) => mem.getOrderBook(s, d),
      },
    });
    const result = await env.backtest.runWithMarketData({ strategyId: "rsi-reversal", symbol: "BTCUSDT", timeframe: "1h", limit: 50 });
    expect(result.strategyId).toBe("rsi-reversal");
    expect(result.tradeCount).toBeDefined();
  });

  it("throws for unknown strategy or missing candles", async () => {
    const bus = new TypedEventBus();
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const env = createFinanceEnvironment({ bus, mode: "backtest", strategyRegistry: registry });
    await expect(env.backtest.run({ strategyId: "nope", symbol: "BTCUSDT", candles: makeCandles(20) })).rejects.toThrow(/not found/);
    await expect(env.backtest.run({ strategyId: "ema-crossover", symbol: "BTCUSDT", candles: [] })).rejects.toThrow(/candles is required/);
  });

  it("emits backtest.completed event", async () => {
    const bus = new TypedEventBus();
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const env = createFinanceEnvironment({ bus, mode: "backtest", strategyRegistry: registry });
    let emitted = false;
    bus.subscribeTo("backtest.completed", () => {
      emitted = true;
    });
    await env.backtest.run({ strategyId: "momentum", symbol: "BTCUSDT", candles: makeCandles(60) });
    expect(emitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter separation — exchange-specific code isolated
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — adapter separation", () => {
  it("market adapter and trading adapter are distinct, no live orders", async () => {
    const bus = new TypedEventBus();
    const env = createFinanceEnvironment({ bus });
    expect(env.market).toBeDefined();
    expect(env.trading).toBeDefined();
    expect(env.market).not.toBe(env.trading as unknown as object);
    // Paper adapter should not import BinanceAdapter
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "../../..");
    const paperSrc = await readFile(resolve(repoRoot, "apps/server/src/environment/adapters/paper-trading.adapter.ts"), "utf8");
    expect(paperSrc).not.toMatch(/BinanceAdapter/);
    expect(paperSrc).not.toMatch(/BinanceMarketDataAdapter/);
    const binanceSrc = await readFile(resolve(repoRoot, "apps/server/src/environment/adapters/binance-market-data.adapter.ts"), "utf8");
    expect(binanceSrc).toMatch(/BinanceAdapter/);
    expect(binanceSrc).not.toMatch(/PaperBroker/);
  });

  it("createTestEnvironment is isolated (no network)", async () => {
    const bus = new TypedEventBus();
    const { createTestEnvironment } = await import("../src/environment/index.js");
    const env = await createTestEnvironment(bus);
    const price = await env.market.getPrice("BTCUSDT");
    expect(price.source).toBe("memory");
    expect(env.isPaperTrading()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration — FinanceEnvironment as service
// ---------------------------------------------------------------------------

describe("FinanceEnvironment — runtime integration", () => {
  it("runtime registers finance-environment service", async () => {
    const { createRuntime } = await import("../src/core/runtime.js");
    const rt = createRuntime();
    const envService = rt.getService("finance-environment" as unknown as string) as unknown as { getInstance: () => { id: string; mode: string } } | undefined;
    // Service should be registered (even before start)
    expect(envService).toBeDefined();
    // Via accessor
    const { getFinanceEnvironment } = await import("../src/core/runtime.js");
    const env = getFinanceEnvironment();
    expect(env?.id).toBe("finance-environment");
    expect(env?.mode).toBe("paper");
  });
});
