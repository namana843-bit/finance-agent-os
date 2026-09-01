// ============================================================================
// Finance Agent OS — Exchange Adapter
// Phase 6: Abstraction for exchange connectivity
// ============================================================================

export interface ExchangeAdapter {
  readonly id: string;
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getTicker(symbol: string): Promise<{ symbol: string; bid: number; ask: number; last: number; volume: number; timestamp: number }>;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: number }>>;
  getOrderBook(symbol: string, depth: number): Promise<{ bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }>;
  getTrades(symbol: string, limit: number): Promise<Array<{ price: number; quantity: number; side: "buy" | "sell"; timestamp: number }>>;

  subscribeTicker(symbol: string, callback: (ticker: { symbol: string; price: number; timestamp: number }) => void): () => void;
  subscribeCandles(symbol: string, timeframe: string, callback: (candle: { open: number; high: number; low: number; close: number; volume: number; timestamp: number }) => void): () => void;
  subscribeOrderBook(symbol: string, callback: (book: { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }) => void): () => void;

  // Order execution
  createOrder(symbol: string, type: "market" | "limit", side: "buy" | "sell", quantity: number, price?: number): Promise<{ orderId: string; status: string; filledQuantity: number; averagePrice: number }>;
  cancelOrder(orderId: string): Promise<{ orderId: string; status: string }>;
  getBalance(): Promise<Record<string, { free: number; used: number; total: number }>>;
}

// ---------------------------------------------------------------------------
// Binance Adapter Implementation
// ---------------------------------------------------------------------------

import { generateSyntheticTick, fetchBinancePrice } from "../agents/market/service.js";

export class BinanceAdapter implements ExchangeAdapter {
  readonly id = "binance";
  readonly name = "Binance";
  private connected = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    console.log("[adapter:binance] connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    console.log("[adapter:binance] disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getTicker(symbol: string): Promise<{ symbol: string; bid: number; ask: number; last: number; volume: number; timestamp: number }> {
    const price = await fetchBinancePrice(symbol) ?? generateSyntheticTick(symbol).price;
    return { symbol, bid: price * 0.999, ask: price * 1.001, last: price, volume: Math.random() * 1000, timestamp: Date.now() };
  }

  async getCandles(symbol: string, _timeframe: string, limit: number): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: number }>> {
    // TODO: fetch real candles from Binance API
    const now = Date.now();
    let price = 68000;
    return Array.from({ length: limit }, (_, i) => {
      const open = price + (Math.random() - 0.5) * 200;
      const high = open + Math.random() * 300;
      const low = open - Math.random() * 300;
      const close = low + Math.random() * (high - low);
      price = close;
      return { open, high, low, close, volume: Math.random() * 500, timestamp: now - (limit - i) * 60000 };
    });
  }

  async getOrderBook(symbol: string, depth: number): Promise<{ bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }> {
    const ticker = await this.getTicker(symbol);
    const mid = ticker.last;
    const bids = Array.from({ length: depth }, (_, i) => ({ price: mid * (1 - (i + 1) * 0.0001), quantity: Math.random() * 10 }));
    const asks = Array.from({ length: depth }, (_, i) => ({ price: mid * (1 + (i + 1) * 0.0001), quantity: Math.random() * 10 }));
    return { bids, asks, timestamp: Date.now() };
  }

  async getTrades(symbol: string, limit: number): Promise<Array<{ price: number; quantity: number; side: "buy" | "sell"; timestamp: number }>> {
    const ticker = await this.getTicker(symbol);
    return Array.from({ length: limit }, () => ({
      price: ticker.last * (1 + (Math.random() - 0.5) * 0.001),
      quantity: Math.random() * 5,
      side: Math.random() > 0.5 ? "buy" as const : "sell" as const,
      timestamp: Date.now() - Math.random() * 60000,
    }));
  }

  subscribeTicker(symbol: string, callback: (ticker: { symbol: string; price: number; timestamp: number }) => void): () => void {
    const timer = setInterval(async () => {
      const ticker = await this.getTicker(symbol);
      callback({ symbol, price: ticker.last, timestamp: ticker.timestamp });
    }, 2000);
    this.timers.push(timer);
    return () => clearInterval(timer);
  }

  subscribeCandles(_symbol: string, _timeframe: string, _callback: (candle: { open: number; high: number; low: number; close: number; volume: number; timestamp: number }) => void): () => void {
    // TODO: implement WebSocket candle subscription
    return () => {};
  }

  subscribeOrderBook(_symbol: string, _callback: (book: { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }) => void): () => void {
    // TODO: implement WebSocket orderbook subscription
    return () => {};
  }

  async createOrder(_symbol: string, _type: "market" | "limit", _side: "buy" | "sell", _quantity: number, _price?: number): Promise<{ orderId: string; status: string; filledQuantity: number; averagePrice: number }> {
    // TODO: implement real order creation
    throw new Error("Live order execution not implemented — use PaperBroker");
  }

  async cancelOrder(_orderId: string): Promise<{ orderId: string; status: string }> {
    throw new Error("Live order cancellation not implemented — use PaperBroker");
  }

  async getBalance(): Promise<Record<string, { free: number; used: number; total: number }>> {
    return { USDT: { free: 100000, used: 0, total: 100000 } };
  }
}
