// ============================================================================
// Finance Agent OS — Binance REST Market Data Client
// Phase 6: Public read-only market data with rate limit tracking & snapshots.
// STRICT SAFETY: Pure market data client. Live order endpoints (/api/v3/order)
// are strictly forbidden and cannot be called.
// ============================================================================

import {
  type NormalizedTick,
  type NormalizedOrderBook,
  type NormalizedKline,
  normalizeSymbol,
  parseBinanceTicker,
  parseBinanceOrderBook,
  parseBinanceKline,
} from "./normalizer.js";

export interface RateLimitStatus {
  usedWeight1m: number;
  maxWeight1m: number;
  remainingWeight: number;
  isRateLimited: boolean;
  lastUpdated: number;
}

export interface BinanceRestConfig {
  baseUrl: string;
  timeoutMs: number;
  maxWeightThreshold: number; // e.g. 1150 before backing off
}

const DEFAULT_CONFIG: BinanceRestConfig = {
  baseUrl: "https://api.binance.com/api/v3",
  timeoutMs: 10_000,
  maxWeightThreshold: 1150,
};

export class BinanceRestClient {
  private config: BinanceRestConfig;
  private usedWeight1m = 0;
  private maxWeight1m = 1200;
  private lastRateLimitUpdate = 0;

  constructor(config?: Partial<BinanceRestConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns current Binance API 1-minute rate limit weight status.
   */
  getRateLimitStatus(): RateLimitStatus {
    return {
      usedWeight1m: this.usedWeight1m,
      maxWeight1m: this.maxWeight1m,
      remainingWeight: Math.max(0, this.maxWeight1m - this.usedWeight1m),
      isRateLimited: this.usedWeight1m >= this.config.maxWeightThreshold,
      lastUpdated: this.lastRateLimitUpdate,
    };
  }

  /**
   * Reset rate limit counters (e.g. for testing).
   */
  resetRateLimit(): void {
    this.usedWeight1m = 0;
    this.lastRateLimitUpdate = Date.now();
  }

  /**
   * Fetch 24-hour ticker price change statistics.
   * Weight: 2
   */
  async getTicker(symbol: string): Promise<NormalizedTick> {
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error("Symbol is required");

    const data = await this.fetchJson<Record<string, unknown>>(`/ticker/24hr?symbol=${encodeURIComponent(sym)}`, 2);
    return parseBinanceTicker(data, sym);
  }

  /**
   * Fetch order book depth snapshot.
   * Weight: 1 (limit 1-100), 5 (limit 500), 10 (limit 1000)
   */
  async getDepth(symbol: string, limit = 20): Promise<NormalizedOrderBook> {
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error("Symbol is required");

    const validLimit = Math.min(Math.max(limit, 5), 1000);
    const weight = validLimit <= 100 ? 1 : validLimit <= 500 ? 5 : 10;

    const data = await this.fetchJson<Record<string, unknown>>(
      `/depth?symbol=${encodeURIComponent(sym)}&limit=${validLimit}`,
      weight
    );
    return parseBinanceOrderBook(data, sym);
  }

  /**
   * Fetch Kline/candlestick historical bars.
   * Weight: 2
   */
  async getKlines(
    symbol: string,
    interval = "1m",
    limit = 100,
    startTime?: number,
    endTime?: number
  ): Promise<NormalizedKline[]> {
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error("Symbol is required");

    const params = new URLSearchParams({
      symbol: sym,
      interval,
      limit: String(Math.min(Math.max(limit, 1), 1000)),
    });

    if (startTime) params.set("startTime", String(startTime));
    if (endTime) params.set("endTime", String(endTime));

    const rawList = await this.fetchJson<unknown[]>(`/klines?${params.toString()}`, 2);
    if (!Array.isArray(rawList)) return [];

    return rawList.map((raw) => parseBinanceKline(raw, sym, interval));
  }

  /**
   * Test connectivity and get Binance server time.
   * Weight: 1
   */
  async getServerTime(): Promise<number> {
    const data = await this.fetchJson<{ serverTime: number }>("/time", 1);
    return data.serverTime ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Strict Safety Gate: Live Order Protection
  // -------------------------------------------------------------------------

  /**
   * Safety guard method: Prohibits order placement in pure market data runtime.
   */
  createOrder(): never {
    throw new Error(
      "[SAFETY VIOLATION] Binance REST market runtime is read-only. Live order placement (/api/v3/order) is strictly prohibited."
    );
  }

  cancelOrder(): never {
    throw new Error(
      "[SAFETY VIOLATION] Binance REST market runtime is read-only. Order cancellation is strictly prohibited."
    );
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helper with rate-limit tracking
  // -------------------------------------------------------------------------

  private async fetchJson<T>(path: string, estimatedWeight: number): Promise<T> {
    // Check if we are approaching the 1-minute weight limit
    if (this.usedWeight1m + estimatedWeight > this.config.maxWeightThreshold) {
      throw new Error(
        `[RATE LIMIT EXCEEDED] Binance API weight threshold reached: usedWeight=${this.usedWeight1m} > threshold=${this.config.maxWeightThreshold}. Backing off.`
      );
    }

    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "FinanceAgentOS/0.1.0",
        },
      });

      // Update rate limit headers from Binance response
      const weightHeader = res.headers.get("x-mbx-used-weight-1m");
      if (weightHeader) {
        const parsedWeight = parseInt(weightHeader, 10);
        if (!isNaN(parsedWeight)) {
          this.usedWeight1m = parsedWeight;
          this.lastRateLimitUpdate = Date.now();
        }
      } else {
        this.usedWeight1m += estimatedWeight;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Binance REST error ${res.status}: ${res.statusText} — ${body}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
