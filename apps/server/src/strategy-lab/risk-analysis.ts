// ============================================================================
// Strategy Lab — Risk Analysis
// Pure function: BacktestResult + PerformanceAnalysis -> RiskAnalysis
// Paper-only, deterministic thresholds. No live orders.
// ============================================================================

import type { BacktestResult } from "../backtesting/backtest-engine.js";
import type { RiskAnalysis, PerformanceAnalysis, LabConfig } from "./types.js";
import { DEFAULT_LAB_CONFIG } from "./types.js";

export function analyzeRisk(
  result: BacktestResult,
  performance: PerformanceAnalysis,
  config: Partial<LabConfig> = {},
): RiskAnalysis {
  const cfg = { ...DEFAULT_LAB_CONFIG, ...config };
  const checks: string[] = [];
  const reasons: string[] = [];
  let riskScore = 0; // 0 safe .. 100 risky
  let decision: RiskAnalysis["decision"] = "APPROVED";

  // 1. Drawdown check
  checks.push("max_drawdown");
  if (result.maxDrawdown > cfg.maxDrawdown) {
    reasons.push(`Drawdown ${result.maxDrawdown.toFixed(2)}% exceeds max ${cfg.maxDrawdown}%`);
    riskScore += 35;
    decision = "REJECTED";
  } else if (result.maxDrawdown > cfg.maxDrawdown * 0.7) {
    reasons.push(`Drawdown ${result.maxDrawdown.toFixed(2)}% in warning zone (70% of max)`);
    riskScore += 15;
  }

  // 2. Sharpe check
  checks.push("sharpe");
  if (result.sharpeRatio < 0) {
    reasons.push(`Negative Sharpe ${result.sharpeRatio.toFixed(2)}`);
    riskScore += 20;
    // not auto-reject unless also losing
  } else if (result.sharpeRatio < cfg.minSharpe) {
    reasons.push(`Sharpe ${result.sharpeRatio.toFixed(2)} below min ${cfg.minSharpe}`);
    riskScore += 10;
  }

  // 3. Trade count
  checks.push("trade_count");
  if (result.tradeCount < cfg.minTrades) {
    reasons.push(`Too few trades ${result.tradeCount} < ${cfg.minTrades} — sample insufficient`);
    riskScore += 25;
    decision = "REJECTED";
  }

  // 4. Win rate
  checks.push("win_rate");
  if (result.winRate < cfg.minWinRate) {
    reasons.push(`Win rate ${(result.winRate * 100).toFixed(1)}% < ${(cfg.minWinRate * 100).toFixed(1)}%`);
    riskScore += 15;
  }

  // 5. Profit factor
  checks.push("profit_factor");
  if (performance.profitFactor < cfg.minProfitFactor) {
    reasons.push(`Profit factor ${performance.profitFactor.toFixed(2)} < ${cfg.minProfitFactor}`);
    riskScore += 15;
    if (performance.profitFactor < 0.8) decision = "REJECTED";
  }

  // 6. Total return / tail risk
  checks.push("total_return");
  if (result.totalReturn < cfg.minTotalReturn) {
    reasons.push(`Total return ${result.totalReturn.toFixed(2)}% < ${cfg.minTotalReturn}%`);
    riskScore += 20;
    if (result.totalReturn < -20) decision = "REJECTED";
  }

  // 7. Exposure proxy: maxDrawdown / (winRate+epsilon) — high drawdown with low winrate = risky
  checks.push("exposure_proxy");
  const exposureProxy = result.maxDrawdown / Math.max(result.winRate, 0.1);
  if (exposureProxy > 80) {
    reasons.push(`Exposure proxy ${exposureProxy.toFixed(1)} high (drawdown/winRate)`);
    riskScore += 10;
  }

  riskScore = Math.min(100, Math.max(0, Math.round(riskScore)));

  if (decision === "APPROVED" && riskScore >= 60) {
    decision = "REJECTED";
    reasons.push(`Aggregate riskScore ${riskScore} >= 60 — rejected`);
  }

  if (decision === "APPROVED" && reasons.length === 0) reasons.push("All risk checks passed");
  if (decision === "APPROVED" && reasons.length > 0 && riskScore < 60) {
    // warnings but still approved — keep reasons but ensure at least one positive
    if (!reasons.some((r) => r.includes("passed"))) reasons.unshift("Approved with warnings");
  }

  return {
    decision,
    reasons,
    checks,
    riskScore,
    metrics: {
      maxDrawdown: result.maxDrawdown,
      sharpe: result.sharpeRatio,
      winRate: result.winRate,
      tradeCount: result.tradeCount,
      profitFactor: performance.profitFactor,
      totalReturn: result.totalReturn,
    },
  };
}
