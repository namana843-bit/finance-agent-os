// ============================================================================
// Portfolio/Balance/Positions + Basic Indicators Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { MemoryExchangeProvider } from "../src/providers/memory-provider.js";
import {
  balanceTool,
  executeGetBalance,
  positionsTool,
  executeGetPositions,
  portfolioTool,
  executeGetPortfolioSnapshot,
} from "../src/tools/portfolio.js";
import {
  smaTool,
  executeSMA,
  emaTool,
  executeEMA,
  rsiTool,
  executeRSIIndicator,
  macdTool,
  executeMACDIndicator,
  bollingerBandsTool,
  executeBollingerBands,
  indicatorTool,
  executeIndicator,
} from "../src/tools/indicators.js";
import { FinanceRuntime } from "@finance/core";
import { registerAllTools } from "../src/tools/finance-tools.js";

// ---------------------------------------------------------------------------
// Portfolio / Balance / Positions (exchange-agnostic via PortfolioProvider)
// ---------------------------------------------------------------------------

describe("balance tool", () => {
  it("returns all balances and filters by asset", async () => {
    const provider = new MemoryExchangeProvider({ initialCash: 50000 });
    const all = await executeGetBalance(provider, {});
    expect(all.balances.USDT).toBeDefined();
    expect(all.balances.USDT!.free).toBe(50000);

    const filtered = await executeGetBalance(provider, { asset: "usdt" });
    expect(Object.keys(filtered.balances)).toEqual(["USDT"]);

    const missing = await executeGetBalance(provider, { asset: "BTC" });
    expect(missing.balances).toEqual({});
  });

  it("exposes ToolDefinition", () => {
    expect(balanceTool().id).toBe("get_balance");
  });
});

describe("positions tool", () => {
  it("returns positions and filters by symbol", async () => {
    const provider = new MemoryExchangeProvider();
    provider.portfolioProvider.setPosition({
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0.5,
      entryPrice: 68000,
      markPrice: 69000,
      unrealizedPnl: 500,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    provider.portfolioProvider.setPosition({
      symbol: "ETHUSDT",
      side: "long",
      quantity: 2,
      entryPrice: 3400,
      markPrice: 3450,
      unrealizedPnl: 100,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });

    const all = await executeGetPositions(provider, {});
    expect(all.positions).toHaveLength(2);

    const filtered = await executeGetPositions(provider, { symbol: "btcusdt" });
    expect(filtered.positions).toHaveLength(1);
    expect(filtered.positions[0]!.symbol).toBe("BTCUSDT");
  });

  it("exposes ToolDefinition", () => {
    expect(positionsTool().id).toBe("get_positions");
  });
});

describe("portfolio snapshot tool", () => {
  it("returns cash, equity, PnL shape", async () => {
    const provider = new MemoryExchangeProvider({ initialCash: 100000 });
    provider.portfolioProvider.setPosition({
      symbol: "BTCUSDT",
      side: "long",
      quantity: 1,
      entryPrice: 68000,
      markPrice: 70000,
      unrealizedPnl: 2000,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    const snap = await executeGetPortfolioSnapshot(provider, {});
    expect(snap.cash).toBe(100000);
    expect(snap.equity).toBeGreaterThan(100000);
    expect(snap.positions).toHaveLength(1);
    expect(snap.unrealizedPnl).toBe(2000);
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it("exposes ToolDefinition", () => {
    expect(portfolioTool().id).toBe("get_portfolio_snapshot");
  });
});

describe("ToolRegistry integration — portfolio tools", () => {
  it("registers balance/positions/portfolio_snapshot and executes via registry", async () => {
    const runtime = new FinanceRuntime({ port: 0 });
    registerAllTools(runtime);
    const r = runtime.getToolRegistry();
    expect(r.has("get_balance")).toBe(true);
    expect(r.has("get_positions")).toBe(true);
    expect(r.has("get_portfolio_snapshot")).toBe(true);

    const bal = await r.execute("get_balance", {}) as { balances: Record<string, { free: number }> };
    expect(bal.balances.USDT).toBeDefined();

    const pos = await r.execute("get_positions", {}) as { positions: unknown[] };
    expect(Array.isArray(pos.positions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Basic Indicators — SMA / EMA / RSI / MACD / Bollinger / generic dispatcher
// ---------------------------------------------------------------------------

const rising = Array.from({ length: 50 }, (_, i) => 100 + i * 2); // 100,102,...,198 (50 > 35 needed for MACD)
const falling = Array.from({ length: 50 }, (_, i) => 198 - i * 2);
const flat = Array(50).fill(100);

describe("SMA tool", () => {
  it("calculates SMA and returns null for insufficient data", () => {
    expect(executeSMA({ prices: [1, 2, 3, 4, 5], period: 5 }).sma).toBe(3);
    expect(executeSMA({ prices: [1, 2], period: 5 }).sma).toBeNull();
  });
  it("throws for missing/invalid prices", () => {
    expect(() => executeSMA({ prices: [] as unknown as number[] })).toThrow(/prices/);
  });
  it("exposes ToolDefinition", () => {
    expect(smaTool().id).toBe("calculate_sma");
  });
});

describe("EMA tool", () => {
  it("calculates EMA", () => {
    const { ema } = executeEMA({ prices: rising, period: 10 });
    expect(ema).not.toBeNull();
    expect(ema!).toBeGreaterThan(100);
  });
  it("exposes ToolDefinition", () => {
    expect(emaTool().id).toBe("calculate_ema");
  });
});

describe("RSI indicator tool", () => {
  it("RSI ~100 for strong uptrend, ~0 for downtrend, null for insufficient data", () => {
    const up = executeRSIIndicator({ prices: rising, period: 14 });
    expect(up.rsi).not.toBeNull();
    expect(up.rsi!).toBeGreaterThan(70);

    const down = executeRSIIndicator({ prices: falling, period: 14 });
    expect(down.rsi!).toBeLessThan(30);

    expect(executeRSIIndicator({ prices: [1, 2], period: 14 }).rsi).toBeNull();
  });
  it("exposes ToolDefinition", () => {
    expect(rsiTool().id).toBe("calculate_rsi_indicator");
  });
});

describe("MACD indicator tool", () => {
  it("computes macd/signal/histogram and null for short series", () => {
    const res = executeMACDIndicator({ prices: rising });
    expect(res.macd).not.toBeNull();
    expect(res.signal).not.toBeNull();
    expect(res.histogram).not.toBeNull();

    const short = executeMACDIndicator({ prices: [1, 2, 3] });
    expect(short.macd).toBeNull();
  });
  it("exposes ToolDefinition", () => {
    expect(macdTool().id).toBe("calculate_macd_indicator");
  });
});

describe("Bollinger Bands tool", () => {
  it("computes bands with middle ~ SMA and upper > lower", () => {
    const res = executeBollingerBands({ prices: rising, period: 20, stdDev: 2 });
    expect(res.middle).not.toBeNull();
    expect(res.upper!).toBeGreaterThan(res.middle!);
    expect(res.lower!).toBeLessThan(res.middle!);
    expect(res.bandwidth).not.toBeNull();
    expect(res.percentB).not.toBeNull();
  });

  it("flat series yields zero bandwidth", () => {
    const res = executeBollingerBands({ prices: flat, period: 20 });
    expect(res.middle).toBe(100);
    expect(res.bandwidth).toBe(0);
  });

  it("null for insufficient data", () => {
    expect(executeBollingerBands({ prices: [1, 2], period: 20 }).middle).toBeNull();
  });

  it("exposes ToolDefinition", () => {
    expect(bollingerBandsTool().id).toBe("calculate_bollinger_bands");
  });
});

describe("generic indicator dispatcher", () => {
  it("dispatches sma/ema/rsi/macd/bollinger", () => {
    expect(executeIndicator({ indicator: "sma", prices: rising, period: 5 }).indicator).toBe("sma");
    expect(executeIndicator({ indicator: "ema", prices: rising, period: 5 }).indicator).toBe("ema");
    expect(executeIndicator({ indicator: "rsi", prices: rising, period: 14 }).indicator).toBe("rsi");
    expect(executeIndicator({ indicator: "macd", prices: rising }).indicator).toBe("macd");
    expect(executeIndicator({ indicator: "bollinger", prices: rising, period: 20 }).indicator).toBe("bollinger");
    expect(executeIndicator({ indicator: "BB", prices: rising, period: 20 }).indicator).toBe("bb");
  });

  it("throws for unknown indicator", () => {
    expect(() => executeIndicator({ indicator: "unknown", prices: rising })).toThrow(/Unknown indicator/);
  });

  it("exposes ToolDefinition", () => {
    expect(indicatorTool().id).toBe("calculate_indicator");
  });
});

describe("ToolRegistry integration — indicators", () => {
  it("all indicator tools are registered and executable via registry", async () => {
    const rt = new FinanceRuntime({ port: 0 });
    registerAllTools(rt);
    const reg = rt.getToolRegistry();
    for (const id of ["calculate_sma", "calculate_ema", "calculate_rsi_indicator", "calculate_macd_indicator", "calculate_bollinger_bands", "calculate_indicator"]) {
      expect(reg.has(id)).toBe(true);
    }
    const sma = await reg.execute("calculate_sma", { prices: rising, period: 5 }) as { sma: number | null };
    expect(sma.sma).not.toBeNull();
    const rsi = await reg.execute("calculate_rsi_indicator", { prices: rising, period: 14 }) as { rsi: number | null };
    expect(rsi.rsi).not.toBeNull();
  });
});

describe("exchange-specific separation", () => {
  it("tools do not import BinanceAdapter (provider boundary)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Resolve relative to repo root regardless of cwd (vitest runs with cwd=apps/server)
    const here = dirname(fileURLToPath(import.meta.url)); // apps/server/__tests__
    const repoRoot = resolve(here, "../../..");
    const files = [
      "apps/server/src/tools/price.ts",
      "apps/server/src/tools/ohlcv.ts",
      "apps/server/src/tools/orderbook.ts",
      "apps/server/src/tools/portfolio.ts",
      "apps/server/src/tools/indicators.ts",
    ];
    for (const f of files) {
      const content = await readFile(resolve(repoRoot, f), "utf8");
      expect(content).not.toMatch(/BinanceAdapter/);
      expect(content).not.toMatch(/from.*binance/i);
    }
    const binanceProv = await readFile(resolve(repoRoot, "apps/server/src/providers/binance-provider.ts"), "utf8");
    expect(binanceProv).toMatch(/BinanceAdapter/);
  });
});
