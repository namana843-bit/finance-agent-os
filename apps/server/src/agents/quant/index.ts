import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { sma, ema, rsi, macd, bollingerBands, type MacdResult, type BollingerBandsResult } from "./strategies.js";

export { sma, ema, rsi, macd, bollingerBands };

export interface Tick {
  symbol: string;
  price: number;
  change?: number;
  volume?: number;
  timestamp: number;
  source?: string;
}

export type SignalAction = "buy" | "sell" | "hold";

export interface SignalIndicators {
  sma7: number | null;
  sma25: number | null;
  smaSignal: SignalAction;
  rsi: number | null;
  rsiSignal: SignalAction;
  macd: MacdResult | null;
  macdSignal: SignalAction;
  bollinger: BollingerBandsResult | null;
  bollingerSignal: SignalAction;
}

export interface Signal {
  id: string;
  symbol: string;
  action: SignalAction;
  confidence: number;
  indicators: SignalIndicators;
  price: number;
  timestamp: number;
  reason: string;
  strategy: string;
  timeframe: string;
}

function generateSignalId(): string {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class QuantAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private buffers = new Map<string, number[]>();
  private signals: Signal[] = [];
  private maxSignals = 500;
  private readonly maxBuffer = 100;
  private unsubscribe: (() => void) | null = null;

  constructor(bus?: TypedEventBus) {
    super({
      id: "quant",
      name: "Quant Agent",
      version: "0.1.0",
      description: "Quantitative analysis using SMA, EMA, RSI, MACD, Bollinger Bands",
      capabilities: ["signal-generation", "technical-analysis", "confluence-scoring"],
    });
    this.bus = bus ?? new TypedEventBus();
  }

  async start(): Promise<void> {
    await super.start();
    this.unsubscribe = this.bus.subscribeTo("market.tick", (event: FinanceEvent) => {
      const tick = event.data as Tick;
      if (tick && typeof tick.symbol === "string" && typeof tick.price === "number") {
        this.onTick(tick).catch((err) => this.recordError(err));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await super.stop();
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    if (event.type === "market.tick") {
      const tick = event.data as Tick;
      if (tick && typeof tick.symbol === "string" && typeof tick.price === "number") {
        await this.onTick(tick);
      }
    }
  }

  async onTick(tick: Tick): Promise<void> {
    const sym = tick.symbol.toUpperCase();
    const buf = this.buffers.get(sym) ?? [];
    buf.push(tick.price);
    if (buf.length > this.maxBuffer) buf.splice(0, buf.length - this.maxBuffer);
    this.buffers.set(sym, buf);

    try {
      this.generateSignal(sym);
    } catch (err) {
      this.recordError(err);
    }
  }

  calculateSMA(prices: number[], period: number): number | null {
    return sma(prices, period);
  }

  calculateRSI(prices: number[], period = 14): number | null {
    return rsi(prices, period);
  }

  calculateMACD(prices: number[], fast = 12, slow = 26, signal = 9): MacdResult | null {
    return macd(prices, fast, slow, signal);
  }

  calculateBollinger(prices: number[], period = 20, stdDev = 2): BollingerBandsResult | null {
    return bollingerBands(prices, period, stdDev);
  }

  generateSignal(symbol: string): Signal | null {
    const sym = symbol.toUpperCase();
    const buffer = this.buffers.get(sym);
    if (!buffer || buffer.length === 0) return null;

    const price = buffer[buffer.length - 1]!;

    const sma7 = sma(buffer, 7);
    const sma25 = sma(buffer, 25);
    const rsiVal = rsi(buffer, 14);
    const macdVal = macd(buffer, 12, 26, 9);
    const bbVal = bollingerBands(buffer, 20, 2);

    let smaSignal: SignalAction = "hold";
    if (sma7 !== null && sma25 !== null) {
      if (sma7 > sma25) smaSignal = "buy";
      else if (sma7 < sma25) smaSignal = "sell";
    }

    let rsiSignal: SignalAction = "hold";
    if (rsiVal !== null) {
      if (rsiVal < 30) rsiSignal = "buy";
      else if (rsiVal > 70) rsiSignal = "sell";
    }

    let macdSignal: SignalAction = "hold";
    if (macdVal !== null) {
      if (macdVal.macd > macdVal.signal) macdSignal = "buy";
      else if (macdVal.macd < macdVal.signal) macdSignal = "sell";
    }

    let bollingerSignal: SignalAction = "hold";
    if (bbVal !== null) {
      if (price < bbVal.lower) bollingerSignal = "buy";
      else if (price > bbVal.upper) bollingerSignal = "sell";
    }

    const indicators: SignalIndicators = {
      sma7, sma25, smaSignal,
      rsi: rsiVal, rsiSignal,
      macd: macdVal, macdSignal,
      bollinger: bbVal, bollingerSignal,
    };

    const votes: SignalAction[] = [smaSignal, rsiSignal, macdSignal, bollingerSignal];
    const buyCount = votes.filter((v) => v === "buy").length;
    const sellCount = votes.filter((v) => v === "sell").length;
    const activeCount =
      (sma7 !== null && sma25 !== null ? 1 : 0) +
      (rsiVal !== null ? 1 : 0) +
      (macdVal !== null ? 1 : 0) +
      (bbVal !== null ? 1 : 0);

    let action: SignalAction = "hold";
    let confidence = 0.5;
    let reason = "Insufficient confluence — holding";

    if (activeCount === 0) {
      reason = "Insufficient data for indicators — holding";
    } else if (buyCount > sellCount && buyCount > 0) {
      action = "buy";
      const alignRatio = buyCount / Math.max(activeCount, 1);
      const base = 0.35 + alignRatio * 0.6;
      const bonus = sellCount === 0 ? 0.05 : -0.1 * sellCount;
      confidence = Math.max(0, Math.min(1, base + bonus));
      reason = `Bullish confluence: ${buyCount}/${activeCount} indicators buy`;
    } else if (sellCount > buyCount && sellCount > 0) {
      action = "sell";
      const alignRatio = sellCount / Math.max(activeCount, 1);
      const base = 0.35 + alignRatio * 0.6;
      const bonus = buyCount === 0 ? 0.05 : -0.1 * buyCount;
      confidence = Math.max(0, Math.min(1, base + bonus));
      reason = `Bearish confluence: ${sellCount}/${activeCount} indicators sell`;
    } else {
      action = "hold";
      confidence = buyCount === 0 && sellCount === 0 ? 0.55 : 0.45;
      reason = buyCount === 0 && sellCount === 0
        ? "Neutral — all indicators hold"
        : "Mixed signals — holding";
    }

    confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

    const signal: Signal = {
      id: generateSignalId(),
      symbol: sym,
      action,
      confidence,
      indicators,
      price,
      timestamp: Date.now(),
      reason,
      strategy: "confluence-v1",
      timeframe: "tick",
    };

    this.signals.push(signal);
    if (this.signals.length > this.maxSignals) {
      this.signals.splice(0, this.signals.length - this.maxSignals);
    }

    this.recordActivity();
    this.bus.publish({
      type: `quant.signal`,
      data: signal,
      source: "quant-agent",
      agentId: "quant",
    });

    return signal;
  }

  getSignals(limit?: number): Signal[] {
    if (limit !== undefined && limit !== null && limit > 0) {
      return [...this.signals.slice(-limit)];
    }
    return [...this.signals];
  }

  getBuffer(symbol: string): number[] {
    const sym = symbol.toUpperCase();
    const buf = this.buffers.get(sym);
    return buf ? [...buf] : [];
  }

  size(): number {
    return this.signals.length;
  }

  clear(): void {
    this.signals = [];
    this.buffers.clear();
  }
}
