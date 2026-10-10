// ============================================================================
// Finance Agent OS — Simulated Market (deterministic, offline)
// Drop-in MarketDataPort used by the test/simulation sandbox.
//
// Design goals:
//   * NO NETWORK — pure functions over a seeded pseudo-random generator.
//   * DETERMINISTIC — the same (seed, symbol, timeframe, index) always yields
//     the same bar/price, so two sandbox runs produce identical books.
//   * PREFIX-STABLE — bar N does not depend on how many bars were requested,
//     so requesting 50 candles and then 100 yields the same first 50.
//
// Replace the default Binance market adapter with this whenever the sandbox is
// active (see core/runtime.ts).
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { PriceResult, OHLCVBar, OrderBookSnapshot } from "../providers/types.js";
import type { MarketDataPort } from "../environment/types.js";
import { BASE_PRICES, SUPPORTED_SYMBOLS } from "../agents/market/service.js";

export interface SimulatedMarketOptions {
  /** Master seed. Same seed => identical series. Default 42. */
  seed?: number;
  /** Override base prices for specific symbols. */
  prices?: Record<string, number>;
  /** Per-symbol drift volatility (fraction). Default 0.0015. */
  volatility?: number;
}

export interface SimulatedTick {
  symbol: string;
  price: number;
  change: number;
  volume: number;
  timestamp: number;
  source: "simulation";
}

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
};

function timeframeToMs(tf: string): number {
  const key = tf?.trim?.() || "1m";
  return TIMEFRAME_MS[key] ?? (key.endsWith("m") ? Number.parseInt(key, 10) * 60_000 : 86_400_000);
}

/** FNV-1a — stable across runs and platforms (unlike `hashCode` tricks). */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function decimalsForSymbol(symbol: string): number {
  if (symbol === "EURUSD") return 4;
  if (symbol === "BTCUSDT") return 2;
  return 2;
}

/**
 * Deterministic, offline market used by the test/simulation sandbox.
 * Implements the FinanceEnvironment `MarketDataPort` and can publish
 * `market.tick` events onto the bus so the PaperBroker's price cache stays live.
 */
export class SimulatedMarket {
  readonly source = "simulation";
  private readonly seed: number;
  private readonly volatility: number;
  private readonly basePrices = new Map<string, number>();
  private readonly currentPrices = new Map<string, number>();
  private readonly steps = new Map<string, number>();
  private readonly rng: () => number;
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private epoch = Date.now();

  constructor(opts?: SimulatedMarketOptions) {
    this.seed = opts?.seed ?? 42;
    this.volatility = opts?.volatility ?? 0.0015;
    this.rng = mulberry32(this.seed);

    for (const symbol of SUPPORTED_SYMBOLS) {
      this.basePrices.set(symbol, BASE_PRICES[symbol] ?? 100);
    }
    for (const [symbol, price] of Object.entries(opts?.prices ?? {})) {
      this.basePrices.set(symbol.toUpperCase(), price);
    }
    // Default the universe to whatever we have base prices for.
    for (const [symbol, price] of this.basePrices) {
      this.currentPrices.set(symbol, price);
    }
  }

  /** Register (or overwrite) a symbol's deterministic base price. */
  setBasePrice(symbol: string, price: number): void {
    const sym = symbol.trim().toUpperCase();
    if (!sym || !Number.isFinite(price) || price <= 0) return;
    this.basePrices.set(sym, price);
    if (!this.currentPrices.has(sym)) this.currentPrices.set(sym, price);
  }

  getSymbols(): string[] {
    return [...this.basePrices.keys()];
  }

  getBasePrice(symbol: string): number {
    const sym = symbol.trim().toUpperCase();
    return this.basePrices.get(sym) ?? 100;
  }

  /**
   * Deterministic price at bar index `i` for a symbol/timeframe.
   * Pure: depends only on (seed, symbol, timeframe, i) — never on call order.
   */
  priceAt(symbol: string, timeframe: string, index: number): number {
    const sym = symbol.trim().toUpperCase();
    const base = this.getBasePrice(sym);
    // Symbol-specific phase offset so different symbols are uncorrelated.
    const phase = (hashString(`${this.seed}:${sym}`) % 3600) / 10;
    const stepMs = timeframeToMs(timeframe);
    // Two sine waves + a slow trend => looks like a market, is fully reproducible.
    const t = (index * stepMs) / 3_600_000; // hours
    const wave =
      Math.sin(t * 0.9 + phase) * this.volatility * 4 +
      Math.sin(t * 0.23 + phase * 1.7) * this.volatility * 7;
    const trend = Math.sin(t * 0.05 + phase * 0.3) * this.volatility * 12;
    return base * (1 + wave + trend);
  }

  /** Deterministic OHLCV bar at index `i`. */
  barAt(symbol: string, timeframe: string, index: number): OHLCVBar {
    const sym = symbol.trim().toUpperCase();
    const decimals = decimalsForSymbol(sym);
    const stepMs = timeframeToMs(timeframe);
    const close = this.priceAt(sym, timeframe, index);
    const open = this.priceAt(sym, timeframe, index - 1);
    const spread = Math.abs(close - open) || close * this.volatility;
    const high = Math.max(open, close) + spread * 0.35;
    const low = Math.min(open, close) - spread * 0.35;
    const volRnd = mulberry32(hashString(`${this.seed}:${sym}:${timeframe}:${index}:v`));
    const volume = 50 + volRnd() * 500;
    return {
      symbol: sym,
      timeframe,
      open: round(open, decimals),
      high: round(high, decimals),
      low: round(low, decimals),
      close: round(close, decimals),
      volume: round(volume, 2),
      timestamp: this.epoch + index * stepMs,
      closed: true,
    };
  }

  /** Latest (index = current step) price for a symbol, advancing its step counter. */
  currentPrice(symbol: string): number {
    const sym = symbol.trim().toUpperCase();
    const step = this.steps.get(sym) ?? 0;
    const price = this.priceAt(sym, "1m", step);
    this.currentPrices.set(sym, price);
    return price;
  }

  /** Advance a symbol one step and return the resulting tick. */
  tick(symbol: string): SimulatedTick {
    const sym = symbol.trim().toUpperCase();
    const prev = this.currentPrices.get(sym) ?? this.getBasePrice(sym);
    const step = (this.steps.get(sym) ?? 0) + 1;
    this.steps.set(sym, step);
    const price = this.priceAt(sym, "1m", step);
    this.currentPrices.set(sym, price);
    const volRnd = mulberry32(hashString(`${this.seed}:${sym}:${step}:t`));
    return {
      symbol: sym,
      price: round(price, decimalsForSymbol(sym)),
      change: round(price - prev, decimalsForSymbol(sym)),
      volume: round(20 + volRnd() * 400, 2),
      timestamp: this.epoch + step * 60_000,
      source: "simulation",
    };
  }

  // -------------------------------------------------------------------------
  // MarketDataPort
  // -------------------------------------------------------------------------

  async getPrice(symbol: string): Promise<PriceResult> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error("symbol is required");
    const price = this.currentPrices.get(sym) ?? this.getBasePrice(sym);
    this.currentPrices.set(sym, price);
    const decimals = decimalsForSymbol(sym);
    return {
      symbol: sym,
      price: round(price, decimals),
      bid: round(price * 0.9995, decimals),
      ask: round(price * 1.0005, decimals),
      volume: 1000,
      timestamp: Date.now(),
      source: this.source,
    };
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error("symbol is required");
    const tf = timeframe?.trim() || "1m";
    const lim = Math.min(Math.max(Math.trunc(limit) || 20, 1), 500);
    const bars: OHLCVBar[] = [];
    for (let i = lim - 1; i >= 0; i--) bars.push(this.barAt(sym, tf, i));
    return bars;
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error("symbol is required");
    const d = Math.min(Math.max(Math.trunc(depth) || 10, 1), 100);
    const mid = this.currentPrices.get(sym) ?? this.getBasePrice(sym);
    const decimals = decimalsForSymbol(sym);
    const rnd = mulberry32(hashString(`${this.seed}:${sym}:book`));
    const bids = Array.from({ length: d }, (_, i) => ({
      price: round(mid * (1 - (i + 1) * 0.0005), decimals),
      quantity: round(0.1 + rnd() * 5, 4),
    }));
    const asks = Array.from({ length: d }, (_, i) => ({
      price: round(mid * (1 + (i + 1) * 0.0005), decimals),
      quantity: round(0.1 + rnd() * 5, 4),
    }));
    return { symbol: sym, bids, asks, timestamp: Date.now() };
  }

  /** Adapter view for `createFinanceEnvironment({ marketAdapter })`. */
  toMarketDataPort(): MarketDataPort {
    return {
      getPrice: (s) => this.getPrice(s),
      getOHLCV: (s, tf, l) => this.getOHLCV(s, tf, l),
      getOrderBook: (s, d) => this.getOrderBook(s, d),
    };
  }

  // -------------------------------------------------------------------------
  // Live tick feed (keeps PaperBroker's price cache warm without network)
  // -------------------------------------------------------------------------

  /**
   * Start publishing deterministic `market.tick` events onto the bus.
   * Returns a stop function. The timer is `unref()`'d so it never keeps the
   * process alive.
   */
  startFeed(bus: TypedEventBus, opts?: { symbols?: string[]; intervalMs?: number }): () => void {
    this.stopFeed();
    const symbols = (opts?.symbols?.length ? opts.symbols : this.getSymbols()).map((s) => s.toUpperCase());
    const intervalMs = Math.max(opts?.intervalMs ?? 1000, 10);
    this.feedTimer = setInterval(() => {
      for (const symbol of symbols) {
        const tick = this.tick(symbol);
        bus.publish({
          type: "market.tick",
          data: tick,
          source: "simulated-market",
          agentId: "simulation",
        });
      }
    }, intervalMs);
    if (typeof this.feedTimer.unref === "function") this.feedTimer.unref();
    return () => this.stopFeed();
  }

  stopFeed(): void {
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
    }
  }

  /** Reset all step counters so a run can be replayed bit-for-bit. */
  reset(): void {
    this.steps.clear();
    for (const [symbol, price] of this.basePrices) this.currentPrices.set(symbol, price);
    this.epoch = Date.now();
  }

  /** Snapshot of every symbol's current simulated price. */
  snapshotPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [symbol, price] of this.currentPrices) out[symbol] = price;
    return out;
  }
}

/** Convenience factory mirroring the other adapter factories in the codebase. */
export function createSimulatedMarket(opts?: SimulatedMarketOptions): SimulatedMarket {
  return new SimulatedMarket(opts);
}
