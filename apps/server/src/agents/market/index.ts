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

export type { Tick } from "./service.js";
export { SUPPORTED_SYMBOLS, BASE_PRICES };

export class MarketAgent extends BaseAgent implements Agent {
  public readonly supportedSymbols = [...SUPPORTED_SYMBOLS];

  private bus: TypedEventBus;
  private history: Tick[] = [];
  private maxHistory = 1000;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private wsTimer: ReturnType<typeof setInterval> | null = null;
  private symbols: string[] = [...SUPPORTED_SYMBOLS];
  private lastPrices = new Map<string, number>();
  private pollIntervalMs = 2000;

  constructor(bus?: TypedEventBus) {
    super({
      id: "market",
      name: "Market Agent",
      version: "0.1.0",
      description: "Streams real-time market ticks via Binance REST + synthetic fallback",
      capabilities: ["market-data", "tick-streaming", "binance-rest"],
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

    const hasKey = !!process.env.BINANCE_API_KEY;

    if (!hasKey) {
      console.log("[MarketAgent] BINANCE_API_KEY missing — synthetic ticks (source=synthetic) until live WS configured");
      this.wsTimer = setInterval(() => {
        if (this.getStatus() !== "running") return;
        for (const sym of list) {
          const tick = generateSyntheticTick(sym, this.lastPrices.get(sym));
          this.lastPrices.set(sym, tick.price);
          this.pushHistory(tick);
          this.publishTick(tick);
        }
      }, 1500);
      return;
    }

    // With API key, polling via fetchTick() already hits Binance REST.
    // Real WS would replace synthetic here — keep polling as source, no extra synthetic flood.
    console.log("[MarketAgent] BINANCE_API_KEY present — using REST polling (source=binance when available); synthetic only on fetch failure");
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
