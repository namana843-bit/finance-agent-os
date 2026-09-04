// ============================================================================
// Finance Agent OS — Finance Tools Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { executeCalculateRSI, executeCalculatePositionSize } from "../src/tools/finance-tools.js";

describe("calculateRSI tool", () => {
  it("should calculate RSI for valid price series", () => {
    const prices = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
    const result = executeCalculateRSI({ prices, period: 14 });
    expect(result.rsi).not.toBeNull();
    expect(result.rsi).toBeGreaterThanOrEqual(0);
    expect(result.rsi).toBeLessThanOrEqual(100);
    expect(result.period).toBe(14);
  });

  it("should return null RSI for insufficient data", () => {
    const result = executeCalculateRSI({ prices: [1, 2, 3], period: 14 });
    expect(result.rsi).toBeNull();
  });
});

describe("calculatePositionSize tool", () => {
  it("should calculate position size correctly", () => {
    const result = executeCalculatePositionSize({ cash: 100_000, price: 68_000, riskPercent: 0.01 });
    expect(result.qty).toBeGreaterThan(0);
    expect(result.notional).toBeGreaterThan(0);
    expect(result.riskAmount).toBe(1000); // 1% of 100k
  });

  it("should return 0 for invalid inputs", () => {
    const result = executeCalculatePositionSize({ cash: 0, price: 68000 });
    expect(result.qty).toBe(0);
    expect(result.notional).toBe(0);
  });

  it("should use default 1% risk", () => {
    const result = executeCalculatePositionSize({ cash: 100_000, price: 100 });
    expect(result.riskAmount).toBe(1000);
  });
});
