// ============================================================================
// Finance Agent OS — Finance Environment
// Finance Agent OS Environment: agents interact with market/portfolio/
// backtesting/paper trading only through this abstraction.
// Composition: marketDataPort + portfolioPort + paperTradingPort + backtestPort
// No live orders — trading port delegates exclusively to PaperBroker.
// ============================================================================

import type {
  FinanceEnvironment,
  EnvironmentMode,
  MarketDataPort,
  PortfolioPort,
  PaperTradingPort,
  BacktestPort,
} from "./types.js";
import type { TypedEventBus } from "@finance/core";
import { BacktestEngine, type BacktestCandle, type BacktestResult } from "../backtesting/backtest-engine.js";
import type { StrategyRegistry } from "../strategies/strategy-registry.js";

export interface FinanceEnvironmentOptions {
  id?: string;
  mode?: EnvironmentMode;
  bus: TypedEventBus;
  market: MarketDataPort;
  portfolio: PortfolioPort;
  trading: PaperTradingPort;
  /** Strategy registry for resolving strategyId during backtests */
  strategyRegistry?: StrategyRegistry;
  /** Optional pre-built BacktestEngine */
  backtestEngine?: BacktestEngine;
}

export class FinanceEnvironmentImpl implements FinanceEnvironment {
  readonly id: string;
  readonly mode: EnvironmentMode;
  readonly market: MarketDataPort;
  readonly portfolio: PortfolioPort;
  readonly trading: PaperTradingPort;
  readonly backtest: BacktestPort;
  private bus: TypedEventBus;
  private strategyRegistry?: StrategyRegistry;
  private engine: BacktestEngine;

  constructor(opts: FinanceEnvironmentOptions) {
    if (!opts.bus) throw new Error("FinanceEnvironment requires bus");
    if (!opts.market) throw new Error("FinanceEnvironment requires market adapter");
    if (!opts.portfolio) throw new Error("FinanceEnvironment requires portfolio adapter");
    if (!opts.trading) throw new Error("FinanceEnvironment requires trading adapter");

    this.id = opts.id ?? "finance-environment";
    this.mode = opts.mode ?? "paper";
    this.market = opts.market;
    this.portfolio = opts.portfolio;
    this.trading = opts.trading;
    this.bus = opts.bus;
    this.strategyRegistry = opts.strategyRegistry;
    this.engine = opts.backtestEngine ?? new BacktestEngine();

    // Backtest port closes over market + strategyRegistry + engine
    this.backtest = this.createBacktestPort();
  }

  isPaperTrading(): boolean {
    return this.mode === "paper";
  }

  isBacktest(): boolean {
    return this.mode === "backtest";
  }

  assertPaperOnly(): void {
    if (this.mode !== "paper" && this.mode !== "backtest") {
      throw new Error("Live trading is disabled — Finance Environment is paper/backtest only");
    }
  }

  getBus(): TypedEventBus {
    return this.bus;
  }

  getEngine(): BacktestEngine {
    return this.engine;
  }

  private createBacktestPort(): BacktestPort {
    return {
      run: async (params) => this.runBacktest(params),
      runWithMarketData: async (params) => this.runWithMarketData(params),
    };
  }

  private async runBacktest(params: {
    strategyId: string;
    symbol: string;
    timeframe?: string;
    candles: BacktestCandle[];
    initialCapital?: number;
  }): Promise<BacktestResult> {
    const { strategyId, symbol, timeframe, candles, initialCapital } = params;
    if (!strategyId) throw new Error("strategyId is required");
    if (!symbol) throw new Error("symbol is required");
    if (!Array.isArray(candles) || candles.length === 0) throw new Error("candles is required");

    const registry = this.strategyRegistry;
    if (!registry) throw new Error("Strategy registry not configured for backtesting");
    const strategy = registry.get(strategyId);
    if (!strategy) throw new Error(`Strategy '${strategyId}' not found`);

    const engine = initialCapital !== undefined ? new BacktestEngine({ initialCapital }) : this.engine;
    const result = engine.run(strategy, candles, symbol.toUpperCase(), timeframe ?? "1m");

    this.bus.publish({
      type: "backtest.completed",
      data: {
        strategyId,
        symbol: symbol.toUpperCase(),
        timeframe: timeframe ?? "1m",
        result: {
          totalReturn: result.totalReturn,
          tradeCount: result.tradeCount,
          winRate: result.winRate,
        },
        timestamp: Date.now(),
      },
      source: "finance-environment",
    });

    return result;
  }

  private async runWithMarketData(params: {
    strategyId: string;
    symbol: string;
    timeframe?: string;
    limit?: number;
    initialCapital?: number;
  }): Promise<BacktestResult> {
    const { strategyId, symbol, timeframe, limit, initialCapital } = params;
    const tf = timeframe ?? "1m";
    const lim = Math.min(Math.max(limit ?? 100, 10), 500);
    const ohlcv = await this.market.getOHLCV(symbol, tf, lim);
    const candles: BacktestCandle[] = ohlcv.map((b) => ({
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      timestamp: b.timestamp,
    }));
    return this.runBacktest({ strategyId, symbol, timeframe: tf, candles, initialCapital });
  }
}
