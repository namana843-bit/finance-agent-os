// ============================================================================
// Finance Agent OS — Binance Provider (exchange-specific)
// Only file that imports exchange-specific adapter. Tools never import this
// directly; they depend on MarketDataProvider/PortfolioProvider interfaces.
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
import { BinanceAdapter } from "../market/exchange-adapter.js";

export class BinanceMarketProvider implements MarketDataProvider {
  private adapter: BinanceAdapter;

  constructor(adapter?: BinanceAdapter) {
    this.adapter = adapter ?? new BinanceAdapter();
  }

  async getPrice(symbol: string): Promise<PriceResult> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const ticker = await this.adapter.getTicker(sym);
    return {
      symbol: sym,
      price: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      volume: ticker.volume,
      timestamp: ticker.timestamp,
      source: "binance",
    };
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const tf = timeframe || "1m";
    const lim = Math.min(Math.max(Math.trunc(limit) || 20, 1), 500);
    const candles = await this.adapter.getCandles(sym, tf, lim);
    return candles.map((c) => ({
      symbol: sym,
      timeframe: tf,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timestamp: c.timestamp,
      closed: true,
    }));
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) throw new Error("symbol is required");
    const d = Math.min(Math.max(Math.trunc(depth) || 10, 1), 100);
    const book = await this.adapter.getOrderBook(sym, d);
    return { symbol: sym, bids: book.bids, asks: book.asks, timestamp: book.timestamp };
  }

  getAdapter(): BinanceAdapter {
    return this.adapter;
  }
}

export class BinancePortfolioProvider implements PortfolioProvider {
  private adapter: BinanceAdapter;

  constructor(adapter?: BinanceAdapter) {
    this.adapter = adapter ?? new BinanceAdapter();
  }

  async getBalance(): Promise<BalanceMap> {
    return this.adapter.getBalance();
  }

  async getPositions(): Promise<ProviderPosition[]> {
    // Binance spot has no positions; futures would. Return empty for spot.
    // Portfolio state is tracked by PaperBroker; this provider delegates to balances.
    return [];
  }

  async getPortfolio(): Promise<ProviderPortfolio> {
    const balances = await this.adapter.getBalance();
    const usdt = balances["USDT"] ?? balances["USD"] ?? { free: 0, used: 0, total: 0 };
    return {
      cash: usdt.free,
      equity: usdt.total,
      positions: [],
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      timestamp: Date.now(),
    };
  }
}

export class BinanceExchangeProvider implements ExchangeProvider {
  readonly id = "binance";
  private market: BinanceMarketProvider;
  private portfolio: BinancePortfolioProvider;

  constructor(adapter?: BinanceAdapter) {
    const shared = adapter ?? new BinanceAdapter();
    this.market = new BinanceMarketProvider(shared);
    this.portfolio = new BinancePortfolioProvider(shared);
  }

  getPrice(symbol: string): Promise<PriceResult> {
    return this.market.getPrice(symbol);
  }
  getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    return this.market.getOHLCV(symbol, timeframe, limit);
  }
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    return this.market.getOrderBook(symbol, depth);
  }
  getBalance(): Promise<BalanceMap> {
    return this.portfolio.getBalance();
  }
  getPositions(): Promise<ProviderPosition[]> {
    return this.portfolio.getPositions();
  }
  getPortfolio(): Promise<ProviderPortfolio> {
    return this.portfolio.getPortfolio();
  }
}
