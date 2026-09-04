// ============================================================================
// Market Data Tools Tests — price / OHLCV / order book (provider-agnostic)
// ============================================================================

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "@finance/core";
import { MemoryExchangeProvider } from "../src/providers/memory-provider.js";
import { priceTool, executeGetPrice } from "../src/tools/price.js";
import { ohlcvTool, executeGetOHLCV } from "../src/tools/ohlcv.js";
import { orderBookTool, executeGetOrderBook } from "../src/tools/orderbook.js";
import { registerAllTools } from "../src/tools/finance-tools.js";
import { FinanceRuntime } from "@finance/core";

describe("price tool (exchange-agnostic)", () => {
  it("returns price for known symbol via MemoryProvider", async () => {
    const provider = new MemoryExchangeProvider({ initialPrices: { BTCUSDT: 68100 } });
    const res = await executeGetPrice(provider, { symbol: "BTCUSDT" });
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.price).toBe(68100);
    expect(res.source).toBe("memory");
  });

  it("normalizes symbol case and validates input", async () => {
    const provider = new MemoryExchangeProvider();
    const res = await executeGetPrice(provider, { symbol: "btcusdt" });
    expect(res.symbol).toBe("BTCUSDT");
    await expect(executeGetPrice(provider, { symbol: "" })).rejects.toThrow(/symbol is required/);
    await expect(executeGetPrice(provider, { symbol: "UNKNOWNPAIR" } as unknown as Record<string, unknown>)).rejects.toThrow(/No price data/);
  });

  it("exposes ToolDefinition with correct id", () => {
    expect(priceTool().id).toBe("get_price");
  });
});

describe("OHLCV tool", () => {
  it("returns requested number of candles with OHLCV shape", async () => {
    const provider = new MemoryExchangeProvider();
    const res = await executeGetOHLCV(provider, { symbol: "BTCUSDT", timeframe: "1h", limit: 5 });
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.timeframe).toBe("1h");
    expect(res.ohlcv).toHaveLength(5);
    for (const bar of res.ohlcv) {
      expect(bar.symbol).toBe("BTCUSDT");
      expect(bar.open).toBeGreaterThan(0);
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.close).toBeGreaterThan(0);
      expect(bar.closed).toBe(true);
    }
  });

  it("clamps limit 1..500 and defaults", async () => {
    const provider = new MemoryExchangeProvider();
    const res = await executeGetOHLCV(provider, { symbol: "ETHUSDT", limit: 0 });
    expect(res.ohlcv.length).toBeGreaterThanOrEqual(1);
    const big = await executeGetOHLCV(provider, { symbol: "ETHUSDT", limit: 9999 });
    expect(big.ohlcv.length).toBeLessThanOrEqual(500);
  });

  it("throws for missing symbol", async () => {
    const provider = new MemoryExchangeProvider();
    await expect(executeGetOHLCV(provider, { symbol: "" })).rejects.toThrow(/symbol is required/);
  });

  it("exposes ToolDefinition", () => {
    expect(ohlcvTool().id).toBe("get_ohlcv");
  });
});

describe("order book tool", () => {
  it("returns bids/asks with requested depth", async () => {
    const provider = new MemoryExchangeProvider({ initialPrices: { BTCUSDT: 70000 } });
    const res = await executeGetOrderBook(provider, { symbol: "BTCUSDT", depth: 5 });
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.bids).toHaveLength(5);
    expect(res.asks).toHaveLength(5);
    expect(res.bids[0]!.price).toBeLessThan(res.asks[0]!.price);
    // spread around mid 70000 (allow ~1% slippage from synthetic book)
    expect(res.bids[0]!.price).toBeGreaterThan(69000);
    expect(res.asks[0]!.price).toBeLessThan(71000);
  });

  it("clamps depth 1..100", async () => {
    const provider = new MemoryExchangeProvider();
    const res = await executeGetOrderBook(provider, { symbol: "BTCUSDT", depth: 200 });
    expect(res.bids.length).toBe(100);
  });

  it("exposes ToolDefinition", () => {
    expect(orderBookTool().id).toBe("get_order_book");
  });
});

describe("ToolRegistry integration — market data tools", () => {
  it("registerAllTools registers price/ohlcv/orderbook and they execute via registry", async () => {
    const runtime = new FinanceRuntime({ port: 0 });
    registerAllTools(runtime);
    const registry = runtime.getToolRegistry();

    expect(registry.has("get_price")).toBe(true);
    expect(registry.has("get_ohlcv")).toBe(true);
    expect(registry.has("get_order_book")).toBe(true);

    // Registry execute should work (memory provider has BTCUSDT by default)
    const price = await registry.execute("get_price", { symbol: "BTCUSDT" }) as { price: number };
    expect(price.price).toBeGreaterThan(0);

    const ohlcv = await registry.execute("get_ohlcv", { symbol: "BTCUSDT", limit: 3 }) as { ohlcv: unknown[] };
    expect(ohlcv.ohlcv).toHaveLength(3);

    const book = await registry.execute("get_order_book", { symbol: "BTCUSDT", depth: 3 }) as { bids: unknown[] };
    expect(book.bids).toHaveLength(3);
  });

  it("ToolRegistry isolates unknown tool errors", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("nope", {})).rejects.toThrow(/not found/);
  });
});
