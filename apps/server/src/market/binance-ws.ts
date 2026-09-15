// ============================================================================
// Finance Agent OS — Binance Live Market WebSocket Runtime
// Phase 6: Real-time public market data streams with heartbeat, auto-reconnect,
// subscription recovery, and event normalization.
// STRICT SAFETY: Pure market data streams only. NO order placement.
// ============================================================================

import WebSocket from "ws";
import type { TypedEventBus } from "@finance/core";
import {
  type NormalizedTick,
  type NormalizedTrade,
  type NormalizedOrderBook,
  type NormalizedKline,
  normalizeSymbol,
  parseBinanceTicker,
  parseBinanceTrade,
  parseBinanceOrderBook,
  parseBinanceKline,
} from "./normalizer.js";

export type StreamType = "ticker" | "trade" | "depth" | "kline";

export interface StreamSubscription {
  symbol: string;
  type: StreamType;
  interval?: string; // for klines, e.g. "1m"
  depthLevels?: number; // for depth, e.g. 10 or 20
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface BinanceWsConfig {
  baseUrl: string;
  heartbeatIntervalMs: number;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  maxReconnectAttempts: number;
}

const DEFAULT_CONFIG: BinanceWsConfig = {
  baseUrl: "wss://stream.binance.com:9443/stream",
  heartbeatIntervalMs: 30_000,
  initialReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30_000,
  maxReconnectAttempts: 10,
};

export class BinanceMarketWebSocket {
  private ws: WebSocket | null = null;
  private config: BinanceWsConfig;
  private subscriptions = new Map<string, StreamSubscription>(); // streamName -> subscription
  private state: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;

  // Event handlers
  private onTickHandlers = new Set<(tick: NormalizedTick) => void>();
  private onTradeHandlers = new Set<(trade: NormalizedTrade) => void>();
  private onOrderBookHandlers = new Set<(book: NormalizedOrderBook) => void>();
  private onKlineHandlers = new Set<(kline: NormalizedKline) => void>();

  constructor(private bus?: TypedEventBus, config?: Partial<BinanceWsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  getActiveSubscriptions(): StreamSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  // -------------------------------------------------------------------------
  // Subscription API
  // -------------------------------------------------------------------------

  /**
   * Subscribe to market ticker updates for a symbol.
   */
  subscribeTicker(symbol: string): void {
    const sym = normalizeSymbol(symbol);
    const stream = `${sym.toLowerCase()}@ticker`;
    this.subscriptions.set(stream, { symbol: sym, type: "ticker" });
    this.ensureConnected();
  }

  /**
   * Subscribe to public trade execution updates.
   */
  subscribeTrades(symbol: string): void {
    const sym = normalizeSymbol(symbol);
    const stream = `${sym.toLowerCase()}@trade`;
    this.subscriptions.set(stream, { symbol: sym, type: "trade" });
    this.ensureConnected();
  }

  /**
   * Subscribe to orderbook depth updates.
   */
  subscribeDepth(symbol: string, levels: 5 | 10 | 20 = 20): void {
    const sym = normalizeSymbol(symbol);
    const stream = `${sym.toLowerCase()}@depth${levels}@100ms`;
    this.subscriptions.set(stream, { symbol: sym, type: "depth", depthLevels: levels });
    this.ensureConnected();
  }

  /**
   * Subscribe to Kline/candlestick streams.
   */
  subscribeKline(symbol: string, interval = "1m"): void {
    const sym = normalizeSymbol(symbol);
    const stream = `${sym.toLowerCase()}@kline_${interval}`;
    this.subscriptions.set(stream, { symbol: sym, type: "kline", interval });
    this.ensureConnected();
  }

  /**
   * Unsubscribe from a specific stream.
   */
  unsubscribe(symbol: string, type: StreamType, interval?: string): void {
    const sym = normalizeSymbol(symbol).toLowerCase();
    for (const [key, sub] of this.subscriptions.entries()) {
      if (sub.symbol.toLowerCase() === sym && sub.type === type) {
        if (!interval || sub.interval === interval) {
          this.subscriptions.delete(key);
        }
      }
    }
    if (this.subscriptions.size === 0) {
      this.disconnect();
    } else if (this.isConnected()) {
      // Reconnect to update query streams
      this.reconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  onTick(handler: (tick: NormalizedTick) => void): () => void {
    this.onTickHandlers.add(handler);
    return () => this.onTickHandlers.delete(handler);
  }

  onTrade(handler: (trade: NormalizedTrade) => void): () => void {
    this.onTradeHandlers.add(handler);
    return () => this.onTradeHandlers.delete(handler);
  }

  onOrderBook(handler: (book: NormalizedOrderBook) => void): () => void {
    this.onOrderBookHandlers.add(handler);
    return () => this.onOrderBookHandlers.delete(handler);
  }

  onKline(handler: (kline: NormalizedKline) => void): () => void {
    this.onKlineHandlers.add(handler);
    return () => this.onKlineHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Lifecycle & Connection Management
  // -------------------------------------------------------------------------

  start(): void {
    this.shouldRun = true;
    this.ensureConnected();
  }

  disconnect(): void {
    this.shouldRun = false;
    this.cleanupHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.state = "disconnected";
  }

  private ensureConnected(): void {
    if (!this.shouldRun || this.subscriptions.size === 0) return;
    if (this.state === "connected" || this.state === "connecting") return;
    this.connect();
  }

  private connect(): void {
    if (this.subscriptions.size === 0) return;

    const streamNames = Array.from(this.subscriptions.keys()).join("/");
    const fullUrl = `${this.config.baseUrl}?streams=${streamNames}`;
    this.state = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";

    try {
      const ws = new WebSocket(fullUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.state = "connected";
        this.reconnectAttempts = 0;
        this.startHeartbeat();

        this.bus?.publish({
          type: "market.ws_connected",
          data: { streams: Array.from(this.subscriptions.keys()), timestamp: Date.now() },
          source: "binance-ws",
        });
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.handleMessage(raw.toString());
      });

      ws.on("ping", () => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.pong();
          } catch {}
        }
      });

      ws.on("error", (err) => {
        console.warn("[BinanceWS] error:", err.message ?? err);
      });

      ws.on("close", () => {
        this.handleDisconnect();
      });
    } catch (err) {
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    this.cleanupHeartbeat();
    this.ws = null;

    if (!this.shouldRun) {
      this.state = "disconnected";
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.state = "disconnected";
      console.warn("[BinanceWS] max reconnect attempts reached, pausing");
      return;
    }

    this.reconnectAttempts++;
    this.state = "reconnecting";

    // Exponential backoff with jitter
    const delay = Math.min(
      this.config.initialReconnectDelayMs * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 500,
      this.config.maxReconnectDelayMs
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private reconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connect();
  }

  private startHeartbeat(): void {
    this.cleanupHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {}
      }
    }, this.config.heartbeatIntervalMs);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Message Parser & Event Dispatcher
  // -------------------------------------------------------------------------

  /**
   * Process raw message from Binance stream and dispatch to listeners / EventBus.
   */
  handleMessage(msgText: string): void {
    try {
      const msg = JSON.parse(msgText) as { stream?: string; data?: Record<string, unknown> };
      const stream = msg.stream ?? "";
      const data = msg.data ?? (msg as Record<string, unknown>);

      if (stream.includes("@ticker") || data.e === "24hrTicker") {
        const tick = parseBinanceTicker(data);
        for (const handler of this.onTickHandlers) handler(tick);
        this.bus?.publish({
          type: "market.tick",
          data: tick,
          source: "binance-ws",
        });
      } else if (stream.includes("@trade") || data.e === "trade") {
        const trade = parseBinanceTrade(data);
        for (const handler of this.onTradeHandlers) handler(trade);
        this.bus?.publish({
          type: "market.trade",
          data: trade,
          source: "binance-ws",
        });
      } else if (stream.includes("@depth") || data.e === "depthUpdate") {
        const book = parseBinanceOrderBook(data, String(data.s ?? ""));
        for (const handler of this.onOrderBookHandlers) handler(book);
        this.bus?.publish({
          type: "market.orderbook",
          data: book,
          source: "binance-ws",
        });
      } else if (stream.includes("@kline") || data.e === "kline") {
        const kline = parseBinanceKline(data, String(data.s ?? ""));
        for (const handler of this.onKlineHandlers) handler(kline);
        this.bus?.publish({
          type: "market.kline",
          data: kline,
          source: "binance-ws",
        });
      }
    } catch {}
  }
}
