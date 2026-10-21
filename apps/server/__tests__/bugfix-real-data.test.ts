// ============================================================================
// Bug Fix Tests — real market data + implemented stubs
//
// Covers the fixes for:
//   1. /api/market/candles   — was fabricating RANDOM candles
//   2. /api/market/orderbook — was fabricating RANDOM bids/asks
//   3. get_candles tool      — was a hard-coded stub
//   4. calculate_macd tool   — was a hard-coded stub
//   5. /api/portfolio/history — was a hard-coded empty array
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCandles, resolveOrderBook, normalizeTimeframe, clampLimit } from "../src/market/market-data-resolver.js";
import { PortfolioHistory } from "../src/state/portfolio-history.js";
import { MemoryExchangeProvider } from "../src/providers/memory-provider.js";
import { getCandlesTool, executeGetCandles, executeCalculateMACD, calculateMACDTool } from "../src/tools/finance-tools.js";
import { TypedEventBus } from "@finance/core";
import type { NormalizedKline, NormalizedOrderBook } from "../src/market/normalizer.js";

function kline(symbol: string, timeframe: string, price: number, ts: number): NormalizedKline {
  return {
    symbol,
    timeframe,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price * 1.005,
    volume: 10,
    closeTime: ts + 60_000,
    isClosed: true,
    tradesCount: 5,
    quoteVolume: 100,
    timestamp: ts,
    source: "binance",
  };
}

function book(symbol: string, ts: number): NormalizedOrderBook {
  return {
    symbol,
    bids: [{ price: 99, quantity: 1 }],
    asks: [{ price: 101, quantity: 2 }],
    lastUpdateId: 1,
    timestamp: ts,
    source: "binance",
  };
}

describe("market data resolver — real data, never fabricated", () => {
  it("prefers live websocket klines and reports the source", async () => {
    const now = Date.now();
    const liveState = {
      getKlines: () => [kline("BTCUSDT", "1m", 100, now - 60_000), kline("BTCUSDT", "1m", 101, now)],
      getOrderBook: () => undefined,
    };
    const res = await resolveCandles("BTCUSDT", "1m", 10, { liveState });
    expect(res.source).toBe("websocket");
    expect(res.synthetic).toBe(false);
    expect(res.candles).toHaveLength(2);
    expect(res.candles[1]!.close).toBeCloseTo(101 * 1.005);
  });

  it("falls back to exchange REST when no live klines exist", async () => {
    const exchange = {
      getKlines: async () => [kline("ETHUSDT", "5m", 200, Date.now())],
    };
    const res = await resolveCandles("ETHUSDT", "5m", 10, {
      liveState: { getKlines: () => [], getOrderBook: () => undefined },
      exchange,
    });
    expect(res.source).toBe("exchange");
    expect(res.synthetic).toBe(false);
    expect(res.candles).toHaveLength(1);
  });

  it("flags mock provider data as synthetic", async () => {
    const res = await resolveCandles("BTCUSDT", "1m", 5, {
      provider: new MemoryExchangeProvider(),
    });
    expect(res.source).toBe("mock");
    expect(res.synthetic).toBe(true);
    expect(res.candles.length).toBeGreaterThan(0);
  });

  it("returns an empty, honest result instead of random candles when nothing is available", async () => {
    const res = await resolveCandles("NOPE", "1m", 10, {});
    expect(res.source).toBe("none");
    expect(res.candles).toEqual([]);
    expect(res.synthetic).toBe(false);
    expect(res.note).toMatch(/No historical candle data/i);
  });

  it("resolves a real order book and never invents levels", async () => {
    const liveState = { getKlines: () => [], getOrderBook: () => book("BTCUSDT", Date.now()) };
    const res = await resolveOrderBook("BTCUSDT", 5, { liveState });
    expect(res.source).toBe("websocket");
    expect(res.synthetic).toBe(false);
    expect(res.bids[0]!.price).toBe(99);

    const empty = await resolveOrderBook("BTCUSDT", 5, {});
    expect(empty.source).toBe("none");
    expect(empty.bids).toEqual([]);
    expect(empty.asks).toEqual([]);
  });

  it("normalizes timeframes and clamps limits", () => {
    expect(normalizeTimeframe("bogus")).toBe("1m");
    expect(normalizeTimeframe("4H")).toBe("4h");
    expect(clampLimit(9999, 100, 500)).toBe(500);
    expect(clampLimit(-1, 100, 500)).toBe(100);
  });
});

describe("get_candles tool (was a stub)", () => {
  it("returns real candles through the provider", async () => {
    const provider = new MemoryExchangeProvider({ initialPrices: { BTCUSDT: 68000 } });
    const res = await executeGetCandles(provider, { symbol: "btcusdt", timeframe: "1h", limit: 3 });
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.timeframe).toBe("1h");
    expect(res.candles).toHaveLength(3);
    for (const c of res.candles) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.close).toBeGreaterThan(0);
    }
  });

  it("requires a symbol", async () => {
    const provider = new MemoryExchangeProvider();
    await expect(executeGetCandles(provider, { symbol: "" })).rejects.toThrow(/symbol is required/);
  });

  it("exposes a real tool definition (no TODO)", () => {
    const def = getCandlesTool();
    expect(def.id).toBe("get_candles");
    expect(def.description).not.toMatch(/TODO/);
  });
});

describe("calculate_macd tool (was a stub)", () => {
  it("computes a real MACD from the canonical implementation", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
    const res = executeCalculateMACD({ prices });
    expect(res.macd).not.toBeNull();
    expect(res.signal).not.toBeNull();
    expect(res.histogram).toBeCloseTo((res.macd as number) - (res.signal as number));
    expect(res.fast).toBe(12);
    expect(res.slow).toBe(26);
    expect(res.signalPeriod).toBe(9);
  });

  it("reports insufficient data honestly instead of a TODO note", () => {
    const res = executeCalculateMACD({ prices: [1, 2, 3] });
    expect(res.macd).toBeNull();
    expect(res.note).toMatch(/Insufficient data/);
    expect(res.note).not.toMatch(/TODO/);
  });

  it("rejects invalid input", () => {
    expect(() => executeCalculateMACD({ prices: [] })).toThrow(/prices/);
    expect(() => executeCalculateMACD({ prices: [1, "x"] })).toThrow(/finite/);
  });

  it("exposes a real tool definition (no TODO)", () => {
    expect(calculateMACDTool().id).toBe("calculate_macd");
  });
});

describe("portfolio history (was an empty stub)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "portfolio-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records snapshots from portfolio.updated events", async () => {
    const bus = new TypedEventBus();
    const history = new PortfolioHistory(bus, { path: join(dir, "history.json"), persist: false });
    history.start();

    bus.publish({
      type: "portfolio.updated",
      data: {
        cash: 1000,
        positions: { BTCUSDT: { qty: 1, avgPrice: 100, currentPrice: 120 } },
      },
    });

    const snapshots = history.getSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.cash).toBe(1000);
    expect(snapshots[0]!.totalValue).toBe(1120);
    history.stop();
  });

  it("persists history to disk and reloads it", () => {
    const path = join(dir, "history.json");
    const bus = new TypedEventBus();
    const history = new PortfolioHistory(bus, { path, persist: true, minIntervalMs: 0 });
    history.record({ cash: 500, positions: {} });

    const reloaded = new PortfolioHistory(undefined, { path, persist: true });
    reloaded.start();
    expect(reloaded.getSnapshots()).toHaveLength(1);
    expect(reloaded.getSnapshots()[0]!.cash).toBe(500);
    history.stop();
  });

  it("bounds the snapshot buffer", () => {
    const bus = new TypedEventBus();
    const history = new PortfolioHistory(bus, { path: join(dir, "h.json"), persist: false, maxSnapshots: 3 });
    for (let i = 0; i < 10; i++) history.record({ cash: i, positions: {} });
    expect(history.getSnapshots()).toHaveLength(3);
    expect(history.getLatest()!.cash).toBe(9);
    history.stop();
  });
});
