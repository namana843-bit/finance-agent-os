import { v4 as uuidv4 } from "uuid";

/**
 * CCXT Wrapper — mock if no keys, ready for real binance.
 *
 * Provides:
 *  - createExchange(exchangeId, apiKey, secret)
 *  - createOrder(exchange, symbol, type, side, amount, price?)
 *  - fetchBalance(exchange)
 *
 * When apiKey/secret are missing or `ccxt` is not installed, returns
 * a mock exchange that simulates responses deterministically. When keys
 * are present and `ccxt` is available, attempts to instantiate the real
 * exchange via dynamic import.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExchangeId = "binance" | "coinbase" | "kraken" | "bybit" | string;

export interface ExchangeConfig {
  exchangeId: ExchangeId;
  apiKey?: string;
  secret?: string;
  sandbox?: boolean;
}

export interface MockOrder {
  id: string;
  symbol: string;
  type: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  status: "closed" | "open" | "canceled";
  timestamp: number;
  fee?: { cost: number; currency: string };
  info: Record<string, unknown>;
}

export interface MockBalance {
  free: Record<string, number>;
  used: Record<string, number>;
  total: Record<string, number>;
  timestamp: number;
  info: Record<string, unknown>;
}

export interface Exchange {
  id: ExchangeId;
  apiKey?: string;
  hasKeys: boolean;
  isMock: boolean;
  createOrder(
    symbol: string,
    type: string,
    side: "buy" | "sell",
    amount: number,
    price?: number,
  ): Promise<MockOrder>;
  fetchBalance(): Promise<MockBalance>;
  // expose raw instance if real ccxt was loaded
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockExchange(exchangeId: ExchangeId): Exchange {
  return {
    id: exchangeId,
    hasKeys: false,
    isMock: true,
    async createOrder(
      symbol: string,
      type: string,
      side: "buy" | "sell",
      amount: number,
      price?: number,
    ): Promise<MockOrder> {
      const now = Date.now();
      const orderPrice = typeof price === "number" && Number.isFinite(price) ? price : 0;
      // simulate tiny random variation for realism? keep deterministic: no randomness
      return {
        id: uuidv4(),
        symbol: symbol.toUpperCase(),
        type,
        side,
        amount,
        price: orderPrice,
        status: "closed",
        timestamp: now,
        fee: { cost: orderPrice * amount * 0.001, currency: "USDT" },
        info: { mock: true, exchangeId },
      };
    },
    async fetchBalance(): Promise<MockBalance> {
      const now = Date.now();
      return {
        free: { USDT: 50000, BTC: 0.5, ETH: 5 },
        used: { USDT: 10000, BTC: 0.2, ETH: 2 },
        total: { USDT: 60000, BTC: 0.7, ETH: 7 },
        timestamp: now,
        info: { mock: true, exchangeId },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Real CCXT loader (dynamic, optional)
// ---------------------------------------------------------------------------

async function tryCreateRealExchange(
  exchangeId: ExchangeId,
  apiKey: string,
  secret: string,
): Promise<Exchange | null> {
  try {
    // dynamic import so missing ccxt doesn't break build
    // ccxt is ESM, import returns namespace with default
    // @ts-ignore - ccxt is optional, not installed in paper mode
    const ccxt: Record<string, unknown> = await import("ccxt").catch(() => null as unknown as Record<string, unknown>);
    if (!ccxt) return null;

    // ccxt exports each exchange as named export, e.g., ccxt.binance
    // also has `ccxt` default with `binance` property
    const ExchangeClass =
      // @ts-ignore dynamic
      (ccxt as Record<string, unknown>)[exchangeId] ??
      // @ts-ignore try lowercase
      (ccxt as Record<string, unknown>)[exchangeId.toLowerCase()] ??
      // @ts-ignore default export
      ((ccxt as unknown as { default?: Record<string, unknown> }).default?.[exchangeId] as unknown);

    if (!ExchangeClass || typeof ExchangeClass !== "function") {
      console.warn(`[ccxtWrapper] exchange ${exchangeId} not found in ccxt, using mock`);
      return null;
    }

    // @ts-ignore instantiate
    const instance = new (ExchangeClass as new (opts: unknown) => unknown)({
      apiKey,
      secret,
      enableRateLimit: true,
    });

    // Wrap real instance to conform to Exchange interface
    const real: Exchange = {
      id: exchangeId,
      apiKey,
      hasKeys: true,
      isMock: false,
      raw: instance,
      async createOrder(symbol, type, side, amount, price) {
        // @ts-ignore ccxt method
        const raw = instance as { createOrder: (...args: unknown[]) => Promise<Record<string, unknown>> };
        try {
          const result = await raw.createOrder(symbol, type, side, amount, price);
          return {
            id: (result["id"] as string) ?? uuidv4(),
            symbol: ((result["symbol"] as string) ?? symbol).toUpperCase(),
            type: (result["type"] as string) ?? type,
            side: ((result["side"] as string) ?? side) as "buy" | "sell",
            amount: (result["amount"] as number) ?? amount,
            price: (result["price"] as number) ?? (price ?? 0),
            status: ((result["status"] as string) ?? "closed") as MockOrder["status"],
            timestamp: (result["timestamp"] as number) ?? Date.now(),
            fee: result["fee"] as MockOrder["fee"],
            info: result as Record<string, unknown>,
          };
        } catch (err) {
          console.error(`[ccxtWrapper] real createOrder failed for ${symbol}:`, err);
          throw err;
        }
      },
      async fetchBalance() {
        // @ts-ignore ccxt method
        const raw = instance as { fetchBalance: () => Promise<Record<string, unknown>> };
        try {
          const result = await raw.fetchBalance();
          return {
            free: (result["free"] as Record<string, number>) ?? {},
            used: (result["used"] as Record<string, number>) ?? {},
            total: (result["total"] as Record<string, number>) ?? {},
            timestamp: (result["timestamp"] as number) ?? Date.now(),
            info: result,
          };
        } catch (err) {
          console.error(`[ccxtWrapper] real fetchBalance failed:`, err);
          throw err;
        }
      },
    };

    return real;
  } catch (err) {
    console.warn(`[ccxtWrapper] failed to load ccxt for ${exchangeId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an exchange instance.
 * If apiKey/secret are provided and `ccxt` is installed, returns real exchange;
 * otherwise returns mock exchange ready for paper simulation.
 *
 * @param exchangeId - e.g., "binance"
 * @param apiKey - API key (or env BINANCE_API_KEY)
 * @param secret - API secret (or env BINANCE_SECRET)
 */
export async function createExchange(
  exchangeId: ExchangeId,
  apiKey?: string,
  secret?: string,
): Promise<Exchange> {
  const resolvedKey = apiKey ?? process.env.BINANCE_API_KEY ?? process.env.API_KEY;
  const resolvedSecret = secret ?? process.env.BINANCE_SECRET ?? process.env.API_SECRET;

  if (resolvedKey && resolvedSecret) {
    const real = await tryCreateRealExchange(exchangeId, resolvedKey, resolvedSecret);
    if (real) {
      console.log(`[ccxtWrapper] created real exchange ${exchangeId} (hasKeys=true)`);
      return real;
    }
  }

  // Fallback mock
  if (!resolvedKey || !resolvedSecret) {
    console.log(`[ccxtWrapper] no API keys for ${exchangeId} — using mock exchange (paper)`);
  } else {
    console.log(`[ccxtWrapper] falling back to mock for ${exchangeId}`);
  }
  return createMockExchange(exchangeId);
}

/**
 * Synchronous variant — returns mock immediately (no dynamic import).
 * Useful for paper mode or tests where async not desired.
 */
export function createExchangeSync(
  exchangeId: ExchangeId,
  apiKey?: string,
  secret?: string,
): Exchange {
  const resolvedKey = apiKey ?? process.env.BINANCE_API_KEY;
  const resolvedSecret = secret ?? process.env.BINANCE_SECRET;
  const hasKeys = !!(resolvedKey && resolvedSecret);

  if (!hasKeys) {
    return createMockExchange(exchangeId);
  }
  // If keys present but we want sync, still return mock with hasKeys flag for placeholder
  const mock = createMockExchange(exchangeId);
  return { ...mock, hasKeys: true, apiKey: resolvedKey };
}

/**
 * Create an order via exchange.
 * Delegates to exchange.createOrder; mock if no keys.
 */
export async function createOrder(
  exchange: Exchange,
  symbol: string,
  type: "market" | "limit" = "market",
  side: "buy" | "sell" = "buy",
  amount: number,
  price?: number,
): Promise<MockOrder> {
  if (!exchange) throw new Error("exchange is required");
  if (!symbol || typeof symbol !== "string") throw new Error("symbol is required");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0");

  return exchange.createOrder(symbol.toUpperCase(), type, side, amount, price);
}

/**
 * Fetch balance via exchange.
 */
export async function fetchBalance(exchange: Exchange): Promise<MockBalance> {
  if (!exchange) throw new Error("exchange is required");
  return exchange.fetchBalance();
}

// Convenience default export
export default {
  createExchange,
  createExchangeSync,
  createOrder,
  fetchBalance,
};
