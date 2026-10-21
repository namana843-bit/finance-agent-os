// ============================================================================
// Finance Agent OS — Exchange Adapter
// Phase 6: Exchange market data connectivity with real REST & WebSocket streams
// STRICT SAFETY: Live order execution is strictly prohibited.
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

  // Order execution safety gates
  createOrder(symbol: string, type: "market" | "limit", side: "buy" | "sell", quantity: number, price?: number): Promise<{ orderId: string; status: string; filledQuantity: number; averagePrice: number }>;
  cancelOrder(orderId: string): Promise<{ orderId: string; status: string }>;
  getBalance(): Promise<Record<string, { free: number; used: number; total: number }>>;
}

// ---------------------------------------------------------------------------
// Binance Adapter Implementation
// ---------------------------------------------------------------------------

import { fetchBinancePrice } from "../agents/market/service.js";
import { BinanceRestClient } from "./binance-rest.js";
import { BinanceMarketWebSocket } from "./binance-ws.js";

export class BinanceAdapter implements ExchangeAdapter {
  readonly id = "binance";
  readonly name = "Binance";
  private connected = false;
  private restClient: BinanceRestClient;
  private wsClient: BinanceMarketWebSocket;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(restClient?: BinanceRestClient, wsClient?: BinanceMarketWebSocket) {
    this.restClient = restClient ?? new BinanceRestClient();
    this.wsClient = wsClient ?? new BinanceMarketWebSocket();
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.wsClient.start();
    console.log("[adapter:binance] connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.wsClient.disconnect();
    console.log("[adapter:binance] disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getTicker(symbol: string): Promise<{ symbol: string; bid: number; ask: number; last: number; volume: number; timestamp: number }> {
    try {
      const ticker = await this.restClient.getTicker(symbol);
      return {
        symbol: ticker.symbol,
        bid: ticker.bid,
        ask: ticker.ask,
        last: ticker.price,
        volume: ticker.volume,
        timestamp: ticker.timestamp,
      };
    } catch {
      // BUG FIX: the previous fallback invented a random volume. Only the
      // last price is knowable here, so volume is reported as unknown (0)
      // instead of a fabricated number.
      const price = await fetchBinancePrice(symbol);
      if (price === null) {
        throw new Error(`No ticker data available for ${symbol.toUpperCase()} (Binance REST unavailable)`);
      }
      return {
        symbol,
        bid: price * 0.999,
        ask: price * 1.001,
        last: price,
        volume: 0,
        timestamp: Date.now(),
      };
    }
  }

  async getCandles(symbol: string, timeframe: string, limit: number): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: number }>> {
    // BUG FIX: this used to fall back to RANDOM candles around a hard-coded
    // price of 68000. Fabricated market data is worse than no data, so the
    // adapter now fails loudly when the exchange is unreachable.
    const klines = await this.restClient.getKlines(symbol, timeframe || "1m", limit);
    if (!klines || klines.length === 0) {
      throw new Error(`No candle data available for ${symbol.toUpperCase()} (Binance REST returned no klines)`);
    }
    return klines.map((k) => ({
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      timestamp: k.timestamp,
    }));
  }

  async getOrderBook(symbol: string, depth: number): Promise<{ bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }> {
    // BUG FIX: this used to fall back to RANDOM bids/asks around the last
    // price. The order book is now either real or an explicit error.
    const book = await this.restClient.getDepth(symbol, depth);
    if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
      throw new Error(`No order book data available for ${symbol.toUpperCase()} (Binance REST returned an empty book)`);
    }
    return {
      bids: book.bids,
      asks: book.asks,
      timestamp: book.timestamp,
    };
  }

  async getTrades(symbol: string, limit: number): Promise<Array<{ price: number; quantity: number; side: "buy" | "sell"; timestamp: number }>> {
    // BUG FIX: this used to invent random trades. Real trades come from the
    // WebSocket stream; the REST adapter does not expose a trade history.
    void symbol;
    void limit;
    throw new Error("Trade history is not available from the REST adapter — use the Binance WebSocket trade stream");
  }

  subscribeTicker(symbol: string, callback: (ticker: { symbol: string; price: number; timestamp: number }) => void): () => void {
    this.wsClient.subscribeTicker(symbol);
    return this.wsClient.onTick((tick) => {
      if (tick.symbol === symbol.toUpperCase()) {
        callback({ symbol: tick.symbol, price: tick.price, timestamp: tick.timestamp });
      }
    });
  }

  subscribeCandles(symbol: string, timeframe: string, callback: (candle: { open: number; high: number; low: number; close: number; volume: number; timestamp: number }) => void): () => void {
    this.wsClient.subscribeKline(symbol, timeframe);
    return this.wsClient.onKline((kline) => {
      if (kline.symbol === symbol.toUpperCase() && kline.timeframe === timeframe) {
        callback({
          open: kline.open,
          high: kline.high,
          low: kline.low,
          close: kline.close,
          volume: kline.volume,
          timestamp: kline.timestamp,
        });
      }
    });
  }

  subscribeOrderBook(symbol: string, callback: (book: { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; timestamp: number }) => void): () => void {
    this.wsClient.subscribeDepth(symbol, 20);
    return this.wsClient.onOrderBook((book) => {
      if (book.symbol === symbol.toUpperCase()) {
        callback({ bids: book.bids, asks: book.asks, timestamp: book.timestamp });
      }
    });
  }

  async createOrder(_symbol: string, _type: "market" | "limit", _side: "buy" | "sell", _quantity: number, _price?: number): Promise<{ orderId: string; status: string; filledQuantity: number; averagePrice: number }> {
    throw new Error("Live exchange order execution is strictly disabled in market adapter — use PaperBroker");
  }

  async cancelOrder(_orderId: string): Promise<{ orderId: string; status: string }> {
    throw new Error("Live exchange order cancellation is strictly disabled in market adapter — use PaperBroker");
  }

  async getBalance(): Promise<Record<string, { free: number; used: number; total: number }>> {
    return { USDT: { free: 100000, used: 0, total: 100000 } };
  }
}
