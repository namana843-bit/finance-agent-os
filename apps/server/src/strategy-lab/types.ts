// ============================================================================
// Strategy Lab — Types
// Workflow: Strategy Idea -> Strategy -> Backtest -> Performance Analysis
//           -> Risk Analysis -> Paper Trading Candidate
// ============================================================================

import type { BacktestResult, BacktestCandle } from "../backtesting/backtest-engine.js";

export type LabStrategyKind = "ema-crossover" | "rsi-reversal" | "macd-crossover" | "momentum" | string;

export interface StrategyIdea {
  id: string;
  rawIdea: string;
  symbol: string;
  timeframe: string;
  strategyKind: LabStrategyKind;
  parameters: Record<string, unknown>;
  createdAt: number;
}

export type IdeaInput =
  | string
  | {
      idea?: string;
      rawIdea?: string;
      symbol?: string;
      timeframe?: string;
      strategyKind?: LabStrategyKind;
      strategyId?: string;
      parameters?: Record<string, unknown>;
    };

export interface LabConfig {
  initialCapital: number;
  timeframe: string;
  candleLimit: number;
  minTrades: number;
  minWinRate: number;
  minSharpe: number;
  maxDrawdown: number; // percent, e.g. 25 = 25%
  minTotalReturn: number; // percent
  minProfitFactor: number;
  feeRate: number;
  slippage: number;
}

export const DEFAULT_LAB_CONFIG: LabConfig = {
  initialCapital: 100_000,
  timeframe: "1h",
  candleLimit: 200,
  minTrades: 5,
  minWinRate: 0.4,
  minSharpe: 0.3,
  maxDrawdown: 30,
  minTotalReturn: -10,
  minProfitFactor: 0.9,
  feeRate: 0.001,
  slippage: 0.0005,
};

export interface PerformanceAnalysis {
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
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  grossProfit: number;
  grossLoss: number;
  equityCurve: number[];
  startDate: number;
  endDate: number;
  verdict: "pass" | "fail" | "inconclusive";
  reasons: string[];
}

export interface RiskAnalysis {
  decision: "APPROVED" | "REJECTED";
  reasons: string[];
  checks: string[];
  riskScore: number; // 0-100, higher = riskier
  metrics: {
    maxDrawdown: number;
    sharpe: number;
    winRate: number;
    tradeCount: number;
    profitFactor: number;
    totalReturn: number;
  };
}

export interface PaperCandidate {
  approved: boolean;
  readyForPaper: boolean;
  strategyId: string;
  ideaId: string;
  symbol: string;
  reason: string;
  performance: PerformanceAnalysis;
  risk: RiskAnalysis;
  backtest: BacktestResult;
}

export interface LabRun {
  id: string;
  idea: StrategyIdea;
  strategyId: string;
  backtest: BacktestResult;
  performance: PerformanceAnalysis;
  risk: RiskAnalysis;
  candidate: PaperCandidate;
  status: "completed" | "failed";
  createdAt: number;
  completedAt: number;
  durationMs: number;
  candlesUsed: number;
  error?: string;
}

// Event type helpers for bus
export const LAB_EVENTS = {
  IDEA_CREATED: "strategy-lab.idea_created",
  STRATEGY_CREATED: "strategy-lab.strategy_created",
  BACKTEST_COMPLETED: "strategy-lab.backtest_completed",
  PERFORMANCE_COMPLETED: "strategy-lab.performance_completed",
  RISK_COMPLETED: "strategy-lab.risk_completed",
  CANDIDATE_APPROVED: "strategy-lab.candidate_approved",
  CANDIDATE_REJECTED: "strategy-lab.candidate_rejected",
  RUN_COMPLETED: "strategy-lab.run_completed",
  RUN_FAILED: "strategy-lab.run_failed",
} as const;
