// ============================================================================
// Finance Agent OS — Market State Service
// Phase 7: Maintains real-time market state from live data
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

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
  private lastUpdate = 0;
  private eventCount = 0;
  private connectionState: MarketStateSnapshot["connectionState"] = "disconnected";
  private unsubscribe: (() => void) | null = null;
  private staleThresholdMs = 30_000; // 30 seconds

  constructor(private bus: TypedEventBus) {}

  start(): void {
    this.connectionState = "connected";
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "market.tick") {
        this.handleTick(event);
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
  }

  getPrice(symbol: string): number | undefined {
    const entry = this.entries.get(symbol.toUpperCase());
    return entry?.price;
  }

  getEntry(symbol: string): MarketStateEntry | undefined {
    return this.entries.get(symbol.toUpperCase());
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
}
