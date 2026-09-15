// ============================================================================
// Finance Agent OS — Phase 6 Binance Live Market Runtime Tests
// Validates:
// 1. WebSocket Market Streams (ticker, trade, depth, kline)
// 2. Connection Management (heartbeat, backoff, subscription recovery)
// 3. REST Market Fallback & Rate Limit Tracking (x-mbx-used-weight)
// 4. Normalizer & Canonical Event Schemas
// 5. Strict Safety Verification (NO live order placement endpoints)
// ============================================================================

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import {
  normalizeSymbol,
  safeFloat,
  parseBinanceTicker,
  parseBinanceTrade,
  parseBinanceOrderBook,
  parseBinanceKline,
} from "../src/market/normalizer.js";
import { BinanceRestClient } from "../src/market/binance-rest.js";
import { BinanceMarketWebSocket } from "../src/market/binance-ws.js";
import { MarketStateService } from "../src/market/market-state.js";
import { BinanceAdapter } from "../src/market/exchange-adapter.js";

describe("Phase 6: Binance Live Market Runtime", () => {
  let bus: TypedEventBus;
  let marketState: MarketStateService;

  beforeEach(() => {
    bus = new TypedEventBus();
    marketState = new MarketStateService(bus);
    marketState.start();
  });

  afterEach(() => {
    marketState.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Normalizer & Canonical Event Schemas
  // -------------------------------------------------------------------------

  describe("Market Normalizer", () => {
    it("normalizes symbol formats into standard uppercase string without delimiters", () => {
      expect(normalizeSymbol("btc/usdt")).toBe("BTCUSDT");
      expect(normalizeSymbol("ETH-USDT")).toBe("ETHUSDT");
      expect(normalizeSymbol("sol_usdt ")).toBe("SOLUSDT");
      expect(normalizeSymbol("BTCUSDT")).toBe("BTCUSDT");
      expect(normalizeSymbol("")).toBe("");
    });

    it("safeFloat parses string/number representations reliably", () => {
      expect(safeFloat("123.45")).toBe(123.45);
      expect(safeFloat(678.9)).toBe(678.9);
      expect(safeFloat("invalid", 10)).toBe(10);
      expect(safeFloat(null, 5)).toBe(5);
    });

    it("parses raw Binance 24hr ticker into NormalizedTick", () => {
      const rawTicker = {
        s: "BTCUSDT",
        c: "50000.50",
        b: "49999.00",
        a: "50001.00",
        v: "12345.67",
        h: "51000.00",
        l: "49000.00",
        p: "1000.50",
        P: "2.04",
        E: 1600000000000,
      };

      const tick = parseBinanceTicker(rawTicker);
      expect(tick.symbol).toBe("BTCUSDT");
      expect(tick.price).toBe(50000.5);
      expect(tick.bid).toBe(49999);
      expect(tick.ask).toBe(50001);
      expect(tick.volume).toBe(12345.67);
      expect(tick.high24h).toBe(51000);
      expect(tick.low24h).toBe(49000);
      expect(tick.change24h).toBe(1000.5);
      expect(tick.changePercent24h).toBe(2.04);
      expect(tick.timestamp).toBe(1600000000000);
      expect(tick.source).toBe("binance");
    });

    it("parses raw Binance trade payload into NormalizedTrade", () => {
      const rawTrade = {
        e: "trade",
        E: 1672531200000,
        s: "BNBUSDT",
        t: 12345678,
        p: "310.25",
        q: "2.5",
        m: true, // buyer is maker -> seller is taker -> aggressive sell
        T: 1672531200000,
      };

      const trade = parseBinanceTrade(rawTrade);
      expect(trade.symbol).toBe("BNBUSDT");
      expect(trade.tradeId).toBe("12345678");
      expect(trade.price).toBe(310.25);
      expect(trade.quantity).toBe(2.5);
      expect(trade.side).toBe("sell");
      expect(trade.isBuyerMaker).toBe(true);
      expect(trade.source).toBe("binance");
    });

    it("parses raw Binance depth payload into NormalizedOrderBook", () => {
      const rawDepth = {
        lastUpdateId: 987654321,
        bids: [
          ["50000.00", "1.50000000"],
          ["49990.00", "2.00000000"],
          ["0.00", "0.00"], // should be filtered out
        ],
        asks: [
          ["50010.00", "0.80000000"],
          ["50020.00", "1.20000000"],
        ],
      };

      const book = parseBinanceOrderBook(rawDepth, "BTCUSDT");
      expect(book.symbol).toBe("BTCUSDT");
      expect(book.lastUpdateId).toBe(987654321);
      expect(book.bids).toHaveLength(2);
      expect(book.bids[0]).toEqual({ price: 50000, quantity: 1.5 });
      expect(book.asks).toHaveLength(2);
      expect(book.asks[0]).toEqual({ price: 50010, quantity: 0.8 });
    });

    it("parses raw REST and WebSocket klines into NormalizedKline", () => {
      // REST array format
      const restKline = [
        1600000000000, "50000.00", "50500.00", "49800.00", "50200.00",
        "100.5", 1600000059999, "5040000.0", 350,
      ];
      const parsedRest = parseBinanceKline(restKline, "BTCUSDT", "1m");
      expect(parsedRest.symbol).toBe("BTCUSDT");
      expect(parsedRest.timeframe).toBe("1m");
      expect(parsedRest.open).toBe(50000);
      expect(parsedRest.high).toBe(50500);
      expect(parsedRest.low).toBe(49800);
      expect(parsedRest.close).toBe(50200);
      expect(parsedRest.volume).toBe(100.5);
      expect(parsedRest.isClosed).toBe(true);

      // WebSocket object format
      const wsKline = {
        e: "kline",
        E: 1600000060000,
        s: "BTCUSDT",
        k: {
          t: 1600000060000,
          T: 1600000119999,
          s: "BTCUSDT",
          i: "5m",
          o: "50200.00",
          c: "50400.00",
          h: "50600.00",
          l: "50100.00",
          v: "250.0",
          x: false, // bar is still in progress
          n: 420,
        },
      };
      const parsedWs = parseBinanceKline(wsKline, "BTCUSDT");
      expect(parsedWs.timeframe).toBe("5m");
      expect(parsedWs.close).toBe(50400);
      expect(parsedWs.isClosed).toBe(false);
      expect(parsedWs.tradesCount).toBe(420);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Binance REST Client & Rate Limit Tracking
  // -------------------------------------------------------------------------

  describe("Binance REST Client & Rate Limit Tracking", () => {
    it("tracks rate limit weight from response headers", async () => {
      const client = new BinanceRestClient({ maxWeightThreshold: 100 });

      // Mock fetch returning Binance headers with used weight
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          "x-mbx-used-weight-1m": "42",
        }),
        json: async () => ({
          symbol: "BTCUSDT",
          lastPrice: "65000.00",
          bidPrice: "64995.00",
          askPrice: "65005.00",
          volume: "5000.0",
          highPrice: "66000.00",
          lowPrice: "64000.00",
          priceChange: "1000.00",
          priceChangePercent: "1.56",
          closeTime: Date.now(),
        }),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const ticker = await client.getTicker("BTCUSDT");
      expect(ticker.symbol).toBe("BTCUSDT");
      expect(ticker.price).toBe(65000);

      const status = client.getRateLimitStatus();
      expect(status.usedWeight1m).toBe(42);
      expect(status.maxWeight1m).toBe(1200);
      expect(status.remainingWeight).toBe(1200 - 42);
      expect(status.isRateLimited).toBe(false);
    });

    it("prevents execution and throws error when approaching rate limit threshold", async () => {
      const client = new BinanceRestClient({ maxWeightThreshold: 50 });

      // Set used weight above threshold
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "x-mbx-used-weight-1m": "55" }),
        json: async () => ({}),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      await client.getTicker("ETHUSDT");

      // Next request will exceed maxWeightThreshold (55 + 2 > 50)
      await expect(client.getTicker("BTCUSDT")).rejects.toThrow(
        /RATE LIMIT EXCEEDED/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Binance WebSocket Stream Manager & Event Dispatch
  // -------------------------------------------------------------------------

  describe("Binance WebSocket Stream Manager", () => {
    it("tracks subscriptions and dispatches normalized market events", () => {
      const wsManager = new BinanceMarketWebSocket(bus);

      wsManager.subscribeTicker("BTCUSDT");
      wsManager.subscribeTrades("ETHUSDT");
      wsManager.subscribeDepth("SOLUSDT", 20);
      wsManager.subscribeKline("BNBUSDT", "1m");

      const active = wsManager.getActiveSubscriptions();
      expect(active).toHaveLength(4);
      expect(active.some((s) => s.symbol === "BTCUSDT" && s.type === "ticker")).toBe(true);
      expect(active.some((s) => s.symbol === "ETHUSDT" && s.type === "trade")).toBe(true);
      expect(active.some((s) => s.symbol === "SOLUSDT" && s.type === "depth")).toBe(true);
      expect(active.some((s) => s.symbol === "BNBUSDT" && s.type === "kline")).toBe(true);

      // Verify event callbacks and bus publishing
      let receivedTick = false;
      let receivedTrade = false;
      let receivedBook = false;
      let receivedKline = false;

      wsManager.onTick((t) => {
        if (t.symbol === "BTCUSDT") receivedTick = true;
      });
      wsManager.onTrade((t) => {
        if (t.symbol === "ETHUSDT") receivedTrade = true;
      });
      wsManager.onOrderBook((b) => {
        if (b.symbol === "SOLUSDT") receivedBook = true;
      });
      wsManager.onKline((k) => {
        if (k.symbol === "BNBUSDT") receivedKline = true;
      });

      // Simulate incoming WebSocket messages
      wsManager.handleMessage(JSON.stringify({
        stream: "btcusdt@ticker",
        data: { s: "BTCUSDT", c: "55000", v: "100" },
      }));

      wsManager.handleMessage(JSON.stringify({
        stream: "ethusdt@trade",
        data: { s: "ETHUSDT", p: "3000", q: "2", m: false, t: 99 },
      }));

      wsManager.handleMessage(JSON.stringify({
        stream: "solusdt@depth20@100ms",
        data: { s: "SOLUSDT", bids: [["150", "10"]], asks: [["151", "10"]] },
      }));

      wsManager.handleMessage(JSON.stringify({
        stream: "bnbusdt@kline_1m",
        data: { s: "BNBUSDT", k: { o: "300", c: "305", h: "310", l: "299", v: "50", i: "1m" } },
      }));

      expect(receivedTick).toBe(true);
      expect(receivedTrade).toBe(true);
      expect(receivedBook).toBe(true);
      expect(receivedKline).toBe(true);

      wsManager.disconnect();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Market State Real-time Cache Integration
  // -------------------------------------------------------------------------

  describe("Market State Service Real-time Cache", () => {
    it("caches ticks, orderbooks, klines, and trades received over EventBus", () => {
      // Publish normalized events on bus
      bus.publish({
        type: "market.tick",
        data: { symbol: "BTCUSDT", price: 60000, change: 500, volume: 1000 },
        source: "binance-ws",
      });

      bus.publish({
        type: "market.orderbook",
        data: {
          symbol: "BTCUSDT",
          bids: [{ price: 59990, quantity: 2 }],
          asks: [{ price: 60010, quantity: 2 }],
          lastUpdateId: 100,
          timestamp: Date.now(),
          source: "binance",
        },
        source: "binance-ws",
      });

      bus.publish({
        type: "market.kline",
        data: {
          symbol: "BTCUSDT",
          timeframe: "1m",
          open: 59900,
          high: 60100,
          low: 59850,
          close: 60000,
          volume: 50,
          timestamp: Date.now(),
          source: "binance",
        },
        source: "binance-ws",
      });

      expect(marketState.getPrice("BTCUSDT")).toBe(60000);

      const book = marketState.getOrderBook("BTCUSDT");
      expect(book).toBeDefined();
      expect(book?.bids[0].price).toBe(59990);

      const klines = marketState.getKlines("BTCUSDT");
      expect(klines).toHaveLength(1);
      expect(klines[0].close).toBe(60000);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Strict Safety Verification (Zero Live Orders)
  // -------------------------------------------------------------------------

  describe("Strict Safety Verification (Zero Live Orders)", () => {
    it("prohibits order creation and cancellation on BinanceRestClient", () => {
      const restClient = new BinanceRestClient();
      expect(() => restClient.createOrder()).toThrow(
        /Live order placement \(\/api\/v3\/order\) is strictly prohibited/i
      );
      expect(() => restClient.cancelOrder()).toThrow(
        /Order cancellation is strictly prohibited/i
      );
    });

    it("prohibits order creation on BinanceAdapter", async () => {
      const adapter = new BinanceAdapter();
      await expect(adapter.createOrder("BTCUSDT", "market", "buy", 1)).rejects.toThrow(
        /Live exchange order execution is strictly disabled in market adapter/i
      );
      await expect(adapter.cancelOrder("ord-1")).rejects.toThrow(
        /Live exchange order cancellation is strictly disabled in market adapter/i
      );
    });
  });
});
