// ============================================================================
// Finance Agent OS — Market State Service
// Phase 6 & 7: Maintains real-time market state from live ticks, orderbooks,
// klines, and trade streams.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import type {
  NormalizedOrderBook,
  NormalizedKline,
  NormalizedTrade,
} from "./normalizer.js";

export interface MarketStateEntry {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  lastUpdate: number;
  source: string;
}

export interface MarketStateSnapshot {
  symbols: Record<string, MarketStateEntry>;
  lastUpdate: number;
  eventCount: number;
  connectionState: "connected" | "disconnected" | "reconnecting";
}

export class MarketStateService {
  private entries = new Map<string, MarketStateEntry>();
  private orderBooks = new Map<string, NormalizedOrderBook>();
  private klines = new Map<string, NormalizedKline[]>(); // symbol -> klines
  private trades = new Map<string, NormalizedTrade[]>(); // symbol -> trades
  private lastUpdate = 0;
  private eventCount = 0;
  private connectionState: MarketStateSnapshot["connectionState"] = "disconnected";
  private unsubscribe: (() => void) | null = null;
  private staleThresholdMs = 30_000; // 30 seconds
  private readonly maxKlinesPerSymbol = 500;
  private readonly maxTradesPerSymbol = 100;

  constructor(private bus: TypedEventBus) {}

  start(): void {
    this.connectionState = "connected";
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "market.tick") {
        this.handleTick(event);
      } else if (event.type === "market.orderbook") {
        this.handleOrderBook(event);
      } else if (event.type === "market.kline") {
        this.handleKline(event);
      } else if (event.type === "market.trade") {
        this.handleTrade(event);
      }
    });
    console.log("[market-state] started");
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.connectionState = "disconnected";
    console.log("[market-state] stopped");
  }

  private handleTick(event: FinanceEvent): void {
    const tick = event.data as { symbol: string; price: number; change?: number; volume?: number; source?: string };
    if (!tick || !tick.symbol || typeof tick.price !== "number") return;

    const symbol = tick.symbol.toUpperCase();
    const existing = this.entries.get(symbol);

    const entry: MarketStateEntry = {
      symbol,
      price: tick.price,
      change24h: tick.change ?? existing?.change24h ?? 0,
      volume24h: tick.volume ?? existing?.volume24h ?? 0,
      high24h: existing ? Math.max(existing.high24h, tick.price) : tick.price,
      low24h: existing ? Math.min(existing.low24h, tick.price) : tick.price,
      lastUpdate: Date.now(),
      source: tick.source ?? "unknown",
    };

    this.entries.set(symbol, entry);
    this.lastUpdate = Date.now();
    this.eventCount++;

    if (this.connectionState === "reconnecting") {
      this.connectionState = "connected";
    }
  }

  private handleOrderBook(event: FinanceEvent): void {
    const book = event.data as NormalizedOrderBook;
    if (!book || !book.symbol) return;
    this.orderBooks.set(book.symbol.toUpperCase(), book);
    this.lastUpdate = Date.now();
    this.eventCount++;
  }

  private handleKline(event: FinanceEvent): void {
    const kline = event.data as NormalizedKline;
    if (!kline || !kline.symbol) return;
    const sym = kline.symbol.toUpperCase();
    const list = this.klines.get(sym) ?? [];
    list.push(kline);
    if (list.length > this.maxKlinesPerSymbol) {
      list.splice(0, list.length - this.maxKlinesPerSymbol);
    }
    this.klines.set(sym, list);
    this.lastUpdate = Date.now();
    this.eventCount++;
  }

  private handleTrade(event: FinanceEvent): void {
    const trade = event.data as NormalizedTrade;
    if (!trade || !trade.symbol) return;
    const sym = trade.symbol.toUpperCase();
    const list = this.trades.get(sym) ?? [];
    list.push(trade);
    if (list.length > this.maxTradesPerSymbol) {
      list.splice(0, list.length - this.maxTradesPerSymbol);
    }
    this.trades.set(sym, list);
    this.lastUpdate = Date.now();
    this.eventCount++;
  }

  getPrice(symbol: string): number | undefined {
    const entry = this.entries.get(symbol.toUpperCase());
    return entry?.price;
  }

  getEntry(symbol: string): MarketStateEntry | undefined {
    return this.entries.get(symbol.toUpperCase());
  }

  getOrderBook(symbol: string): NormalizedOrderBook | undefined {
    return this.orderBooks.get(symbol.toUpperCase());
  }

  getKlines(symbol: string, limit = 100): NormalizedKline[] {
    const list = this.klines.get(symbol.toUpperCase()) ?? [];
    return list.slice(-limit);
  }

  getTrades(symbol: string, limit = 50): NormalizedTrade[] {
    const list = this.trades.get(symbol.toUpperCase()) ?? [];
    return list.slice(-limit);
  }

  getAll(): Record<string, MarketStateEntry> {
    const result: Record<string, MarketStateEntry> = {};
    for (const [key, value] of this.entries) {
      result[key] = { ...value };
    }
    return result;
  }

  getSnapshot(): MarketStateSnapshot {
    // Check for stale data
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (now - entry.lastUpdate > this.staleThresholdMs) {
        this.connectionState = "reconnecting";
        break;
      }
    }

    return {
      symbols: this.getAll(),
      lastUpdate: this.lastUpdate,
      eventCount: this.eventCount,
      connectionState: this.connectionState,
    };
  }

  getStaleSymbols(): string[] {
    const now = Date.now();
    const stale: string[] = [];
    for (const entry of this.entries.values()) {
      if (now - entry.lastUpdate > this.staleThresholdMs) {
        stale.push(entry.symbol);
      }
    }
    return stale;
  }

  clear(): void {
    this.entries.clear();
    this.orderBooks.clear();
    this.klines.clear();
    this.trades.clear();
    this.eventCount = 0;
  }
}
