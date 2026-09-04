// ============================================================================
// Finance Agent OS — Utility Tools Tests (validate-symbol, format-money, event-log)
// ============================================================================

import { describe, it, expect } from "vitest";
import { executeValidateSymbol } from "../src/tools/validateSymbol.js";
import { executeFormatMoney } from "../src/tools/formatMoney.js";
import { executeEventLog } from "../src/tools/eventLog.js";
import type { ToolContext } from "../src/tools/finance-tools.js";

describe("validateSymbol tool", () => {
  it("should accept valid symbols", () => {
    expect(executeValidateSymbol({ symbol: "BTCUSDT" })).toEqual({ symbol: "BTCUSDT", valid: true });
    expect(executeValidateSymbol({ symbol: "aapl" })).toEqual({ symbol: "AAPL", valid: true });
  });

  it("should reject malformed symbols", () => {
    expect(executeValidateSymbol({ symbol: "ab" }).valid).toBe(false);
    expect(executeValidateSymbol({ symbol: "TOOLONG SYMBOL!!" }).valid).toBe(false);
  });
});

describe("formatMoney tool", () => {
  it("should format with default USDT currency", () => {
    expect(executeFormatMoney({ amount: 125430.22 })).toEqual({ formatted: "125,430.22 USDT" });
  });

  it("should respect explicit currency", () => {
    expect(executeFormatMoney({ amount: 1000, currency: "USD" })).toEqual({ formatted: "1,000.00 USD" });
  });

  it("should throw for non-finite amounts", () => {
    expect(() => executeFormatMoney({ amount: NaN })).toThrow(/finite/);
  });
});

describe("eventLog tool", () => {
  it("should return recent events oldest-first shape", () => {
    const store = [
      { id: "1", type: "market:tick", data: null, timestamp: 100 },
      { id: "2", type: "signal:buy", data: null, timestamp: 200 },
    ];
    const bus = {
      getHistory: (filter?: { type?: string }, limit?: number) => {
        const filtered = filter?.type ? store.filter((e) => e.type === filter.type) : [...store];
        return filtered.slice(-(limit ?? 20));
      },
    };
    const ctx = { bus } as unknown as ToolContext;
    expect(executeEventLog(ctx, {})).toEqual({
      events: [
        { id: "1", type: "market:tick", timestamp: 100 },
        { id: "2", type: "signal:buy", timestamp: 200 },
      ],
    });
    expect(executeEventLog(ctx, { type: "signal:buy" }).events).toHaveLength(1);
  });
});
