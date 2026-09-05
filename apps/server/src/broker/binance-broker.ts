// ============================================================================
// Finance Agent OS — Binance Broker (Live)
// Phase 24: Live trading adapter with safety gates
// SAFETY: Never enabled by default. Requires EXECUTION_MODE=live AND
//         LIVE_TRADING_ENABLED=true. All orders validated before submission.
// ============================================================================

import type { TypedEventBus } from "@finance/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BinanceBrokerConfig {
  apiKey: string;
  secret: string;
  sandbox: boolean;
  executionMode: "paper" | "live";
  liveTradingEnabled: boolean;
  maxRetries: number;
  requestTimeoutMs: number;
}

export interface BinanceOrderParams {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price?: number;
  timeInForce?: "GTC" | "IOC" | "FOK";
}

export interface BinanceOrderResult {
  orderId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price: number;
  status: string;
  fills: Array<{ price: number; qty: number; commission: number }>;
  timestamp: number;
}

export interface BinanceBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface BinanceTicker {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Safety Guard
// ---------------------------------------------------------------------------

function assertLiveTradingEnabled(config: BinanceBrokerConfig): void {
  if (config.executionMode !== "live") {
    throw new Error(
      `[SAFETY] Live order rejected: EXECUTION_MODE is '${config.executionMode}', expected 'live'. ` +
      `Set EXECUTION_MODE=live to enable live trading.`
    );
  }
  if (!config.liveTradingEnabled) {
    throw new Error(
      `[SAFETY] Live order rejected: LIVE_TRADING_ENABLED is false. ` +
      `Set LIVE_TRADING_ENABLED=true to enable live trading.`
    );
  }
  if (!config.apiKey || !config.secret) {
    throw new Error(
      `[SAFETY] Live order rejected: API keys not configured. ` +
      `Set BINANCE_API_KEY and BINANCE_SECRET environment variables.`
    );
  }
}

// ---------------------------------------------------------------------------
// Binance REST API Client (minimal, no external dependencies)
// ---------------------------------------------------------------------------

class BinanceRestClient {
  private baseUrl: string;
  private apiKey: string;
  private secret: string;

  constructor(apiKey: string, secret: string, sandbox = false) {
    this.baseUrl = sandbox
      ? "https://testnet.binance.vision/api/v3"
      : "https://api.binance.com/api/v3";
    this.apiKey = apiKey;
    this.secret = secret;
  }

  async getTicker(symbol: string): Promise<BinanceTicker> {
    const url = `${this.baseUrl}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Binance API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, string>;
    return {
      symbol: data.symbol ?? symbol,
      price: parseFloat(data.lastPrice ?? "0"),
      bid: parseFloat(data.bidPrice ?? "0"),
      ask: parseFloat(data.askPrice ?? "0"),
      high24h: parseFloat(data.highPrice ?? "0"),
      low24h: parseFloat(data.lowPrice ?? "0"),
      volume24h: parseFloat(data.volume ?? "0"),
      change24h: parseFloat(data.priceChange ?? "0"),
      timestamp: Date.now(),
    };
  }

  async getBalance(): Promise<BinanceBalance[]> {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = await this.sign(queryString);
    const url = `${this.baseUrl}/account?${queryString}&signature=${signature}`;
    const res = await this.fetchWithTimeout(url, {
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
    const data = await res.json() as { balances?: Array<{ asset: string; free: string; locked: string }> };
    return (data.balances ?? []).map((b) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
      total: parseFloat(b.free) + parseFloat(b.locked),
    })).filter((b) => b.total > 0);
  }

  async createOrder(params: BinanceOrderParams): Promise<BinanceOrderResult> {
    const timestamp = Date.now();
    const queryParams: Record<string, string> = {
      symbol: params.symbol.toUpperCase(),
      side: params.side.toUpperCase(),
      type: params.type.toUpperCase(),
      quantity: String(params.quantity),
      timestamp: String(timestamp),
    };
    if (params.price && params.type === "limit") {
      queryParams.price = String(params.price);
      queryParams.timeInForce = params.timeInForce ?? "GTC";
    }

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

    const signature = await this.sign(queryString);
    const url = `${this.baseUrl}/order?${queryString}&signature=${signature}`;

    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Binance order failed: ${res.status} — ${errorBody}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const fills = Array.isArray(data.fills) ? data.fills as Array<Record<string, unknown>> : [];

    return {
      orderId: String(data.orderId ?? ""),
      symbol: String(data.symbol ?? params.symbol),
      side: String(data.side ?? params.side),
      type: String(data.type ?? params.type),
      quantity: parseFloat(String(data.executedQty ?? params.quantity)),
      price: parseFloat(String(data.price ?? params.price ?? "0")),
      status: String(data.status ?? "NEW"),
      fills: fills.map((f) => ({
        price: parseFloat(String(f.price ?? "0")),
        qty: parseFloat(String(f.qty ?? "0")),
        commission: parseFloat(String(f.commission ?? "0")),
      })),
      timestamp: Number(data.updateTime ?? timestamp),
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<{ orderId: string; status: string }> {
    const timestamp = Date.now();
    const queryString = `symbol=${encodeURIComponent(symbol)}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = await this.sign(queryString);
    const url = `${this.baseUrl}/order?${queryString}&signature=${signature}`;

    const res = await this.fetchWithTimeout(url, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Cancel order failed: ${res.status} — ${errorBody}`);
    }

    const data = await res.json() as Record<string, unknown>;
    return {
      orderId: String(data.orderId ?? orderId),
      status: String(data.status ?? "CANCELED"),
    };
  }

  private async sign(queryString: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", this.secret).update(queryString).digest("hex");
  }

  private async fetchWithTimeout(url: string, init?: any, timeoutMs = 10_000): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Binance Broker (Live)
// ---------------------------------------------------------------------------

export class BinanceBroker {
  private config: BinanceBrokerConfig;
  private client: BinanceRestClient | null = null;
  private bus: TypedEventBus;

  constructor(bus: TypedEventBus, config?: Partial<BinanceBrokerConfig>) {
    this.bus = bus;
    this.config = {
      apiKey: process.env.BINANCE_API_KEY ?? "",
      secret: process.env.BINANCE_SECRET ?? "",
      sandbox: process.env.BINANCE_SANDBOX === "true",
      executionMode: (process.env.EXECUTION_MODE as "paper" | "live") ?? "paper",
      liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === "true",
      maxRetries: 3,
      requestTimeoutMs: 10_000,
      ...config,
    };

    if (this.config.apiKey && this.config.secret) {
      this.client = new BinanceRestClient(this.config.apiKey, this.config.secret, this.config.sandbox);
    }
  }

  // -------------------------------------------------------------------------
  // Safety
  // -------------------------------------------------------------------------

  isLiveTradingEnabled(): boolean {
    return this.config.executionMode === "live" && this.config.liveTradingEnabled && !!this.client;
  }

  getConfig(): Readonly<BinanceBrokerConfig> {
    return { ...this.config };
  }

  // -------------------------------------------------------------------------
  // Market Data
  // -------------------------------------------------------------------------

  async getTicker(symbol: string): Promise<BinanceTicker> {
    assertLiveTradingEnabled(this.config);
    if (!this.client) throw new Error("Binance client not initialized");
    return this.client.getTicker(symbol);
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  async getBalance(): Promise<BinanceBalance[]> {
    assertLiveTradingEnabled(this.config);
    if (!this.client) throw new Error("Binance client not initialized");
    return this.client.getBalance();
  }

  // -------------------------------------------------------------------------
  // Order Execution
  // -------------------------------------------------------------------------

  async createOrder(params: BinanceOrderParams): Promise<BinanceOrderResult> {
    assertLiveTradingEnabled(this.config);
    if (!this.client) throw new Error("Binance client not initialized");

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.client.createOrder(params);

        this.bus.publish({
          type: "order.submitted",
          data: {
            ...result,
            source: "binance-broker",
            executionMode: "live",
          },
          source: "binance-broker",
        });

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[binance-broker] order attempt ${attempt}/${this.config.maxRetries} failed:`, lastError.message);
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt)); // exponential backoff
        }
      }
    }

    this.bus.publish({
      type: "order.failed",
      data: {
        symbol: params.symbol,
        side: params.side,
        reason: lastError?.message ?? "Unknown error",
        executionMode: "live",
        timestamp: Date.now(),
      },
      source: "binance-broker",
    });

    throw lastError ?? new Error("Order failed after retries");
  }

  async cancelOrder(orderId: string, symbol: string): Promise<{ orderId: string; status: string }> {
    assertLiveTradingEnabled(this.config);
    if (!this.client) throw new Error("Binance client not initialized");

    const result = await this.client.cancelOrder(orderId, symbol);

    this.bus.publish({
      type: "order.cancelled",
      data: { ...result, symbol, executionMode: "live" },
      source: "binance-broker",
    });

    return result;
  }
}
