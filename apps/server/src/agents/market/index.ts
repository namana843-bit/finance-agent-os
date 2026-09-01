import { EventBus, eventBus as defaultBus } from "../../core/eventBus.js";
import {
  SUPPORTED_SYMBOLS,
  BASE_PRICES,
  generateSyntheticTick,
  fetchTick as fetchTickHelper,
  type Tick,
} from "./service.js";

export type { Tick } from "./service.js";
export { SUPPORTED_SYMBOLS, BASE_PRICES };

export class MarketAgent {
  public readonly name = "Market Agent";
  public readonly supportedSymbols = [...SUPPORTED_SYMBOLS];

  private bus: EventBus;
  private history: Tick[] = [];
  private maxHistory = 1000;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private wsTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private symbols: string[] = [...SUPPORTED_SYMBOLS];
  private lastPrices = new Map<string, number>();
  private pollIntervalMs = 2000;

  constructor(bus?: EventBus) {
    this.bus = bus ?? defaultBus;
    for (const s of SUPPORTED_SYMBOLS) {
      this.lastPrices.set(s, BASE_PRICES[s]!);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.unsubscribe = this.bus.subscribe(() => {});

    this.startPolling(this.symbols, this.pollIntervalMs);
    this.connectBinanceWS(this.symbols);
  }

  stop(): void {
    this.running = false;

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.wsTimer) {
      clearInterval(this.wsTimer);
      this.wsTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
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
      this.wsTimer = setInterval(() => {
        if (!this.running) return;
        for (const sym of list) {
          const tick = generateSyntheticTick(sym, this.lastPrices.get(sym));
          this.lastPrices.set(sym, tick.price);
          this.pushHistory(tick);
          this.publishTick(tick);
        }
      }, 1500);
      return;
    }

    this.wsTimer = setInterval(() => {
      if (!this.running) return;
      for (const sym of list) {
        const tick = generateSyntheticTick(sym, this.lastPrices.get(sym));
        this.lastPrices.set(sym, tick.price);
        this.pushHistory(tick);
        this.publishTick(tick);
      }
    }, 1200);
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

  isRunning(): boolean {
    return this.running;
  }

  private publishTick(tick: Tick): void {
    try {
      this.bus.publish({ type: "market:tick", data: tick });
    } catch (err) {
      console.error("[MarketAgent] publish failed:", err);
    }
  }

  private pushHistory(tick: Tick): void {
    this.history.push(tick);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}

export const marketAgent = new MarketAgent();

export default MarketAgent;
