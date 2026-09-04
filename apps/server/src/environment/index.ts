// ============================================================================
// Finance Agent OS — Finance Environment (public barrel)
// ============================================================================

export * from "./types.js";
export * from "./finance-environment.js";
export * from "./adapters/binance-market-data.adapter.js";
export * from "./adapters/paper-trading.adapter.js";

import { FinanceEnvironmentImpl } from "./finance-environment.js";
import { BinanceMarketDataAdapter } from "./adapters/binance-market-data.adapter.js";
import { PaperTradingAdapter } from "./adapters/paper-trading.adapter.js";
import type { FinanceEnvironment, EnvironmentMode } from "./types.js";
import type { TypedEventBus } from "@finance/core";

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
 * - portfolio/trading: PaperTradingAdapter (PaperBroker, no live orders)
 * Exchange-specific code is isolated in adapters; agents see only the Environment.
 */
export function createFinanceEnvironment(opts: CreateEnvironmentOptions): FinanceEnvironment {
  const market = opts.marketAdapter ?? new BinanceMarketDataAdapter();
  const trading = opts.tradingAdapter ?? new PaperTradingAdapter(opts.bus);
  // PaperTradingAdapter also implements PortfolioPort
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
  const { PaperTradingAdapter } = await import("./adapters/paper-trading.adapter.js");
  const trading = new PaperTradingAdapter(bus);

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
