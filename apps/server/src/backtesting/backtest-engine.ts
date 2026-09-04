// ============================================================================
// Finance Agent OS — Backtesting Engine
// Phase 19: Backtest strategies against historical data
// ============================================================================

import type { StrategyInstance, StrategyResult } from "../strategies/strategy-registry.js";

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
}

export class BacktestEngine {
  private initialCapital = 100_000;
  private feeRate = 0.001;
  private slippage = 0.0005;

  constructor(params?: { initialCapital?: number; feeRate?: number; slippage?: number }) {
    if (params?.initialCapital) this.initialCapital = params.initialCapital;
    if (params?.feeRate) this.feeRate = params.feeRate;
    if (params?.slippage) this.slippage = params.slippage;
  }

  run(
    strategy: StrategyInstance,
    candles: BacktestCandle[],
    symbol: string,
    timeframe: string = "1m",
    lookback: number = 30,
  ): BacktestResult {
    let capital = this.initialCapital;
    let position: { side: "buy" | "sell"; entryPrice: number; quantity: number } | null = null;
    const trades: BacktestTrade[] = [];
    const equityCurve: number[] = [];
    let peakEquity = capital;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    let totalFees = 0;

    for (let i = lookback; i < candles.length; i++) {
      const window = candles.slice(i - lookback, i + 1).map((c) => c.close);
      const result: StrategyResult = strategy.calculate(window);
      const candle = candles[i]!;

      // Check for exit signal
      if (position) {
        const shouldExit =
          (position.side === "buy" && result.side === "sell") ||
          (position.side === "sell" && result.side === "buy");

        if (shouldExit) {
          let exitPrice = candle.close;
          if (position.side === "buy") {
            exitPrice *= 1 - this.slippage;
          } else {
            exitPrice *= 1 + this.slippage;
          }

          const fee = exitPrice * position.quantity * this.feeRate;
          let pnl: number;
          if (position.side === "buy") {
            pnl = (exitPrice - position.entryPrice) * position.quantity - fee;
          } else {
            pnl = (position.entryPrice - exitPrice) * position.quantity - fee;
          }

          capital += pnl + position.entryPrice * position.quantity;
          totalFees += fee;

          trades.push({
            entryPrice: position.entryPrice,
            exitPrice,
            side: position.side,
            quantity: position.quantity,
            pnl,
            fees: fee,
            entryTime: candle.timestamp - 60000 * lookback,
            exitTime: candle.timestamp,
          });

          if (pnl > 0) wins++;
          else losses++;

          position = null;
        }
      }

      // Check for entry signal
      if (!position && result.side !== "hold" && result.confidence > 0.5) {
        let entryPrice = candle.close;
        if (result.side === "buy") {
          entryPrice *= 1 + this.slippage;
        } else {
          entryPrice *= 1 - this.slippage;
        }

        const riskAmount = capital * 0.01; // 1% risk
        const quantity = Math.floor(riskAmount / entryPrice);

        if (quantity > 0 && entryPrice * quantity < capital * 0.5) {
          const fee = entryPrice * quantity * this.feeRate;
          capital -= entryPrice * quantity + fee;
          totalFees += fee;

          position = {
            side: result.side as "buy" | "sell",
            entryPrice,
            quantity,
          };
        }
      }

      // Track equity
      let equity = capital;
      if (position) {
        const unrealized = position.side === "buy"
          ? (candle.close - position.entryPrice) * position.quantity
          : (position.entryPrice - candle.close) * position.quantity;
        equity += position.entryPrice * position.quantity + unrealized;
      }

      equityCurve.push(equity);

      if (equity > peakEquity) peakEquity = equity;
      const drawdown = ((peakEquity - equity) / peakEquity) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Calculate stats
    const totalPnl = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]! - this.initialCapital : 0;
    const totalReturn = (totalPnl / this.initialCapital) * 100;

    // Sharpe ratio (simplified)
    const returns = equityCurve.slice(1).map((eq, i) => (eq - equityCurve[i]!) / equityCurve[i]!);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn = returns.length > 0
      ? Math.sqrt(returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length)
      : 1;
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const lossRate = totalTrades > 0 ? losses / totalTrades : 0;

    return {
      strategyId: strategy.config.id,
      symbol,
      timeframe,
      totalReturn,
      totalPnl,
      winRate,
      lossRate,
      maxDrawdown,
      sharpeRatio,
      tradeCount: totalTrades,
      totalFees,
      equityCurve,
      trades,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? 0,
    };
  }
}
