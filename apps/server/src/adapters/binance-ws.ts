// Finance Agent OS — Binance WS adapter (public streams, no key required)
// Connects to wss://stream.binance.com:9443/stream?streams=btcusdt@trade/...
// Emits Tick { source: 'binance' } on trade price. Auto-reconnects.
// Falls back to REST+systhetic in MarketAgent if WS disabled or fails.
import WebSocket from "ws";

export interface BinanceTick {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
}

export type BinanceWsTickHandler = (tick: { symbol: string; price: number; volume: number; timestamp: number; source: "binance" }) => void;

export class BinanceWS {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private onTick: BinanceWsTickHandler | null = null;
  private shouldRun = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private online = false;

  constructor(private url = "wss://stream.binance.com:9443/stream") {}

  connect(symbols: string[], onTick: BinanceWsTickHandler): void {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.onTick = onTick;
    this.shouldRun = true;
    this.reconnectDelay = 1000;
    this.open();
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.online = false;
  }

  isOnline(): boolean { return this.online && this.ws?.readyState === WebSocket.OPEN; }

  private open(): void {
    if (!this.shouldRun || this.symbols.length === 0) return;
    const streams = this.symbols.map((s) => `${s}@trade`).join("/");
    const fullUrl = `${this.url}?streams=${streams}`;
    console.log(`[BinanceWS] connecting ${streams}`);
    const ws = new WebSocket(fullUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.online = true;
      this.reconnectDelay = 1000;
      console.log(`[BinanceWS] open (${this.symbols.join(",")})`);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { stream?: string; data?: { s: string; p: string; q: string; T: number } };
        const d = msg.data;
        if (!d || !d.s || !d.p) return;
        const symbol = d.s.toUpperCase();
        const price = Number(d.p);
        if (!Number.isFinite(price) || price <= 0) return;
        const volume = Number(d.q);
        const tick = { symbol, price, volume: Number.isFinite(volume) ? volume : 0, timestamp: typeof d.T === "number" ? d.T : Date.now(), source: "binance" as const };
        this.onTick?.(tick);
      } catch {}
    });

    ws.on("error", (err) => {
      console.warn("[BinanceWS] error", err.message ?? err);
    });

    ws.on("close", () => {
      this.online = false;
      console.log("[BinanceWS] closed");
      if (!this.shouldRun) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      console.log(`[BinanceWS] reconnect in ${delay}ms`);
      setTimeout(() => this.open(), delay);
    });
  }
}
