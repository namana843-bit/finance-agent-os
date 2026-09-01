import { EventBus, eventBus as defaultBus, type FinanceEvent } from "../../core/eventBus.js";
import { sma, ema, rsi, macd, bollingerBands, type MacdResult, type BollingerBandsResult } from "./strategies.js";

// Re-export helpers for consumers / tests
export { sma, ema, rsi, macd, bollingerBands };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  smaSignal: SignalAction; // buy if 7>25, sell if 7<25, hold if insufficient
  rsi: number | null;
  rsiSignal: SignalAction;
  macd: MacdResult | null;
  macdSignal: SignalAction;
  bollinger: BollingerBandsResult | null;
  bollingerSignal: SignalAction;
}

export interface Signal {
  symbol: string;
  action: SignalAction;
  confidence: number; // 0–1
  indicators: SignalIndicators;
  price: number;
  timestamp: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// QuantAgent
// ---------------------------------------------------------------------------

export class QuantAgent {
  public readonly name = "Quant Agent";

  private bus: EventBus;
  private buffers = new Map<string, number[]>();
  private signals: Signal[] = [];
  private maxSignals = 500;
  private readonly maxBuffer = 100;
  private unsubscribe: (() => void) | null = null;

  // Optional LLM placeholder — not required for core logic
  private openAiKey: string | undefined;

  constructor(bus?: EventBus) {
    this.bus = bus ?? defaultBus;
    this.openAiKey = process.env.OPENAI_API_KEY;
  }

  /**
   * Subscribe to market:tick events. Idempotent.
   */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "market:tick") {
        const tick = event.data as Tick;
        if (tick && typeof tick.symbol === "string" && typeof tick.price === "number") {
          this.onTick(tick);
        }
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  isRunning(): boolean {
    return this.unsubscribe !== null;
  }

  // -------------------------------------------------------------------------
  // Core: onTick
  // -------------------------------------------------------------------------
  onTick(tick: Tick): void {
    const sym = tick.symbol.toUpperCase();
    const buf = this.buffers.get(sym) ?? [];
    buf.push(tick.price);
    if (buf.length > this.maxBuffer) buf.splice(0, buf.length - this.maxBuffer);
    this.buffers.set(sym, buf);

    // Attempt to generate a signal if we have any data; generateSignal handles insufficient-data case
    try {
      this.generateSignal(sym);
    } catch (err) {
      console.error(`[QuantAgent] generateSignal error for ${sym}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Indicator helpers (wrappers around pure functions for class API compliance)
  // Specified methods: calculateSMA, calculateRSI, calculateMACD
  // -------------------------------------------------------------------------

  calculateSMA(prices: number[], period: number): number | null {
    return sma(prices, period);
  }

  calculateRSI(prices: number[], period = 14): number | null {
    return rsi(prices, period);
  }

  calculateMACD(
    prices: number[],
    fast = 12,
    slow = 26,
    signal = 9,
  ): MacdResult | null {
    return macd(prices, fast, slow, signal);
  }

  // Additional helper exposed for Bollinger (not strictly required but useful)
  calculateBollinger(
    prices: number[],
    period = 20,
    stdDev = 2,
  ): BollingerBandsResult | null {
    return bollingerBands(prices, period, stdDev);
  }

  // -------------------------------------------------------------------------
  // Signal generation — confluence logic + publish
  // -------------------------------------------------------------------------
  generateSignal(symbol: string): Signal | null {
    const sym = symbol.toUpperCase();
    const buffer = this.buffers.get(sym);
    if (!buffer || buffer.length === 0) return null;

    const price = buffer[buffer.length - 1]!;

    // Compute indicators
    const sma7 = sma(buffer, 7);
    const sma25 = sma(buffer, 25);
    const rsiVal = rsi(buffer, 14);
    const macdVal = macd(buffer, 12, 26, 9);
    const bbVal = bollingerBands(buffer, 20, 2);

    // Derive per-indicator signals
    let smaSignal: SignalAction = "hold";
    if (sma7 !== null && sma25 !== null) {
      if (sma7 > sma25) smaSignal = "buy";
      else if (sma7 < sma25) smaSignal = "sell";
    }

    let rsiSignal: SignalAction = "hold";
    if (rsiVal !== null) {
      if (rsiVal < 30) rsiSignal = "buy"; // oversold
      else if (rsiVal > 70) rsiSignal = "sell"; // overbought
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
      sma7,
      sma25,
      smaSignal,
      rsi: rsiVal,
      rsiSignal,
      macd: macdVal,
      macdSignal,
      bollinger: bbVal,
      bollingerSignal,
    };

    // Confluence scoring
    const votes: SignalAction[] = [smaSignal, rsiSignal, macdSignal, bollingerSignal];
    // Count only non-hold votes for confluence denominator? Use total with hold as neutral.
    const buyCount = votes.filter((v) => v === "buy").length;
    const sellCount = votes.filter((v) => v === "sell").length;
    // Number of indicators that had enough data (non-hold OR hold with data vs insufficient)
    // We consider an indicator "active" if its underlying value is non-null. Hold with null = not counted.
    const activeCount =
      (sma7 !== null && sma25 !== null ? 1 : 0) +
      (rsiVal !== null ? 1 : 0) +
      (macdVal !== null ? 1 : 0) +
      (bbVal !== null ? 1 : 0);

    // Default hold when insufficient data
    let action: SignalAction = "hold";
    let confidence = 0.5;
    let reason = "Insufficient confluence — holding";

    if (activeCount === 0) {
      action = "hold";
      confidence = 0.5;
      reason = "Insufficient data for indicators — holding";
    } else if (buyCount > sellCount && buyCount > 0) {
      action = "buy";
      // confidence based on confluence ratio + active participation
      // 1/1 => 0.4, 1/2 => 0.55, 2/2 => 0.65, 2/3 => 0.72, 3/4 => 0.85, 4/4 => 0.95
      const alignRatio = buyCount / Math.max(activeCount, 1);
      const base = 0.35 + alignRatio * 0.6; // 0.35 .. 0.95
      // Bonus if no opposing sell votes
      const bonus = sellCount === 0 ? 0.05 : -0.1 * sellCount;
      confidence = Math.max(0, Math.min(1, base + bonus));
      reason = `Bullish confluence: ${buyCount}/${activeCount} indicators buy (SMA:${smaSignal} RSI:${rsiSignal} MACD:${macdSignal} BB:${bollingerSignal})`;
    } else if (sellCount > buyCount && sellCount > 0) {
      action = "sell";
      const alignRatio = sellCount / Math.max(activeCount, 1);
      const base = 0.35 + alignRatio * 0.6;
      const bonus = buyCount === 0 ? 0.05 : -0.1 * buyCount;
      confidence = Math.max(0, Math.min(1, base + bonus));
      reason = `Bearish confluence: ${sellCount}/${activeCount} indicators sell (SMA:${smaSignal} RSI:${rsiSignal} MACD:${macdSignal} BB:${bollingerSignal})`;
    } else {
      // tie or no directional majority
      action = "hold";
      // confidence lower when mixed, higher when unanimously hold
      if (buyCount === 0 && sellCount === 0) {
        confidence = 0.55;
        reason = `Neutral — all indicators hold (SMA:${smaSignal} RSI:${rsiSignal} MACD:${macdSignal} BB:${bollingerSignal})`;
      } else {
        // mixed buy/sell -> low confidence hold
        confidence = 0.45 + (activeCount > 2 ? 0.05 : 0);
        reason = `Mixed signals — holding (buy:${buyCount} sell:${sellCount} hold:${activeCount - buyCount - sellCount})`;
      }
    }

    // Clamp confidence
    confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

    // Optional OpenAI placeholder: if key present, we could annotate reason (no network call here)
    if (this.openAiKey) {
      // Placeholder — in production would call openai/gpt-4o-mini to refine reasoning.
      // Kept synchronous and synthetic-friendly; no external call.
      reason += " [openai:enhancement available]";
    }

    const signal: Signal = {
      symbol: sym,
      action,
      confidence,
      indicators,
      price,
      timestamp: Date.now(),
      reason,
    };

    // Store
    this.signals.push(signal);
    if (this.signals.length > this.maxSignals) {
      this.signals.splice(0, this.signals.length - this.maxSignals);
    }

    // Publish
    const eventType = `signal:${action}` as const;
    try {
      this.bus.publish({ type: eventType, data: signal });
    } catch (err) {
      console.error(`[QuantAgent] publish failed for ${eventType}:`, err);
    }

    return signal;
  }

  // -------------------------------------------------------------------------
  // Inspection helpers
  // -------------------------------------------------------------------------
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

  getBufferMap(): Map<string, number[]> {
    return new Map(
      [...this.buffers.entries()].map(([k, v]) => [k, [...v] as number[]]),
    );
  }

  size(): number {
    return this.signals.length;
  }

  clear(): void {
    this.signals = [];
    this.buffers.clear();
  }
}

export const quantAgent = new QuantAgent();

export default QuantAgent;
