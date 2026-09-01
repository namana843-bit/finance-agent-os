// ============================================================================
// Finance Agent OS — Strategy Registry
// Phase 9: Pluggable strategy system
// ============================================================================

import type { StrategyConfig } from "@finance/shared";

export interface StrategyResult {
  side: "buy" | "sell" | "hold";
  confidence: number;
  indicators: Record<string, unknown>;
  reasoning: string;
}

export interface StrategyInstance {
  config: StrategyConfig;
  calculate(prices: number[]): StrategyResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeEMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return ema;
}

function computeRSI(prices: number[], period: number): number | null {
  if (prices.length <= period) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
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
  const fastK = 2 / 13;
  const slowK = 2 / 27;
  const sigK = 2 / 10;
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
  for (let i = 9; i < macdLine.length; i++) {
    signalEMA = macdLine[i]! * sigK + signalEMA * (1 - sigK);
  }
  const currentMACD = macdLine[macdLine.length - 1]!;
  return { macd: currentMACD, signal: signalEMA, histogram: currentMACD - signalEMA };
}

// ---------------------------------------------------------------------------
// EMA Crossover Strategy
// ---------------------------------------------------------------------------

function createEMACrossoverStrategy(): StrategyInstance {
  const fastPeriod = 12;
  const slowPeriod = 26;
  return {
    config: {
      id: "ema-crossover",
      name: "EMA Crossover",
      version: "1.0.0",
      description: "Buy when fast EMA crosses above slow EMA, sell when below",
      enabled: true,
      timeframe: "tick",
      parameters: { fastPeriod, slowPeriod },
    },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < slowPeriod + 5) {
        return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data" };
      }
      const fastEMA = computeEMA(prices, fastPeriod);
      const slowEMA = computeEMA(prices, slowPeriod);
      const prevFast = computeEMA(prices.slice(0, -1), fastPeriod);
      const prevSlow = computeEMA(prices.slice(0, -1), slowPeriod);
      if (fastEMA === null || slowEMA === null || prevFast === null || prevSlow === null) {
        return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data for EMA" };
      }
      const crossedUp = prevFast <= prevSlow && fastEMA > slowEMA;
      const crossedDown = prevFast >= prevSlow && fastEMA < slowEMA;
      if (crossedUp) return { side: "buy", confidence: 0.7, indicators: { fastEMA, slowEMA }, reasoning: `EMA crossed up: ${fastEMA.toFixed(2)} > ${slowEMA.toFixed(2)}` };
      if (crossedDown) return { side: "sell", confidence: 0.7, indicators: { fastEMA, slowEMA }, reasoning: `EMA crossed down: ${fastEMA.toFixed(2)} < ${slowEMA.toFixed(2)}` };
      return { side: "hold", confidence: 0.5, indicators: { fastEMA, slowEMA }, reasoning: fastEMA > slowEMA ? "Fast above slow (no crossover)" : "Fast below slow (no crossover)" };
    },
  };
}

// ---------------------------------------------------------------------------
// RSI Strategy
// ---------------------------------------------------------------------------

function createRSIStrategy(period = 14, oversold = 30, overbought = 70): StrategyInstance {
  return {
    config: {
      id: "rsi-reversal",
      name: "RSI Reversal",
      version: "1.0.0",
      description: "Buy when RSI crosses above oversold, sell when crosses below overbought",
      enabled: true,
      timeframe: "tick",
      parameters: { period, oversold, overbought },
    },
    calculate(prices: number[]): StrategyResult {
      if (prices.length <= period + 1) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data for RSI" };
      const rsiVal = computeRSI(prices, period);
      const prevRsi = computeRSI(prices.slice(0, -1), period);
      if (rsiVal === null || prevRsi === null) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Cannot compute RSI" };
      if (prevRsi <= oversold && rsiVal > oversold) return { side: "buy", confidence: 0.65, indicators: { rsi: rsiVal }, reasoning: `RSI crossed above oversold: ${rsiVal.toFixed(1)} > ${oversold}` };
      if (prevRsi >= overbought && rsiVal < overbought) return { side: "sell", confidence: 0.65, indicators: { rsi: rsiVal }, reasoning: `RSI crossed below overbought: ${rsiVal.toFixed(1)} < ${overbought}` };
      if (rsiVal < oversold) return { side: "buy", confidence: 0.55, indicators: { rsi: rsiVal }, reasoning: `RSI oversold: ${rsiVal.toFixed(1)}` };
      if (rsiVal > overbought) return { side: "sell", confidence: 0.55, indicators: { rsi: rsiVal }, reasoning: `RSI overbought: ${rsiVal.toFixed(1)}` };
      return { side: "hold", confidence: 0.5, indicators: { rsi: rsiVal }, reasoning: `RSI neutral: ${rsiVal.toFixed(1)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// MACD Strategy
// ---------------------------------------------------------------------------

function createMACDStrategy(): StrategyInstance {
  return {
    config: {
      id: "macd-crossover",
      name: "MACD Crossover",
      version: "1.0.0",
      description: "Buy when MACD crosses above signal, sell when crosses below",
      enabled: true,
      timeframe: "tick",
      parameters: { fast: 12, slow: 26, signal: 9 },
    },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < 35) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data for MACD" };
      const macdVal = computeMACD(prices);
      const prevMacd = computeMACD(prices.slice(0, -1));
      if (!macdVal || !prevMacd) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Cannot compute MACD" };
      if (prevMacd.macd <= prevMacd.signal && macdVal.macd > macdVal.signal) return { side: "buy", confidence: 0.7, indicators: macdVal, reasoning: `MACD bullish crossover: ${macdVal.macd.toFixed(2)} > ${macdVal.signal.toFixed(2)}` };
      if (prevMacd.macd >= prevMacd.signal && macdVal.macd < macdVal.signal) return { side: "sell", confidence: 0.7, indicators: macdVal, reasoning: `MACD bearish crossover: ${macdVal.macd.toFixed(2)} < ${macdVal.signal.toFixed(2)}` };
      return { side: "hold", confidence: 0.5, indicators: macdVal, reasoning: "No MACD crossover" };
    },
  };
}

// ---------------------------------------------------------------------------
// Momentum Strategy
// ---------------------------------------------------------------------------

function createMomentumStrategy(period = 20): StrategyInstance {
  return {
    config: {
      id: "momentum",
      name: "Momentum",
      version: "1.0.0",
      description: "Buy on positive momentum, sell on negative momentum",
      enabled: true,
      timeframe: "tick",
      parameters: { period },
    },
    calculate(prices: number[]): StrategyResult {
      if (prices.length < period + 1) return { side: "hold", confidence: 0.5, indicators: {}, reasoning: "Insufficient data" };
      const current = prices[prices.length - 1]!;
      const past = prices[prices.length - 1 - period]!;
      const momentum = ((current - past) / past) * 100;
      const threshold = 2;
      if (momentum > threshold) return { side: "buy", confidence: Math.min(0.8, 0.5 + momentum / 20), indicators: { momentum }, reasoning: `Positive momentum: ${momentum.toFixed(2)}%` };
      if (momentum < -threshold) return { side: "sell", confidence: Math.min(0.8, 0.5 + Math.abs(momentum) / 20), indicators: { momentum }, reasoning: `Negative momentum: ${momentum.toFixed(2)}%` };
      return { side: "hold", confidence: 0.5, indicators: { momentum }, reasoning: `Neutral momentum: ${momentum.toFixed(2)}%` };
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy Registry (runtime)
// ---------------------------------------------------------------------------

export class StrategyRegistry {
  private strategies = new Map<string, StrategyInstance>();

  register(strategy: StrategyInstance): void {
    this.strategies.set(strategy.config.id, strategy);
    console.log(`[strategy-registry] registered: ${strategy.config.id}`);
  }

  unregister(id: string): boolean {
    return this.strategies.delete(id);
  }

  get(id: string): StrategyInstance | undefined {
    return this.strategies.get(id);
  }

  list(): StrategyConfig[] {
    return [...this.strategies.values()].map((s) => ({ ...s.config }));
  }

  getEnabled(): StrategyInstance[] {
    return [...this.strategies.values()].filter((s) => s.config.enabled);
  }

  enable(id: string): void {
    const s = this.strategies.get(id);
    if (s) s.config.enabled = true;
  }

  disable(id: string): void {
    const s = this.strategies.get(id);
    if (s) s.config.enabled = false;
  }

  size(): number {
    return this.strategies.size;
  }
}

export function registerDefaultStrategies(registry: StrategyRegistry): void {
  registry.register(createEMACrossoverStrategy());
  registry.register(createRSIStrategy());
  registry.register(createMACDStrategy());
  registry.register(createMomentumStrategy());
  console.log(`[strategy-registry] registered ${registry.size()} default strategies`);
}
