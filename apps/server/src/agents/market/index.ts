import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import {
  SUPPORTED_SYMBOLS,
  BASE_PRICES,
  generateSyntheticTick,
  fetchTick as fetchTickHelper,
  type Tick,
} from "./service.js";
import { BinanceWS } from "../../adapters/binance-ws.js";

export type { Tick } from "./service.js";
export { SUPPORTED_SYMBOLS, BASE_PRICES };

export class MarketAgent extends BaseAgent implements Agent {
  public readonly supportedSymbols = [...SUPPORTED_SYMBOLS];

  private bus: TypedEventBus;
  private history: Tick[] = [];
  private maxHistory = 1000;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private wsTimer: ReturnType<typeof setInterval> | null = null;
  private binanceWS: BinanceWS | null = null;
  private symbols: string[] = [...SUPPORTED_SYMBOLS];
  private lastPrices = new Map<string, number>();
  private pollIntervalMs = 2000;

  constructor(bus?: TypedEventBus) {
    super({
      id: "market",
      name: "Market Agent",
      version: "0.1.0",
      description: "Streams real-time market ticks via Binance WS + REST + synthetic fallback",
      capabilities: ["market-data", "tick-streaming", "binance-ws", "binance-rest"],
    });
    this.bus = bus ?? new TypedEventBus();
    for (const s of SUPPORTED_SYMBOLS) {
      this.lastPrices.set(s, BASE_PRICES[s]!);
    }
  }

  async start(): Promise<void> {
    await super.start();
    this.startPolling(this.symbols, this.pollIntervalMs);
    this.connectBinanceWS(this.symbols);
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.wsTimer) {
      clearInterval(this.wsTimer);
      this.wsTimer = null;
    }
    if (this.binanceWS) {
      this.binanceWS.disconnect();
      this.binanceWS = null;
    }
    await super.stop();
  }

  async handleEvent(_event: FinanceEvent): Promise<void> {
    // MarketAgent doesn't handle incoming events; it publishes tick events
  }

  async fetchTick(symbol: string): Promise<Tick> {
    const sym = symbol.toUpperCase();
    const prev = this.lastPrices.get(sym);
    const tick = await fetchTickHelper(sym, prev);
    this.lastPrices.set(sym, tick.price);
    this.pushHistory(tick);
    return tick;
  }

  startPolling(symbols: string[], intervalMs: number): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.symbols = symbols.map((s) => s.toUpperCase());
    this.pollIntervalMs = intervalMs;

    const poll = async () => {
      for (const sym of this.symbols) {
        try {
          const tick = await this.fetchTick(sym);
          this.publishTick(tick);
        } catch (err) {
          const fallback = generateSyntheticTick(sym, this.lastPrices.get(sym));
          this.lastPrices.set(sym, fallback.price);
          this.pushHistory(fallback);
          this.publishTick(fallback);
          console.error(`[MarketAgent] poll error for ${sym}:`, err);
        }
      }
    };

    void poll();
    this.pollingTimer = setInterval(() => void poll(), intervalMs);
  }

  connectBinanceWS(symbols: string[]): void {
    const list = symbols.map((s) => s.toUpperCase());

    if (this.wsTimer) {
      clearInterval(this.wsTimer);
      this.wsTimer = null;
    }
    if (this.binanceWS) {
      this.binanceWS.disconnect();
      this.binanceWS = null;
    }

    const wsEnabled = process.env.BINANCE_WS_ENABLED !== "false";
    const binanceSymbols = list.filter((s) => s.endsWith("USDT")); // public WS only for crypto

    if (wsEnabled && binanceSymbols.length > 0) {
      console.log(`[MarketAgent] Binance WS enabled for ${binanceSymbols.join(",")} — public stream (no key required)`);
      this.binanceWS = new BinanceWS();
      this.binanceWS.connect(binanceSymbols, (wsTick) => {
        if (this.getStatus() !== "running") return;
        const prev = this.lastPrices.get(wsTick.symbol);
        const change = prev !== undefined ? wsTick.price - prev : 0;
        const tick: Tick = {
          symbol: wsTick.symbol,
          price: wsTick.price,
          change,
          volume: wsTick.volume,
          timestamp: wsTick.timestamp,
          source: "binance",
        };
        this.lastPrices.set(wsTick.symbol, wsTick.price);
        this.pushHistory(tick);
        this.publishTick(tick);
      });
      // Fallback synthetic only for non-binance symbols (EURUSD/AAPL/SPY) if no price
      const nonBinance = list.filter((s) => !binanceSymbols.includes(s));
      if (nonBinance.length > 0) {
        this.wsTimer = setInterval(() => {
          if (this.getStatus() !== "running") return;
          for (const sym of nonBinance) {
            const tick = generateSyntheticTick(sym, this.lastPrices.get(sym));
            this.lastPrices.set(sym, tick.price);
            this.pushHistory(tick);
            this.publishTick(tick);
          }
        }, 2000);
      }
      return;
    }

    if (!wsEnabled) {
      console.log("[MarketAgent] BINANCE_WS_ENABLED=false — REST polling only (source=binance when available), synthetic on failure");
      return;
    }

    // Fallback: no binance symbols → synthetic for all
    console.log("[MarketAgent] No binance-streamable symbols — synthetic ticks (source=synthetic)");
    this.wsTimer = setInterval(() => {
      if (this.getStatus() !== "running") return;
      for (const sym of list) {
        const tick = generateSyntheticTick(sym, this.lastPrices.get(sym));
        this.lastPrices.set(sym, tick.price);
        this.pushHistory(tick);
        this.publishTick(tick);
      }
    }, 1500);
  }

  getHistory(limit?: number, symbol?: string): Tick[] {
    let out = this.history;
    if (symbol) {
      const sym = symbol.toUpperCase();
      out = out.filter((t) => t.symbol === sym);
    }
    if (limit !== undefined && limit > 0) {
      out = out.slice(-limit);
    }
    return [...out];
  }

  getLatest(symbol: string): Tick | undefined {
    const sym = symbol.toUpperCase();
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!.symbol === sym) return this.history[i];
    }
    return undefined;
  }

  size(): number {
    return this.history.length;
  }

  private publishTick(tick: Tick): void {
    try {
      this.recordActivity();
      this.bus.publish({
        type: "market.tick",
        data: tick,
        source: "market-agent",
        agentId: "market",
      });
    } catch (err) {
      this.recordError(err);
    }
  }

  private pushHistory(tick: Tick): void {
    this.history.push(tick);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}
