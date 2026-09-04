// ============================================================================
// Strategy Lab — Modular Strategy Factory
// Each builder is independent; new strategies are added by adding a builder
// and registering it in LAB_BUILDERS. Reuses StrategyRegistry concepts but
// keeps lab strategies namespaced as `lab:<ideaId>:<kind>`.
// ============================================================================

import type { StrategyInstance, StrategyResult } from "../strategies/strategy-registry.js";
import type { StrategyIdea, LabStrategyKind } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — same indicator math as strategy-registry.ts (kept local so factory
// is self-contained and strategies remain modular / copy-pastable)
// ---------------------------------------------------------------------------

function computeEMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i]! * k + ema * (1 - k);
  return ema;
}

function computeRSI(prices: number[], period: number): number | null {
  if (prices.length <= period) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeMACD(prices: number[]): { macd: number; signal: number; histogram: number } | null {
  if (prices.length < 35) return null;
  const fastK = 2 / 13; const slowK = 2 / 27; const sigK = 2 / 10;
  let fastEMA = prices.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let slowEMA = prices.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  const macdLine: number[] = [];
  for (let i = 12; i < 26; i++) fastEMA = prices[i]! * fastK + fastEMA * (1 - fastK);
  for (let i = 26; i < prices.length; i++) {
    fastEMA = prices[i]! * fastK + fastEMA * (1 - fastK);
    slowEMA = prices[i]! * slowK + slowEMA * (1 - slowK);
    macdLine.push(fastEMA - slowEMA);
  }
  if (macdLine.length < 9) return null;
  let signalEMA = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) signalEMA = macdLine[i]! * sigK + signalEMA * (1 - sigK);
  const cur = macdLine[macdLine.length - 1]!;
  return { macd: cur, signal: signalEMA, histogram: cur - signalEMA };
}

// ---------------------------------------------------------------------------
// Modular builders — each is a self-contained strategy definition
// ---------------------------------------------------------------------------

type Builder = (idea: StrategyIdea, id: string) => StrategyInstance;

const emaBuilder: Builder = (idea, id) => {
  const fastPeriod = (idea.parameters.fastPeriod as number) ?? (idea.parameters.fast as number) ?? 12;
  const slowPeriod = (idea.parameters.slowPeriod as number) ?? (idea.parameters.slow as number) ?? 26;
  return {
    config: { id, name: `Lab EMA ${fastPeriod}/${slowPeriod}`, version: "1.0.0", description: `Lab EMA crossover fast=${fastPeriod} slow=${slowPeriod}`, enabled: true, timeframe: idea.timeframe, parameters: { fastPeriod, slowPeriod, ideaId: idea.id } },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < slowPeriod + 5) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data" };
      const fastEMA = computeEMA(prices, fastPeriod);
      const slowEMA = computeEMA(prices, slowPeriod);
      const prevFast = computeEMA(prices.slice(0, -1), fastPeriod);
      const prevSlow = computeEMA(prices.slice(0, -1), slowPeriod);
      if (fastEMA === null || slowEMA === null || prevFast === null || prevSlow === null) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Cannot compute EMA" };
      const up = prevFast <= prevSlow && fastEMA > slowEMA;
      const down = prevFast >= prevSlow && fastEMA < slowEMA;
      if (up) return { side: "buy", confidence: 0.7, indicators: { fastEMA, slowEMA }, reasoning: `EMA crossed up ${fastEMA.toFixed(2)}>${slowEMA.toFixed(2)}` };
      if (down) return { side: "sell", confidence: 0.7, indicators: { fastEMA, slowEMA }, reasoning: `EMA crossed down ${fastEMA.toFixed(2)}<${slowEMA.toFixed(2)}` };
      return { side: "hold", confidence: 0.5, indicators: { fastEMA, slowEMA }, reasoning: fastEMA > slowEMA ? "Fast above slow" : "Fast below slow" };
    },
  };
};

const rsiBuilder: Builder = (idea, id) => {
  const period = (idea.parameters.period as number) ?? 14;
  const oversold = (idea.parameters.oversold as number) ?? 30;
  const overbought = (idea.parameters.overbought as number) ?? 70;
  return {
    config: { id, name: `Lab RSI ${period}`, version: "1.0.0", description: `Lab RSI period=${period} OB=${overbought} OS=${oversold}`, enabled: true, timeframe: idea.timeframe, parameters: { period, oversold, overbought, ideaId: idea.id } },
    calculate(prices: number[]): StrategyResult {
      if (prices.length <= period + 1) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data for RSI" };
      const r = computeRSI(prices, period); const pr = computeRSI(prices.slice(0, -1), period);
      if (r === null || pr === null) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Cannot compute RSI" };
      if (pr <= oversold && r > oversold) return { side: "buy", confidence: 0.65, indicators: { rsi: r }, reasoning: `RSI crossed above OS ${r.toFixed(1)}>${oversold}` };
      if (pr >= overbought && r < overbought) return { side: "sell", confidence: 0.65, indicators: { rsi: r }, reasoning: `RSI crossed below OB ${r.toFixed(1)}<${overbought}` };
      if (r < oversold) return { side: "buy", confidence: 0.55, indicators: { rsi: r }, reasoning: `RSI oversold ${r.toFixed(1)}` };
      if (r > overbought) return { side: "sell", confidence: 0.55, indicators: { rsi: r }, reasoning: `RSI overbought ${r.toFixed(1)}` };
      return { side: "hold", confidence: 0.5, indicators: { rsi: r }, reasoning: `RSI neutral ${r.toFixed(1)}` };
    },
  };
};

const macdBuilder: Builder = (idea, id) => {
  return {
    config: { id, name: "Lab MACD", version: "1.0.0", description: "Lab MACD crossover", enabled: true, timeframe: idea.timeframe, parameters: { ideaId: idea.id } },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < 35) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data for MACD" };
      const cur = computeMACD(prices); const prev = computeMACD(prices.slice(0, -1));
      if (!cur || !prev) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Cannot compute MACD" };
      if (prev.macd <= prev.signal && cur.macd > cur.signal) return { side: "buy", confidence: 0.7, indicators: cur as unknown as Record<string, unknown>, reasoning: `MACD bullish ${cur.macd.toFixed(2)}>${cur.signal.toFixed(2)}` };
      if (prev.macd >= prev.signal && cur.macd < cur.signal) return { side: "sell", confidence: 0.7, indicators: cur as unknown as Record<string, unknown>, reasoning: `MACD bearish ${cur.macd.toFixed(2)}<${cur.signal.toFixed(2)}` };
      return { side: "hold", confidence: 0.5, indicators: cur as unknown as Record<string, unknown>, reasoning: "No MACD crossover" };
    },
  };
};

const momentumBuilder: Builder = (idea, id) => {
  const period = (idea.parameters.period as number) ?? 20;
  return {
    config: { id, name: `Lab Momentum ${period}`, version: "1.0.0", description: `Lab momentum period=${period}`, enabled: true, timeframe: idea.timeframe, parameters: { period, ideaId: idea.id } },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < period + 1) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data" };
      const cur = prices[prices.length - 1]!; const past = prices[prices.length - 1 - period]!;
      const mom = ((cur - past) / past) * 100; const thr = 2;
      if (mom > thr) return { side: "buy", confidence: Math.min(0.8, 0.5 + mom / 20), indicators: { momentum: mom }, reasoning: `Positive momentum ${mom.toFixed(2)}%` };
      if (mom < -thr) return { side: "sell", confidence: Math.min(0.8, 0.5 + Math.abs(mom) / 20), indicators: { momentum: mom }, reasoning: `Negative momentum ${mom.toFixed(2)}%` };
      return { side: "hold", confidence: 0.5, indicators: { momentum: mom }, reasoning: `Neutral momentum ${mom.toFixed(2)}%` };
    },
  };
};

// ---------------------------------------------------------------------------
// Registry of builders — add new modular strategies here
// ---------------------------------------------------------------------------

export const LAB_BUILDERS: Record<string, Builder> = {
  "ema-crossover": emaBuilder,
  ema: emaBuilder,
  "rsi-reversal": rsiBuilder,
  rsi: rsiBuilder,
  "macd-crossover": macdBuilder,
  macd: macdBuilder,
  momentum: momentumBuilder,
};

export function getSupportedKinds(): string[] {
  return [...new Set(Object.keys(LAB_BUILDERS))];
}

export function isSupportedKind(kind: string): boolean {
  return kind in LAB_BUILDERS;
}

/**
 * Create a modular StrategyInstance from a StrategyIdea.
 * Namespaced id: `lab:<ideaId>:<kind>` — keeps lab strategies isolated
 * from the global defaults (ema-crossover, rsi-reversal, etc.).
 */
export function createStrategyFromIdea(idea: StrategyIdea): StrategyInstance {
  const builder = LAB_BUILDERS[idea.strategyKind];
  if (!builder) throw new Error(`Unsupported strategy kind '${idea.strategyKind}'. Supported: ${getSupportedKinds().join(", ")}`);
  const id = `lab:${idea.id}:${idea.strategyKind}`;
  return builder(idea, id);
}

/**
 * Create an ephemeral lab strategy without an idea (for tests / ad-hoc).
 */
export function defineLabStrategy(
  kind: LabStrategyKind,
  params: { id?: string; timeframe?: string; parameters?: Record<string, unknown> } = {},
): StrategyInstance {
  const idea: StrategyIdea = {
    id: params.id ?? `adhoc-${Date.now()}`,
    rawIdea: `ad-hoc ${kind}`,
    symbol: "BTCUSDT",
    timeframe: params.timeframe ?? "1h",
    strategyKind: kind,
    parameters: params.parameters ?? {},
    createdAt: Date.now(),
  };
  const builder = LAB_BUILDERS[kind];
  if (!builder) throw new Error(`Unsupported kind '${kind}'`);
  const sid = params.id ? `lab:${params.id}:${kind}` : `lab:adhoc:${kind}:${Date.now()}`;
  return builder(idea, sid);
}
