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

export function createMarketProvider(kind: ProviderKind = "auto"): MarketDataProvider {
  if (kind === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  if (kind === "memory") return new MemoryExchangeProvider();
  // auto: prefer binance, fallback to memory if needed (memory is always available)
  // For now auto returns memory-backed provider seeded with realistic prices;
  // Binance provider can be selected via env EXCHANGE_PROVIDER=binance
  const env = (process.env.EXCHANGE_PROVIDER as ProviderKind | undefined) ?? "auto";
  if (env === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  return new MemoryExchangeProvider();
}

export function createPortfolioProvider(kind: ProviderKind = "auto"): PortfolioProvider {
  if (kind === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  if (kind === "memory") return new MemoryExchangeProvider();
  const env = (process.env.EXCHANGE_PROVIDER as ProviderKind | undefined) ?? "auto";
  if (env === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  return new MemoryExchangeProvider();
}

export function createExchangeProvider(kind: ProviderKind = "auto"): ExchangeProvider {
  if (kind === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  if (kind === "memory") return new MemoryExchangeProvider();
  const env = (process.env.EXCHANGE_PROVIDER as ProviderKind | undefined) ?? "auto";
  if (env === "binance") return new BinanceExchangeProvider(new BinanceAdapter());
  return new MemoryExchangeProvider();
}
