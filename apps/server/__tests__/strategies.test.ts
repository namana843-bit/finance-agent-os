// ============================================================================
// Finance Agent OS — Strategy Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  StrategyRegistry,
  registerDefaultStrategies,
} from "../src/strategies/strategy-registry.js";
import { sma, ema, rsi, macd, bollingerBands } from "../src/agents/quant/strategies.js";

// ---------------------------------------------------------------------------
// Pure indicator functions
// ---------------------------------------------------------------------------

describe("SMA", () => {
  it("should compute SMA correctly", () => {
    const prices = [1, 2, 3, 4, 5];
    expect(sma(prices, 3)).toBe(4); // (3+4+5)/3 = 4
  });

  it("should return null if insufficient data", () => {
    expect(sma([1, 2], 5)).toBeNull();
  });

  it("should return null for empty array", () => {
    expect(sma([], 5)).toBeNull();
  });
});

describe("EMA", () => {
  it("should compute EMA correctly for simple series", () => {
    const prices = [10, 11, 12, 13, 14, 15];
    const result = ema(prices, 3);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
  });

  it("should return null for insufficient data", () => {
    expect(ema([1, 2], 5)).toBeNull();
  });
});

describe("RSI", () => {
  it("should return 100 for all-up series", () => {
    const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const result = rsi(prices, 14);
    expect(result).toBe(100);
  });

  it("should return near 0 for all-down series", () => {
    const prices = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const result = rsi(prices, 14);
    expect(result).toBe(0);
  });

  it("should return null for insufficient data", () => {
    expect(rsi([1, 2], 14)).toBeNull();
  });
});

describe("MACD", () => {
  it("should return null for short series", () => {
    const prices = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(macd(prices)).toBeNull();
  });

  it("should compute MACD for sufficient data", () => {
    // Generate enough data for MACD (needs at least 35 points)
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
    const result = macd(prices);
    expect(result).not.toBeNull();
    expect(typeof result!.macd).toBe("number");
    expect(typeof result!.signal).toBe("number");
    expect(typeof result!.histogram).toBe("number");
  });
});

describe("Bollinger Bands", () => {
  it("should compute Bollinger Bands", () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.5) * 5);
    const result = bollingerBands(prices, 20, 2);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeLessThan(result!.middle);
    expect(result!.middle).toBeLessThan(result!.upper);
    expect(result!.bandwidth).toBeGreaterThan(0);
  });

  it("should return null for insufficient data", () => {
    expect(bollingerBands([1, 2, 3], 20)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Strategy Registry
// ---------------------------------------------------------------------------

describe("StrategyRegistry", () => {
  it("should register default strategies", () => {
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    expect(registry.size()).toBeGreaterThanOrEqual(3);
  });

  it("should enable and disable strategies", () => {
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const first = registry.list()[0]!;
    expect(first.enabled).toBe(true);
    registry.disable(first.id);
    expect(registry.get(first.id)!.config.enabled).toBe(false);
    registry.enable(first.id);
    expect(registry.get(first.id)!.config.enabled).toBe(true);
  });

  it("should return only enabled strategies", () => {
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const all = registry.list();
    const enabled = registry.getEnabled();
    expect(enabled.length).toBeLessThanOrEqual(all.length);
  });

  it("should calculate signals from EMA crossover", () => {
    const registry = new StrategyRegistry();
    registerDefaultStrategies(registry);
    const emaStrategy = registry.get("ema-crossover");
    expect(emaStrategy).toBeDefined();

    // Rising prices — should produce a buy signal or hold
    const prices = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const result = emaStrategy!.calculate(prices);
    expect(["buy", "sell", "hold"]).toContain(result.side);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
