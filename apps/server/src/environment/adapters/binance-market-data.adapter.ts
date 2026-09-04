// ============================================================================
// Finance Environment — Binance Market Data Adapter
// Exchange-specific: only place that imports BinanceAdapter.
// Implements MarketDataPort for the FinanceEnvironment.
// No live order execution — getBalance etc returns mock/paper state.
// ============================================================================

import type { MarketDataPort } from "../types.js";
import type { PriceResult, OHLCVBar, OrderBookSnapshot } from "../../providers/types.js";
import { BinanceAdapter } from "../../market/exchange-adapter.js";

export class BinanceMarketDataAdapter implements MarketDataPort {
  readonly id = "binance-market-data";
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

  async connect(): Promise<void> {
    await this.adapter.connect();
  }

  async disconnect(): Promise<void> {
    await this.adapter.disconnect();
  }
}
