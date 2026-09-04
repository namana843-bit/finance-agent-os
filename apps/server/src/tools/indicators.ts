// ============================================================================
// Basic Indicators tools — pure calculations, no exchange dependency.
// Reuses apps/server/src/agents/quant/strategies.ts (sma/ema/rsi/macd/bollinger).
// Each indicator is a reusable ToolDefinition + execute function.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import { sma, ema, rsi, macd, bollingerBands } from "../agents/quant/strategies.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requirePrices(input: Record<string, unknown>): number[] {
  const prices = input.prices as unknown;
  if (!Array.isArray(prices) || prices.length === 0) throw new Error("prices (number[]) is required");
  const nums = prices.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error("prices must be finite numbers");
  return nums;
}

function optPeriod(input: Record<string, unknown>, def: number): number {
  const raw = input.period;
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("period must be a positive number");
  return Math.trunc(n);
}

// ---------------------------------------------------------------------------
// SMA
// ---------------------------------------------------------------------------

export function smaTool(): ToolDefinition {
  return {
    id: "calculate_sma",
    name: "Calculate SMA",
    description: "Calculate Simple Moving Average for a price series",
    inputSchema: {
      type: "object",
      properties: { prices: { type: "array" }, period: { type: "number", default: 20 } },
      required: ["prices"],
    },
    outputSchema: { type: "object", properties: { sma: { type: ["number", "null"] }, period: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeSMA(input: Record<string, unknown>): { sma: number | null; period: number } {
  const prices = requirePrices(input);
  const period = optPeriod(input, 20);
  return { sma: sma(prices, period), period };
}

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

export function emaTool(): ToolDefinition {
  return {
    id: "calculate_ema",
    name: "Calculate EMA",
    description: "Calculate Exponential Moving Average for a price series",
    inputSchema: {
      type: "object",
      properties: { prices: { type: "array" }, period: { type: "number", default: 20 } },
      required: ["prices"],
    },
    outputSchema: { type: "object", properties: { ema: { type: ["number", "null"] }, period: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeEMA(input: Record<string, unknown>): { ema: number | null; period: number } {
  const prices = requirePrices(input);
  const period = optPeriod(input, 20);
  return { ema: ema(prices, period), period };
}

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

export function rsiTool(): ToolDefinition {
  return {
    id: "calculate_rsi_indicator",
    name: "Calculate RSI (Indicators)",
    description: "Calculate Relative Strength Index (Wilder, 0-100)",
    inputSchema: {
      type: "object",
      properties: { prices: { type: "array" }, period: { type: "number", default: 14 } },
      required: ["prices"],
    },
    outputSchema: { type: "object", properties: { rsi: { type: ["number", "null"] }, period: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeRSIIndicator(input: Record<string, unknown>): { rsi: number | null; period: number } {
  const prices = requirePrices(input);
  const period = optPeriod(input, 14);
  return { rsi: rsi(prices, period), period };
}

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

export function macdTool(): ToolDefinition {
  return {
    id: "calculate_macd_indicator",
    name: "Calculate MACD (Indicators)",
    description: "Calculate MACD (fast EMA - slow EMA) + signal",
    inputSchema: {
      type: "object",
      properties: {
        prices: { type: "array" },
        fastPeriod: { type: "number", default: 12 },
        slowPeriod: { type: "number", default: 26 },
        signalPeriod: { type: "number", default: 9 },
      },
      required: ["prices"],
    },
    outputSchema: {
      type: "object",
      properties: { macd: { type: ["number", "null"] }, signal: { type: ["number", "null"] }, histogram: { type: ["number", "null"] } },
    },
    permissions: { required: false },
  };
}

export function executeMACDIndicator(
  input: Record<string, unknown>,
): { macd: number | null; signal: number | null; histogram: number | null } {
  const prices = requirePrices(input);
  const fastPeriod = input.fastPeriod !== undefined ? Math.trunc(Number(input.fastPeriod)) : 12;
  const slowPeriod = input.slowPeriod !== undefined ? Math.trunc(Number(input.slowPeriod)) : 26;
  const signalPeriod = input.signalPeriod !== undefined ? Math.trunc(Number(input.signalPeriod)) : 9;
  const res = macd(prices, fastPeriod, slowPeriod, signalPeriod);
  if (!res) return { macd: null, signal: null, histogram: null };
  return res;
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

export function bollingerBandsTool(): ToolDefinition {
  return {
    id: "calculate_bollinger_bands",
    name: "Calculate Bollinger Bands",
    description: "Calculate Bollinger Bands (SMA ± k*stdDev)",
    inputSchema: {
      type: "object",
      properties: { prices: { type: "array" }, period: { type: "number", default: 20 }, stdDev: { type: "number", default: 2 } },
      required: ["prices"],
    },
    outputSchema: {
      type: "object",
      properties: {
        middle: { type: ["number", "null"] },
        upper: { type: ["number", "null"] },
        lower: { type: ["number", "null"] },
        bandwidth: { type: ["number", "null"] },
        percentB: { type: ["number", "null"] },
      },
    },
    permissions: { required: false },
  };
}

export function executeBollingerBands(
  input: Record<string, unknown>,
): { middle: number | null; upper: number | null; lower: number | null; bandwidth: number | null; percentB: number | null } {
  const prices = requirePrices(input);
  const period = optPeriod(input, 20);
  const stdDev = input.stdDev !== undefined ? Number(input.stdDev) : 2;
  if (!Number.isFinite(stdDev) || stdDev <= 0) throw new Error("stdDev must be positive");
  const res = bollingerBands(prices, period, stdDev);
  if (!res) return { middle: null, upper: null, lower: null, bandwidth: null, percentB: null };
  return res;
}

// ---------------------------------------------------------------------------
// Generic dispatcher — one tool to rule them all (optional convenience)
// ---------------------------------------------------------------------------

export function indicatorTool(): ToolDefinition {
  return {
    id: "calculate_indicator",
    name: "Calculate Indicator",
    description: "Generic indicator dispatcher: sma | ema | rsi | macd | bollinger",
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string", enum: ["sma", "ema", "rsi", "macd", "bollinger"], description: "Indicator name" },
        prices: { type: "array" },
        period: { type: "number" },
        fastPeriod: { type: "number" },
        slowPeriod: { type: "number" },
        signalPeriod: { type: "number" },
        stdDev: { type: "number" },
      },
      required: ["indicator", "prices"],
    },
    outputSchema: { type: "object", properties: { result: { type: "object" }, indicator: { type: "string" } } },
    permissions: { required: false },
  };
}

export function executeIndicator(input: Record<string, unknown>): { indicator: string; result: unknown } {
  const indicator = String(input.indicator ?? "").toLowerCase().trim();
  if (!indicator) throw new Error("indicator is required (sma|ema|rsi|macd|bollinger)");
  switch (indicator) {
    case "sma":
      return { indicator, result: executeSMA(input) };
    case "ema":
      return { indicator, result: executeEMA(input) };
    case "rsi":
      return { indicator, result: executeRSIIndicator(input) };
    case "macd":
      return { indicator, result: executeMACDIndicator(input) };
    case "bollinger":
    case "bollinger_bands":
    case "bb":
      return { indicator, result: executeBollingerBands(input) };
    default:
      throw new Error(`Unknown indicator '${indicator}' (expected sma|ema|rsi|macd|bollinger)`);
  }
}
