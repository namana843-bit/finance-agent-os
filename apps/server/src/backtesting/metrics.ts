// ============================================================================
// Finance Agent OS — Trustworthy Backtest Performance Metrics
// Phase 7: Reproducible, institutional-grade financial metrics calculation.
// Sharpe (annualized), Sortino, CAGR, Max Drawdown & Duration, Profit Factor,
// Win Rate, Volatility, and Expectancy.
// ============================================================================

import type { BacktestTrade } from "./backtest-engine.js";

export interface ExtendedBacktestMetrics {
  totalReturn: number; // percentage, e.g. 15.5%
  totalPnl: number; // currency amount
  cagr: number; // Compound Annual Growth Rate (%)
  annualizedVolatility: number; // Annualized standard deviation of returns (%)
  sharpeRatio: number; // Annualized Sharpe Ratio
  sortinoRatio: number; // Annualized Sortino Ratio (downside deviation only)
  maxDrawdown: number; // Peak to trough drawdown (%)
  maxDrawdownDurationMs: number; // Max duration of drawdown period in ms
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number; // e.g. 0.60 (60%)
  lossRate: number; // e.g. 0.40 (40%)
  profitFactor: number; // Gross profits / Gross losses
  totalFees: number;
  avgTradePnl: number;
  avgWin: number;
  avgLoss: number;
  winLossRatio: number; // avgWin / avgLoss
  expectancy: number; // Expected PnL per trade
}

export interface MetricCalculationInput {
  initialCapital: number;
  equityCurve: number[];
  trades: BacktestTrade[];
  startDate: number;
  endDate: number;
  riskFreeRate?: number; // annual risk-free rate, default 0
  annualizationFactor?: number; // e.g. 252 for daily, 365 for crypto 24/7 (default 365)
}

/**
 * Calculates standardized, reproducible financial performance metrics for backtests.
 */
export function calculateBacktestMetrics(input: MetricCalculationInput): ExtendedBacktestMetrics {
  const {
    initialCapital,
    equityCurve,
    trades,
    startDate,
    endDate,
    riskFreeRate = 0,
    annualizationFactor = 365,
  } = input;

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]! : initialCapital;
  const totalPnl = finalEquity - initialCapital;
  const totalReturn = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

  // 1. CAGR (Compound Annual Growth Rate)
  const durationMs = Math.max(1, endDate - startDate);
  const years = durationMs / (365.25 * 24 * 60 * 60 * 1000);
  let cagr = 0;
  if (years > 0 && initialCapital > 0 && finalEquity > 0) {
    cagr = (Math.pow(finalEquity / initialCapital, 1 / Math.max(years, 0.01)) - 1) * 100;
  } else if (finalEquity <= 0) {
    cagr = -100;
  }

  // 2. Returns & Volatility
  const periodicReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!;
    const curr = equityCurve[i]!;
    if (prev > 0) {
      periodicReturns.push((curr - prev) / prev);
    }
  }

  const n = periodicReturns.length;
  let meanReturn = 0;
  let variance = 0;
  let downsideVariance = 0;

  if (n > 0) {
    meanReturn = periodicReturns.reduce((sum, r) => sum + r, 0) / n;
    variance = periodicReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (n > 1 ? n - 1 : 1);
    downsideVariance = periodicReturns.reduce((sum, r) => {
      const diff = Math.min(0, r - (riskFreeRate / annualizationFactor));
      return sum + Math.pow(diff, 2);
    }, 0) / (n > 1 ? n - 1 : 1);
  }

  const stdDev = Math.sqrt(variance);
  const downsideStdDev = Math.sqrt(downsideVariance);
  const annualizedVolatility = stdDev * Math.sqrt(annualizationFactor) * 100;

  // 3. Sharpe & Sortino
  const annualizedMean = meanReturn * annualizationFactor;
  const annualizedDownsideStdDev = downsideStdDev * Math.sqrt(annualizationFactor);

  const sharpeRatio =
    annualizedVolatility > 0
      ? (annualizedMean - riskFreeRate) / (annualizedVolatility / 100)
      : 0;

  const sortinoRatio =
    annualizedDownsideStdDev > 0
      ? (annualizedMean - riskFreeRate) / annualizedDownsideStdDev
      : sharpeRatio;

  // 4. Max Drawdown & Drawdown Duration
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownDurationMs = 0;
  let peakTime = startDate;

  for (let i = 0; i < equityCurve.length; i++) {
    const eq = equityCurve[i]!;
    // Estimate timestamp if available or evenly spaced
    const t = startDate + (durationMs * i) / Math.max(equityCurve.length - 1, 1);

    if (eq > peak) {
      peak = eq;
      peakTime = t;
    } else {
      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
      const duration = t - peakTime;
      if (duration > maxDrawdownDurationMs) maxDrawdownDurationMs = duration;
    }
  }

  // 5. Trade Analysis
  const totalTrades = trades.length;
  const winningTradesList = trades.filter((t) => t.pnl > 0);
  const losingTradesList = trades.filter((t) => t.pnl <= 0);

  const winningTrades = winningTradesList.length;
  const losingTrades = losingTradesList.length;

  const grossProfit = winningTradesList.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTradesList.reduce((sum, t) => sum + t.pnl, 0));

  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const lossRate = totalTrades > 0 ? losingTrades / totalTrades : 0;

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : winningTrades > 0 ? 999 : 0;
  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);

  const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 999 : 0;
  const avgTradePnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const expectancy = totalTrades > 0 ? (winRate * avgWin) - (lossRate * avgLoss) : 0;

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    cagr: Math.round(cagr * 100) / 100,
    annualizedVolatility: Math.round(annualizedVolatility * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownDurationMs: Math.round(maxDrawdownDurationMs),
    tradeCount: totalTrades,
    winningTrades,
    losingTrades,
    winRate: Math.round(winRate * 1000) / 1000,
    lossRate: Math.round(lossRate * 1000) / 1000,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    avgTradePnl: Math.round(avgTradePnl * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    winLossRatio: Math.round(winLossRatio * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
  };
}
