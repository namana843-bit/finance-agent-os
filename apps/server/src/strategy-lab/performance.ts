// ============================================================================
// Strategy Lab — Performance Analysis
// Pure function: BacktestResult -> PerformanceAnalysis
// Reuses BacktestEngine output; no I/O, fully testable.
// ============================================================================

import type { BacktestResult } from "../backtesting/backtest-engine.js";
import type { PerformanceAnalysis, LabConfig } from "./types.js";
import { DEFAULT_LAB_CONFIG } from "./types.js";

export function analyzePerformance(
  result: BacktestResult,
  config: Partial<LabConfig> = {},
): PerformanceAnalysis {
  const cfg = { ...DEFAULT_LAB_CONFIG, ...config };

  const wins = result.trades.filter((t) => t.pnl > 0);
  const losses = result.trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = result.trades.length > 0 ? (wins.length * avgWin - losses.length * avgLoss) / result.trades.length : 0;

  const reasons: string[] = [];
  let verdict: PerformanceAnalysis["verdict"] = "pass";

  if (result.tradeCount < cfg.minTrades) {
    reasons.push(`tradeCount ${result.tradeCount} < min ${cfg.minTrades}`);
    verdict = "fail";
  }
  if (result.totalReturn < cfg.minTotalReturn) {
    reasons.push(`totalReturn ${result.totalReturn.toFixed(2)}% < min ${cfg.minTotalReturn}%`);
    verdict = "fail";
  }
  if (result.maxDrawdown > cfg.maxDrawdown) {
    reasons.push(`maxDrawdown ${result.maxDrawdown.toFixed(2)}% > max ${cfg.maxDrawdown}%`);
    verdict = verdict === "pass" ? "fail" : verdict;
  }
  if (result.sharpeRatio < cfg.minSharpe) {
    reasons.push(`sharpe ${result.sharpeRatio.toFixed(2)} < min ${cfg.minSharpe}`);
    // sharpe is informational; don't hard-fail if trades are profitable
    if (verdict === "pass" && result.totalReturn < 0) verdict = "fail";
    else if (verdict === "pass" && result.tradeCount >= cfg.minTrades) reasons.push(`(sharpe low but not failing)`);
  }
  if (result.winRate < cfg.minWinRate) {
    reasons.push(`winRate ${(result.winRate * 100).toFixed(1)}% < min ${(cfg.minWinRate * 100).toFixed(1)}%`);
    if (profitFactor < cfg.minProfitFactor) verdict = "fail";
  }
  if (profitFactor < cfg.minProfitFactor) {
    reasons.push(`profitFactor ${profitFactor.toFixed(2)} < min ${cfg.minProfitFactor}`);
    if (verdict === "pass" && result.totalReturn < 0) verdict = "fail";
  }
  if (result.tradeCount === 0) {
    reasons.push("no trades executed — inconclusive");
    verdict = "inconclusive";
  }
  if (verdict === "pass" && reasons.length === 0) reasons.push("all performance thresholds passed");

  return {
    strategyId: result.strategyId,
    symbol: result.symbol,
    timeframe: result.timeframe,
    totalReturn: result.totalReturn,
    totalPnl: result.totalPnl,
    winRate: result.winRate,
    lossRate: result.lossRate,
    maxDrawdown: result.maxDrawdown,
    sharpeRatio: result.sharpeRatio,
    tradeCount: result.tradeCount,
    totalFees: result.totalFees,
    profitFactor,
    avgWin,
    avgLoss,
    expectancy,
    grossProfit,
    grossLoss,
    equityCurve: [...result.equityCurve],
    startDate: result.startDate,
    endDate: result.endDate,
    verdict,
    reasons,
  };
}
