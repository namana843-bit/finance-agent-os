// ============================================================================
// Finance Agent OS — Market Data Resolver
// Resolves candles / order books from the BEST available source and always
// reports where the data actually came from.
//
// Resolution priority (real data first — never silently fabricated):
//   1. "websocket" — live Binance WS state already collected in MarketStateService
//   2. "exchange"  — Binance REST klines / depth snapshot (read-only client)
//   3. "mock"      — deterministic provider mock, ALWAYS flagged synthetic:true
//   4. "none"      — no data available (empty arrays + explanatory note)
//
// BUG FIX: these endpoints previously generated RANDOM candles/order books
// inline and returned them as if they were market data. The numbers looked
// plausible but were pure noise. Every response now carries `source` and
// `synthetic` so consumers can be honest about what they display.
// ============================================================================

import type { NormalizedKline, NormalizedOrderBook } from "./normalizer.js";
import type { MarketDataProvider, OrderBookLevel } from "../providers/types.js";

export type MarketDataSource = "websocket" | "exchange" | "mock" | "none";

export interface CandleBar {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface ResolvedCandles {
  symbol: string;
  timeframe: string;
  candles: CandleBar[];
  source: MarketDataSource;
  synthetic: boolean;
  timestamp: number;
  note?: string;
}

export interface ResolvedOrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
  source: MarketDataSource;
  synthetic: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Structural dependency interfaces — the resolver never talks to the network
// directly, so it is fully testable with injected fakes.
// ---------------------------------------------------------------------------

export interface KlineSource {
  getKlines(symbol: string, timeframe: string, limit: number): Promise<NormalizedKline[]>;
}

export interface DepthSource {
  getDepth(symbol: string, limit: number): Promise<NormalizedOrderBook>;
}

export interface LiveStateSource {
  getKlines(symbol: string, limit?: number): NormalizedKline[];
  getOrderBook(symbol: string): NormalizedOrderBook | undefined;
}

export interface MarketDataResolverDeps {
  /** Live WebSocket state (MarketStateService). */
  liveState?: LiveStateSource | undefined;
  /** Read-only exchange REST client (Binance). */
  exchange?: (KlineSource & Partial<DepthSource>) | null | undefined;
  /** Exchange-agnostic provider (memory mock or binance). */
  provider?: MarketDataProvider | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const SUPPORTED_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"] as const;

export function clampLimit(raw: unknown, def = 100, max = 500): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function normalizeTimeframe(raw: unknown): string {
  const tf = String(raw ?? "1m").trim().toLowerCase();
  if (!tf) return "1m";
  return (SUPPORTED_TIMEFRAMES as readonly string[]).includes(tf) ? tf : "1m";
}

export function normalizeSymbol(raw: unknown): string {
  return String(raw ?? "").replace(/[\/\-_ ]/g, "").trim().toUpperCase();
}

function toCandleBar(k: NormalizedKline): CandleBar {
  return {
    symbol: k.symbol,
    timeframe: k.timeframe,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    timestamp: k.timestamp,
  };
}

/** A provider is "real" only when it talks to an actual exchange. */
function isRealProvider(provider: MarketDataProvider | undefined): boolean {
  const id = (provider as { id?: string } | undefined)?.id;
  return typeof id === "string" && id !== "memory" && id !== "mock";
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export async function resolveCandles(
  symbol: string,
  timeframe: string,
  limit: number,
  deps: MarketDataResolverDeps = {},
): Promise<ResolvedCandles> {
  const sym = normalizeSymbol(symbol) || "BTCUSDT";
  const tf = normalizeTimeframe(timeframe);
  const lim = clampLimit(limit, 100, 500);

  // 1. Live WebSocket state (already collected by MarketStateService).
  const live = deps.liveState?.getKlines(sym, lim) ?? [];
  const matching = live.filter((k) => normalizeTimeframe(k.timeframe) === tf);
  if (matching.length > 0) {
    return {
      symbol: sym,
      timeframe: tf,
      candles: matching.slice(-lim).map(toCandleBar),
      source: "websocket",
      synthetic: false,
      timestamp: Date.now(),
    };
  }

  // 2. Exchange REST klines (read-only, no order capability).
  if (deps.exchange) {
    try {
      const klines = await deps.exchange.getKlines(sym, tf, lim);
      if (klines && klines.length > 0) {
        return {
          symbol: sym,
          timeframe: tf,
          candles: klines.slice(-lim).map(toCandleBar),
          source: "exchange",
          synthetic: false,
          timestamp: Date.now(),
        };
      }
    } catch {
      // fall through to the next source
    }
  }

  // 3. Provider fallback (mock providers are explicitly flagged as synthetic).
  if (deps.provider) {
    try {
      const bars = await deps.provider.getOHLCV(sym, tf, lim);
      if (bars && bars.length > 0) {
        const real = isRealProvider(deps.provider);
        return {
          symbol: sym,
          timeframe: tf,
          candles: bars.slice(-lim).map((b) => ({
            symbol: b.symbol,
            timeframe: b.timeframe,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            timestamp: b.timestamp,
          })),
          source: real ? "exchange" : "mock",
          synthetic: !real,
          timestamp: Date.now(),
        };
      }
    } catch {
      // fall through
    }
  }

  // 4. Nothing available — empty result with an honest note (never fabricate).
  return {
    symbol: sym,
    timeframe: tf,
    candles: [],
    source: "none",
    synthetic: false,
    timestamp: Date.now(),
    note: "No historical candle data available for this symbol. Enable the Binance market feed (BINANCE_WS_ENABLED=true) or set EXCHANGE_PROVIDER=binance.",
  };
}

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

export async function resolveOrderBook(
  symbol: string,
  depth: number,
  deps: MarketDataResolverDeps = {},
): Promise<ResolvedOrderBook> {
  const sym = normalizeSymbol(symbol) || "BTCUSDT";
  const d = clampLimit(depth, 10, 100);

  // 1. Live WebSocket depth (already collected by MarketStateService).
  const live = deps.liveState?.getOrderBook(sym);
  if (live && (live.bids.length > 0 || live.asks.length > 0)) {
    return {
      symbol: sym,
      bids: live.bids.slice(0, d),
      asks: live.asks.slice(0, d),
      timestamp: live.timestamp,
      source: "websocket",
      synthetic: false,
    };
  }

  // 2. Exchange REST depth snapshot.
  if (deps.exchange?.getDepth) {
    try {
      const book = await deps.exchange.getDepth(sym, d);
      if (book && (book.bids.length > 0 || book.asks.length > 0)) {
        return {
          symbol: sym,
          bids: book.bids.slice(0, d),
          asks: book.asks.slice(0, d),
          timestamp: book.timestamp,
          source: "exchange",
          synthetic: false,
        };
      }
    } catch {
      // fall through
    }
  }

  // 3. Provider fallback (mock providers are explicitly flagged as synthetic).
  if (deps.provider) {
    try {
      const book = await deps.provider.getOrderBook(sym, d);
      if (book && (book.bids.length > 0 || book.asks.length > 0)) {
        const real = isRealProvider(deps.provider);
        return {
          symbol: sym,
          bids: book.bids.slice(0, d),
          asks: book.asks.slice(0, d),
          timestamp: book.timestamp,
          source: real ? "exchange" : "mock",
          synthetic: !real,
        };
      }
    } catch {
      // fall through
    }
  }

  // 4. Nothing available — empty book with an honest note (never fabricate).
  return {
    symbol: sym,
    bids: [],
    asks: [],
    timestamp: Date.now(),
    source: "none",
    synthetic: false,
    note: "No order book data available for this symbol. Enable the Binance market feed (BINANCE_WS_ENABLED=true) or set EXCHANGE_PROVIDER=binance.",
  };
}
