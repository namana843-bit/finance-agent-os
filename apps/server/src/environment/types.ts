// ============================================================================
// Finance Agent OS — Finance Environment Types
// Finance Agent OS: Environment is the sandbox agents interact with.
// Provides market data, portfolio, paper trading, backtesting via adapters.
// Exchange-specific code lives only in adapters; environment is agnostic.
// ============================================================================

import type { PriceResult, OHLCVBar, OrderBookSnapshot, BalanceMap, ProviderPosition, ProviderPortfolio } from "../providers/types.js";
import type { PaperOrder } from "../broker/paper-broker.js";
import type { BacktestResult, BacktestCandle } from "../backtesting/backtest-engine.js";

export type EnvironmentMode = "paper" | "backtest";

export interface CreateOrderParams {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  type?: "market" | "limit";
  price?: number;
}

// ---------------------------------------------------------------------------
// Ports — each adapter implements one port
// ---------------------------------------------------------------------------

export interface MarketDataPort {
  getPrice(symbol: string): Promise<PriceResult>;
  getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
}

export interface PortfolioPort {
  getBalance(): Promise<BalanceMap>;
  getPositions(): Promise<ProviderPosition[]>;
  getPortfolio(): Promise<ProviderPortfolio>;
}

export interface PaperTradingPort {
  /** Create a paper order — never touches live exchange */
  createOrder(params: CreateOrderParams): Promise<PaperOrder>;
  cancelOrder(orderId: string): Promise<{ orderId: string; status: string }>;
  getOrders(): Promise<PaperOrder[]>;
  getOpenOrders(): Promise<PaperOrder[]>;
  getPortfolio(): Promise<ProviderPortfolio>;
}

export interface BacktestPort {
  run(params: {
    strategyId: string;
    symbol: string;
    timeframe?: string;
    candles: BacktestCandle[];
    initialCapital?: number;
  }): Promise<BacktestResult>;
  /** Convenience: fetch OHLCV via market adapter then backtest */
  runWithMarketData(params: {
    strategyId: string;
    symbol: string;
    timeframe?: string;
    limit?: number;
    initialCapital?: number;
  }): Promise<BacktestResult>;
}

// ---------------------------------------------------------------------------
// FinanceEnvironment — composition of ports (Finance Agent Environment)
// ---------------------------------------------------------------------------

export interface FinanceEnvironment {
  readonly id: string;
  readonly mode: EnvironmentMode;
  readonly market: MarketDataPort;
  readonly portfolio: PortfolioPort;
  readonly trading: PaperTradingPort;
  readonly backtest: BacktestPort;

  isPaperTrading(): boolean;
  isBacktest(): boolean;
  /** No live orders — always throws if called with live mode */
  assertPaperOnly(): void;
}
