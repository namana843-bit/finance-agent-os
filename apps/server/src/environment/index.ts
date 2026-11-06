// ============================================================================
// Finance Agent OS — Finance Environment (public barrel)
// ============================================================================

export * from "./types.js";
export * from "./finance-environment.js";
export * from "./adapters/binance-market-data.adapter.js";

import { FinanceEnvironmentImpl } from "./finance-environment.js";
import { BinanceMarketDataAdapter } from "./adapters/binance-market-data.adapter.js";
import type { FinanceEnvironment, EnvironmentMode } from "./types.js";
import type { TypedEventBus } from "@finance/core";
import type { BalanceMap, ProviderPosition, ProviderPortfolio } from "../providers/types.js";

// Stub trading adapter (PaperBroker removed — returns empty portfolio data)
class StubTradingAdapter {
  readonly id = "stub-trading";
  constructor(private bus?: import("@finance/core").TypedEventBus) {}
  async createOrder(): Promise<any> { return { orderId: "", status: "rejected" }; }
  async cancelOrder(): Promise<{ orderId: string; status: string }> { return { orderId: "", status: "not_found" }; }
  async getOrders(): Promise<any[]> { return []; }
  async getOpenOrders(): Promise<any[]> { return []; }
  async getBalance(): Promise<BalanceMap> { return { USDT: { free: 0, used: 0, total: 0 }, USD: { free: 0, used: 0, total: 0 } }; }
  async getPositions(): Promise<ProviderPosition[]> { return []; }
  async getPortfolio(): Promise<ProviderPortfolio> { return { cash: 0, equity: 0, positions: [], realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, timestamp: Date.now() }; }
}

export interface CreateEnvironmentOptions {
  bus: TypedEventBus;
  mode?: EnvironmentMode;
  id?: string;
  strategyRegistry?: import("../strategies/strategy-registry.js").StrategyRegistry;
  /** Override adapters (useful for tests) */
  marketAdapter?: import("./types.js").MarketDataPort;
  tradingAdapter?: import("./types.js").PaperTradingPort & import("./types.js").PortfolioPort;
}

/**
 * Create the canonical Finance Environment.
 * - market: BinanceMarketDataAdapter (reads Binance, no orders)
 * - portfolio/trading: stub adapter (no live orders, empty portfolio)
 * Exchange-specific code is isolated in adapters; agents see only the Environment.
 */
export function createFinanceEnvironment(opts: CreateEnvironmentOptions): FinanceEnvironment {
  const market = opts.marketAdapter ?? new BinanceMarketDataAdapter();
  const trading = opts.tradingAdapter ?? new StubTradingAdapter(opts.bus);
  // StubTradingAdapter also implements PortfolioPort
  const portfolio = (trading as unknown as import("./types.js").PortfolioPort) ?? trading;

  return new FinanceEnvironmentImpl({
    id: opts.id,
    mode: opts.mode ?? "paper",
    bus: opts.bus,
    market,
    portfolio,
    trading,
    strategyRegistry: opts.strategyRegistry,
  });
}

/**
 * Create an isolated in-memory environment for tests (no network).
 */
export async function createTestEnvironment(bus: TypedEventBus): Promise<FinanceEnvironment> {
  const { MemoryExchangeProvider } = await import("../providers/memory-provider.js");
  const mem = new MemoryExchangeProvider();
  const trading = new StubTradingAdapter(bus);

  // Market adapter backed by memory provider
  const marketAdapter: import("./types.js").MarketDataPort = {
    getPrice: (s) => mem.getPrice(s),
    getOHLCV: (s, tf, lim) => mem.getOHLCV(s, tf, lim),
    getOrderBook: (s, d) => mem.getOrderBook(s, d),
  };

  const portfolioAdapter: import("./types.js").PortfolioPort = {
    getBalance: () => trading.getBalance(),
    getPositions: () => trading.getPositions(),
    getPortfolio: () => trading.getPortfolio(),
  };

  const { FinanceEnvironmentImpl } = await import("./finance-environment.js");
  return new FinanceEnvironmentImpl({
    id: "test-environment",
    mode: "paper",
    bus,
    market: marketAdapter,
    portfolio: portfolioAdapter,
    trading,
  });
}
