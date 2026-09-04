// ============================================================================
// Finance Agent OS — Memory (mock) Provider
// Deterministic in-memory provider for tests/dev. No network, no exchange deps.
// ============================================================================

import type {
  MarketDataProvider,
  PortfolioProvider,
  ExchangeProvider,
  PriceResult,
  OHLCVBar,
  OrderBookSnapshot,
  BalanceMap,
  ProviderPosition,
  ProviderPortfolio,
} from "./types.js";

export interface MemoryProviderOptions {
  initialCash?: number;
  initialPrices?: Record<string, number>;
}

export class MemoryMarketProvider implements MarketDataProvider {
  private prices = new Map<string, number>();
  private ohlcvSeed = 68000;

  constructor(initialPrices?: Record<string, number>) {
    if (initialPrices) {
      for (const [k, v] of Object.entries(initialPrices)) this.prices.set(k.toUpperCase(), v);
    }
    if (!this.prices.has("BTCUSDT")) this.prices.set("BTCUSDT", 68000);
    if (!this.prices.has("ETHUSDT")) this.prices.set("ETHUSDT", 3450);
  }

  seedPrice(symbol: string, price: number): void {
    this.prices.set(symbol.toUpperCase(), price);
  }

  async getPrice(symbol: string): Promise<PriceResult> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const price = this.prices.get(sym);
    if (price === undefined) throw new Error(`No price data for ${sym}`);
    return {
      symbol: sym,
      price,
      bid: price * 0.9995,
      ask: price * 1.0005,
      volume: 1000,
      timestamp: Date.now(),
      source: "memory",
    };
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const tf = timeframe || "1m";
    const lim = Math.min(Math.max(Math.trunc(limit) || 20, 1), 500);
    const now = Date.now();
    const tfMs = timeframeToMs(tf);
    let price = this.prices.get(sym) ?? this.ohlcvSeed;
    const bars: OHLCVBar[] = [];
    for (let i = lim - 1; i >= 0; i--) {
      const open = price;
      const high = open * (1 + Math.random() * 0.002);
      const low = open * (1 - Math.random() * 0.002);
      const close = low + Math.random() * (high - low);
      price = close;
      bars.push({
        symbol: sym,
        timeframe: tf,
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume: round2(Math.random() * 500 + 50),
        timestamp: now - i * tfMs,
        closed: true,
      });
    }
    // Ensure ascending time
    return bars;
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const d = Math.min(Math.max(Math.trunc(depth) || 10, 1), 100);
    const mid = this.prices.get(sym) ?? this.ohlcvSeed;
    const bids = Array.from({ length: d }, (_, i) => ({
      price: round2(mid * (1 - (i + 1) * 0.0005)),
      quantity: round2(Math.random() * 5 + 0.1),
    }));
    const asks = Array.from({ length: d }, (_, i) => ({
      price: round2(mid * (1 + (i + 1) * 0.0005)),
      quantity: round2(Math.random() * 5 + 0.1),
    }));
    return { symbol: sym, bids, asks, timestamp: Date.now() };
  }
}

export class MemoryPortfolioProvider implements PortfolioProvider {
  private cash: number;
  private positions = new Map<string, ProviderPosition>();

  constructor(initialCash = 100000) {
    this.cash = initialCash;
  }

  setCash(cash: number): void {
    this.cash = cash;
  }

  setPosition(pos: ProviderPosition): void {
    this.positions.set(pos.symbol.toUpperCase(), { ...pos });
  }

  clear(): void {
    this.positions.clear();
  }

  async getBalance(): Promise<BalanceMap> {
    const posValue = [...this.positions.values()].reduce((s, p) => s + p.markPrice * p.quantity, 0);
    return {
      USDT: { free: this.cash, used: posValue, total: this.cash + posValue },
      USD: { free: this.cash, used: 0, total: this.cash },
    };
  }

  async getPositions(): Promise<ProviderPosition[]> {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  async getPortfolio(): Promise<ProviderPortfolio> {
    const positions = [...this.positions.values()].map((p) => ({ ...p }));
    const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const realizedPnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const posValue = positions.reduce((s, p) => s + p.markPrice * p.quantity, 0);
    return {
      cash: this.cash,
      equity: this.cash + posValue,
      positions,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      timestamp: Date.now(),
    };
  }
}

export class MemoryExchangeProvider implements ExchangeProvider {
  readonly id = "memory";
  private market: MemoryMarketProvider;
  private portfolio: MemoryPortfolioProvider;

  constructor(opts?: MemoryProviderOptions) {
    this.market = new MemoryMarketProvider(opts?.initialPrices);
    this.portfolio = new MemoryPortfolioProvider(opts?.initialCash);
  }

  // MarketDataProvider delegation
  getPrice(symbol: string): Promise<PriceResult> {
    return this.market.getPrice(symbol);
  }
  getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    return this.market.getOHLCV(symbol, timeframe, limit);
  }
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    return this.market.getOrderBook(symbol, depth);
  }

  // PortfolioProvider delegation
  getBalance(): Promise<BalanceMap> {
    return this.portfolio.getBalance();
  }
  getPositions(): Promise<ProviderPosition[]> {
    return this.portfolio.getPositions();
  }
  getPortfolio(): Promise<ProviderPortfolio> {
    return this.portfolio.getPortfolio();
  }

  // Test helpers
  get marketProvider(): MemoryMarketProvider {
    return this.market;
  }
  get portfolioProvider(): MemoryPortfolioProvider {
    return this.portfolio;
  }
}

function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/);
  if (!m) return 60000;
  const n = parseInt(m[1]!, 10);
  const unit = m[2];
  if (unit === "m") return n * 60000;
  if (unit === "h") return n * 3600000;
  if (unit === "d") return n * 86400000;
  if (unit === "w") return n * 7 * 86400000;
  return 60000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
