// ============================================================================
// Finance Agent OS — Trustworthy Backtesting Engine
// Phase 7 & Phase 19: Backtest strategies against historical candle data
// Features:
// - Zero Look-Ahead Bias: strict sequential iteration, strategy only accesses
//   bars[0..currentIndex], execution simulated at next bar open or current close.
// - Realistic Execution: Slippage, Bid/Ask spread, Maker/Taker fees, and volume limits.
// - Institutional Metrics: Sharpe, Sortino, CAGR, Max Drawdown & Duration, Profit Factor.
// ============================================================================

import type { StrategyInstance, StrategyResult } from "../strategies/strategy-registry.js";
import {
  ExecutionSimulator,
  type ExecutionConfig,
  type SimulatedOrder,
  DEFAULT_EXECUTION_CONFIG,
} from "./execution-simulator.js";
import { calculateBacktestMetrics, type ExtendedBacktestMetrics } from "./metrics.js";

export interface BacktestCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  side: "buy" | "sell";
  quantity: number;
  pnl: number;
  fees: number;
  entryTime: number;
  exitTime: number;
}

export interface BacktestResult {
  strategyId: string;
  symbol: string;
  timeframe: string;
  totalReturn: number;
  totalPnl: number;
  winRate: number;
  lossRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  tradeCount: number;
  totalFees: number;
  equityCurve: number[];
  trades: BacktestTrade[];
  startDate: number;
  endDate: number;

  // Extended Phase 7 Trustworthy Metrics
  cagr?: number;
  sortinoRatio?: number;
  profitFactor?: number;
  annualizedVolatility?: number;
  winningTrades?: number;
  losingTrades?: number;
  maxDrawdownDurationMs?: number;
  avgTradePnl?: number;
  avgWin?: number;
  avgLoss?: number;
  winLossRatio?: number;
  expectancy?: number;
}

export interface BacktestEngineConfig {
  initialCapital?: number;
  feeRate?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  slippage?: number;
  slippageBps?: number;
  spreadBps?: number;
  maxVolumeParticipation?: number;
  executionMode?: "next_bar_open" | "current_bar_close";
  riskPerTradePct?: number; // default 0.01 (1%)
}

export class BacktestEngine {
  private initialCapital = 100_000;
  private simulator: ExecutionSimulator;
  private executionMode: "next_bar_open" | "current_bar_close";
  private riskPerTradePct = 0.01;

  constructor(params?: BacktestEngineConfig) {
    if (params?.initialCapital) this.initialCapital = params.initialCapital;
    if (params?.riskPerTradePct) this.riskPerTradePct = params.riskPerTradePct;
    this.executionMode = params?.executionMode ?? "current_bar_close";

    // Map feeRate and slippage to simulator config
    const slippageBps = params?.slippageBps ?? (params?.slippage ? params.slippage * 10_000 : DEFAULT_EXECUTION_CONFIG.slippageBps);
    const takerFeeRate = params?.takerFeeRate ?? params?.feeRate ?? DEFAULT_EXECUTION_CONFIG.takerFeeRate;
    const makerFeeRate = params?.makerFeeRate ?? takerFeeRate * 0.5;
    const spreadBps = params?.spreadBps ?? DEFAULT_EXECUTION_CONFIG.spreadBps;
    const maxVolumeParticipation = params?.maxVolumeParticipation ?? DEFAULT_EXECUTION_CONFIG.maxVolumeParticipation;

    this.simulator = new ExecutionSimulator({
      slippageBps,
      spreadBps,
      makerFeeRate,
      takerFeeRate,
      maxVolumeParticipation,
    });
  }

  getSimulator(): ExecutionSimulator {
    return this.simulator;
  }

  run(
    strategy: StrategyInstance,
    candles: BacktestCandle[],
    symbol: string,
    timeframe: string = "1m",
    lookback: number = 30,
  ): BacktestResult {
    if (!candles || candles.length === 0) {
      return {
        strategyId: strategy?.config?.id ?? "unknown",
        symbol,
        timeframe,
        totalReturn: 0,
        totalPnl: 0,
        winRate: 0,
        lossRate: 0,
        maxDrawdown: 0,
        sharpeRatio: 0,
        tradeCount: 0,
        totalFees: 0,
        equityCurve: [this.initialCapital],
        trades: [],
        startDate: 0,
        endDate: 0,
        cagr: 0,
        sortinoRatio: 0,
        profitFactor: 0,
      };
    }

    let capital = this.initialCapital;
    let position: { side: "buy" | "sell"; entryPrice: number; quantity: number; entryTime: number } | null = null;
    const trades: BacktestTrade[] = [];
    const equityCurve: number[] = [];
    let pendingOrder: SimulatedOrder | null = null;

    // Sequential chronological iteration to eliminate look-ahead bias
    for (let i = lookback; i < candles.length; i++) {
      const candle = candles[i]!;

      // 1. Execute pending orders scheduled from previous bar (next_bar_open mode)
      if (this.executionMode === "next_bar_open" && pendingOrder) {
        if (position) {
          // Exit execution
          const fill = this.simulator.fillMarketOrder(pendingOrder, candle, capital, candle.open);
          if (fill.filled) {
            const exitPrice = fill.fillPrice;
            const fee = fill.fee;
            let pnl: number;
            if (position.side === "buy") {
              pnl = (exitPrice - position.entryPrice) * position.quantity - fee;
            } else {
              pnl = (position.entryPrice - exitPrice) * position.quantity - fee;
            }

            capital += pnl + position.entryPrice * position.quantity;
            trades.push({
              entryPrice: position.entryPrice,
              exitPrice,
              side: position.side,
              quantity: position.quantity,
              pnl,
              fees: fee,
              entryTime: position.entryTime,
              exitTime: candle.timestamp,
            });
            position = null;
          }
        } else {
          // Entry execution
          const fill = this.simulator.fillMarketOrder(pendingOrder, candle, capital, candle.open);
          if (fill.filled && fill.filledQuantity > 0) {
            const entryPrice = fill.fillPrice;
            const fee = fill.fee;
            capital -= (entryPrice * fill.filledQuantity + fee);
            position = {
              side: pendingOrder.side,
              entryPrice,
              quantity: fill.filledQuantity,
              entryTime: candle.timestamp,
            };
          }
        }
        pendingOrder = null;
      }

      // 2. Strict Zero Look-ahead Strategy Evaluation
      // The strategy is passed only historical window up to current index i
      const window = candles.slice(Math.max(0, i - lookback), i + 1).map((c) => c.close);
      const result: StrategyResult = strategy.calculate(window);

      // 3. Signal handling & order generation
      if (position) {
        const shouldExit =
          (position.side === "buy" && result.side === "sell") ||
          (position.side === "sell" && result.side === "buy");

        if (shouldExit) {
          if (this.executionMode === "next_bar_open") {
            // Schedule exit at next bar's open (zero look-ahead)
            pendingOrder = {
              symbol,
              side: position.side === "buy" ? "sell" : "buy",
              type: "market",
              quantity: position.quantity,
              timestamp: candle.timestamp,
            };
          } else {
            // Fill immediately at current bar close with slippage/spread
            const fill = this.simulator.fillMarketOrder(
              {
                symbol,
                side: position.side === "buy" ? "sell" : "buy",
                type: "market",
                quantity: position.quantity,
                timestamp: candle.timestamp,
              },
              candle,
              capital,
              candle.close
            );

            if (fill.filled) {
              const exitPrice = fill.fillPrice;
              const fee = fill.fee;
              let pnl: number;
              if (position.side === "buy") {
                pnl = (exitPrice - position.entryPrice) * position.quantity - fee;
              } else {
                pnl = (position.entryPrice - exitPrice) * position.quantity - fee;
              }

              capital += pnl + position.entryPrice * position.quantity;
              trades.push({
                entryPrice: position.entryPrice,
                exitPrice,
                side: position.side,
                quantity: position.quantity,
                pnl,
                fees: fee,
                entryTime: position.entryTime,
                exitTime: candle.timestamp,
              });
              position = null;
            }
          }
        }
      }

      // Check for entry signal if no active position and no pending order
      if (!position && !pendingOrder && result.side !== "hold" && result.confidence > 0.5) {
        const riskAmount = capital * this.riskPerTradePct;
        const approxPrice = candle.close;
        const targetQuantity = approxPrice > 0 ? Math.floor(riskAmount / approxPrice) : 0;

        if (targetQuantity > 0 && approxPrice * targetQuantity < capital * 0.5) {
          if (this.executionMode === "next_bar_open") {
            // Schedule entry for next bar's open
            pendingOrder = {
              symbol,
              side: result.side as "buy" | "sell",
              type: "market",
              quantity: targetQuantity,
              timestamp: candle.timestamp,
            };
          } else {
            // Fill immediately at current bar close with realistic simulation
            const fill = this.simulator.fillMarketOrder(
              {
                symbol,
                side: result.side as "buy" | "sell",
                type: "market",
                quantity: targetQuantity,
                timestamp: candle.timestamp,
              },
              candle,
              capital,
              candle.close
            );

            if (fill.filled && fill.filledQuantity > 0) {
              const entryPrice = fill.fillPrice;
              const fee = fill.fee;
              capital -= (entryPrice * fill.filledQuantity + fee);
              position = {
                side: result.side as "buy" | "sell",
                entryPrice,
                quantity: fill.filledQuantity,
                entryTime: candle.timestamp,
              };
            }
          }
        }
      }

      // 4. Track mark-to-market equity at end of bar
      let equity = capital;
      if (position) {
        const unrealized = position.side === "buy"
          ? (candle.close - position.entryPrice) * position.quantity
          : (position.entryPrice - candle.close) * position.quantity;
        equity += position.entryPrice * position.quantity + unrealized;
      }
      equityCurve.push(equity);
    }

    // 5. Calculate comprehensive metrics
    const metrics: ExtendedBacktestMetrics = calculateBacktestMetrics({
      initialCapital: this.initialCapital,
      equityCurve,
      trades,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? 0,
    });

    return {
      strategyId: strategy.config.id,
      symbol,
      timeframe,
      totalReturn: metrics.totalReturn,
      totalPnl: metrics.totalPnl,
      winRate: metrics.winRate,
      lossRate: metrics.lossRate,
      maxDrawdown: metrics.maxDrawdown,
      sharpeRatio: metrics.sharpeRatio,
      tradeCount: metrics.tradeCount,
      totalFees: metrics.totalFees,
      equityCurve,
      trades,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? 0,
      // Extended Phase 7 fields
      cagr: metrics.cagr,
      sortinoRatio: metrics.sortinoRatio,
      profitFactor: metrics.profitFactor,
      annualizedVolatility: metrics.annualizedVolatility,
      winningTrades: metrics.winningTrades,
      losingTrades: metrics.losingTrades,
      maxDrawdownDurationMs: metrics.maxDrawdownDurationMs,
      avgTradePnl: metrics.avgTradePnl,
      avgWin: metrics.avgWin,
      avgLoss: metrics.avgLoss,
      winLossRatio: metrics.winLossRatio,
      expectancy: metrics.expectancy,
    };
  }
}
