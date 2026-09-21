// ============================================================================
// Finance Agent OS — Providers index
// Factory helpers: create providers from runtime services so tools stay
// exchange-agnostic. Exchange-specific wiring is isolated here.
// ============================================================================

export * from "./types.js";
export * from "./memory-provider.js";
export * from "./binance-provider.js";

import type { MarketDataProvider, PortfolioProvider, ExchangeProvider } from "./types.js";
import { MemoryExchangeProvider } from "./memory-provider.js";
import { BinanceExchangeProvider } from "./binance-provider.js";
import { BinanceAdapter } from "../market/exchange-adapter.js";

export type ProviderKind = "memory" | "binance" | "auto";

function createProvider(kind: ProviderKind = "auto"): ExchangeProvider {
  if (kind === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  if (kind === "memory") return new MemoryExchangeProvider();
  const env = (process.env.EXCHANGE_PROVIDER as ProviderKind | undefined) ?? "auto";
  if (env === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  return new MemoryExchangeProvider();
}

export function createMarketProvider(kind: ProviderKind = "auto"): MarketDataProvider { return createProvider(kind); }
export function createPortfolioProvider(kind: ProviderKind = "auto"): PortfolioProvider { return createProvider(kind); }
export function createExchangeProvider(kind: ProviderKind = "auto"): ExchangeProvider { return createProvider(kind); }
