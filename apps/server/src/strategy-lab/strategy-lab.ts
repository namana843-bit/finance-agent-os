// ============================================================================
// Strategy Lab — Orchestrator
// Workflow: Idea -> Strategy -> Backtest -> Performance Analysis
//           -> Risk Analysis -> Paper Trading Candidate
// Reuses: BacktestEngine, StrategyRegistry (modular), FinanceEnvironment
// No live orders — paper/backtest only. Fully event-driven via TypedEventBus.
// ============================================================================

import { TypedEventBus } from "@finance/core";
import type { StrategyRegistry } from "../strategies/strategy-registry.js";
import { BacktestEngine, type BacktestResult, type BacktestCandle } from "../backtesting/backtest-engine.js";
import type { MarketDataPort } from "../environment/types.js";
import { createStrategyFromIdea, isSupportedKind, getSupportedKinds } from "./strategy-factory.js";
import { analyzePerformance } from "./performance.js";
import { analyzeRisk } from "./risk-analysis.js";
import type {
  StrategyIdea,
  IdeaInput,
  LabConfig,
  PerformanceAnalysis,
  RiskAnalysis,
  PaperCandidate,
  LabRun,
} from "./types.js";
import { DEFAULT_LAB_CONFIG, LAB_EVENTS } from "./types.js";

// ---------------------------------------------------------------------------
// Idea parsing — deterministic, no LLM
// ---------------------------------------------------------------------------

const KNOWN_KINDS: Record<string, string> = {
  ema: "ema-crossover",
  "ema-crossover": "ema-crossover",
  rsi: "rsi-reversal",
  "rsi-reversal": "rsi-reversal",
  macd: "macd-crossover",
  "macd-crossover": "macd-crossover",
  momentum: "momentum",
};

const SYMBOL_BLOCKLIST = new Set(["EMA", "RSI", "MACD", "SMA", "CROSSOVER", "REVERSAL", "MOMENTUM", "ON", "WITH", "FOR", "AND", "THE", "FROM", "USING", "PERIOD", "FAST", "SLOW", "CROSS", "BUY", "SELL", "HOLD"]);
const SYMBOL_MAP: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", BNB: "BNBUSDT", SOL: "SOLUSDT" };

function extractSymbol(raw: string): string {
  // Collect all candidate tokens, pick first non-blocklisted real symbol
  const upper = raw.toUpperCase();
  const tokens = upper.match(/\b([A-Z]{2,10}USDT|[A-Z]{2,5})\b/g) ?? [];
  for (const tok of tokens) {
    if (SYMBOL_BLOCKLIST.has(tok)) continue;
    if (tok.endsWith("USDT")) return tok;
    if (SYMBOL_MAP[tok]) return SYMBOL_MAP[tok]!;
    // Single unknown tokens like "BTC" already handled via map; otherwise skip ambiguous
  }
  // Fallback: try last token that maps (prefer BTC/ETH/SOL)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i]!;
    if (SYMBOL_BLOCKLIST.has(tok)) continue;
    if (SYMBOL_MAP[tok]) return SYMBOL_MAP[tok]!;
  }
  return "BTCUSDT";
}

function extractTimeframe(raw: string): string | null {
  const m = raw.toLowerCase().match(/\b(\d+[mhdw]|tick)\b/);
  return m?.[1] ?? null;
}

function extractKind(raw: string): string {
  const lower = raw.toLowerCase();
  for (const [kw, kind] of Object.entries(KNOWN_KINDS)) {
    if (lower.includes(kw)) return kind;
  }
  // heuristic: oversold/overbought -> rsi, crossover -> ema/macd
  if (/oversold|overbought|rsi/.test(lower)) return "rsi-reversal";
  if (/macd/.test(lower)) return "macd-crossover";
  if (/momentum/.test(lower)) return "momentum";
  return "ema-crossover";
}

function extractParams(raw: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const lower = raw.toLowerCase();
  // fast 12 slow 26
  const fast = lower.match(/fast\D*(\d+)/); if (fast) params.fastPeriod = parseInt(fast[1]!, 10);
  const slow = lower.match(/slow\D*(\d+)/); if (slow) params.slowPeriod = parseInt(slow[1]!, 10);
  const period = lower.match(/period\D*(\d+)/); if (period) params.period = parseInt(period[1]!, 10);
  const ob = lower.match(/overbought\D*(\d+)/); if (ob) params.overbought = parseInt(ob[1]!, 10);
  const os = lower.match(/oversold\D*(\d+)/); if (os) params.oversold = parseInt(os[1]!, 10);
  return params;
}

let ideaSeq = 0;
function nextIdeaId(): string { ideaSeq += 1; return `idea-${Date.now()}-${ideaSeq}`; }
let runSeq = 0;
function nextRunId(): string { runSeq += 1; return `lab-run-${Date.now()}-${runSeq}`; }

// ---------------------------------------------------------------------------
// Lab
// ---------------------------------------------------------------------------

export interface StrategyLabOptions {
  bus?: TypedEventBus;
  strategyRegistry?: StrategyRegistry;
  market?: MarketDataPort;
  engine?: BacktestEngine;
  config?: Partial<LabConfig>;
}

export class StrategyLab {
  readonly id = "strategy-lab";
  private bus: TypedEventBus;
  private registry?: StrategyRegistry;
  private market?: MarketDataPort;
  private engine: BacktestEngine;
  private config: LabConfig;
  private ideas = new Map<string, StrategyIdea>();
  private runs = new Map<string, LabRun>();
  private labStrategyIds = new Set<string>();

  constructor(opts: StrategyLabOptions = {}) {
    this.bus = opts.bus ?? new TypedEventBus();
    this.registry = opts.strategyRegistry;
    this.market = opts.market;
    this.engine = opts.engine ?? new BacktestEngine({ initialCapital: opts.config?.initialCapital ?? DEFAULT_LAB_CONFIG.initialCapital, feeRate: opts.config?.feeRate ?? DEFAULT_LAB_CONFIG.feeRate, slippage: opts.config?.slippage ?? DEFAULT_LAB_CONFIG.slippage });
    this.config = { ...DEFAULT_LAB_CONFIG, ...opts.config };
  }

  getBus(): TypedEventBus { return this.bus; }
  getConfig(): LabConfig { return { ...this.config }; }
  updateConfig(patch: Partial<LabConfig>): void {
    this.config = { ...this.config, ...patch };
    this.engine = new BacktestEngine({ initialCapital: this.config.initialCapital, feeRate: this.config.feeRate, slippage: this.config.slippage });
  }

  // -------------------------------------------------------------------------
  // Idea — Strategy Idea -> normalised StrategyIdea
  // -------------------------------------------------------------------------

  parseIdea(input: IdeaInput): StrategyIdea {
    if (typeof input === "string") {
      const raw = input.trim();
      if (!raw) throw new Error("idea is required (non-empty string)");
      return {
        id: nextIdeaId(),
        rawIdea: raw,
        symbol: extractSymbol(raw),
        timeframe: extractTimeframe(raw) ?? this.config.timeframe,
        strategyKind: extractKind(raw),
        parameters: extractParams(raw),
        createdAt: Date.now(),
      };
    }
    const raw = (input.idea ?? input.rawIdea ?? "").trim();
    if (!raw) throw new Error("idea is required");
    const symbol = (input.symbol ?? extractSymbol(raw)).toUpperCase();
    const timeframe = input.timeframe ?? extractTimeframe(raw) ?? this.config.timeframe;
    const kind = input.strategyKind ?? input.strategyId ?? extractKind(raw);
    if (!isSupportedKind(kind)) throw new Error(`Unsupported strategy kind '${kind}'. Supported: ${getSupportedKinds().join(", ")}`);
    return {
      id: nextIdeaId(),
      rawIdea: raw,
      symbol,
      timeframe,
      strategyKind: kind,
      parameters: input.parameters ?? extractParams(raw),
      createdAt: Date.now(),
    };
  }

  submitIdea(input: IdeaInput): StrategyIdea {
    const idea = this.parseIdea(input);
    this.ideas.set(idea.id, idea);
    this.bus.publish({ type: LAB_EVENTS.IDEA_CREATED, data: { ideaId: idea.id, rawIdea: idea.rawIdea, symbol: idea.symbol, kind: idea.strategyKind, timeframe: idea.timeframe, timestamp: Date.now() }, source: "strategy-lab", correlationId: idea.id });
    return idea;
  }

  getIdea(id: string): StrategyIdea | undefined { return this.ideas.get(id); }
  listIdeas(): StrategyIdea[] { return [...this.ideas.values()]; }

  // -------------------------------------------------------------------------
  // Strategy — Idea -> modular StrategyInstance (registered)
  // -------------------------------------------------------------------------

  toStrategy(idea: StrategyIdea): ReturnType<typeof createStrategyFromIdea> {
    const strategy = createStrategyFromIdea(idea);
    // Register in registry if available (keeps strategies modular & discoverable)
    if (this.registry) {
      this.registry.register(strategy);
      this.labStrategyIds.add(strategy.config.id);
    }
    this.bus.publish({ type: LAB_EVENTS.STRATEGY_CREATED, data: { ideaId: idea.id, strategyId: strategy.config.id, kind: idea.strategyKind, symbol: idea.symbol, timestamp: Date.now() }, source: "strategy-lab", correlationId: idea.id });
    return strategy;
  }

  isLabStrategy(id: string): boolean { return this.labStrategyIds.has(id); }
  listLabStrategies(): string[] { return [...this.labStrategyIds]; }

  // -------------------------------------------------------------------------
  // Backtest — Strategy + candles -> BacktestResult (reuses BacktestEngine)
  // -------------------------------------------------------------------------

  async backtest(
    idea: StrategyIdea,
    candles?: BacktestCandle[],
    opts?: { strategyId?: string; initialCapital?: number },
  ): Promise<BacktestResult> {
    const strategy = this.toStrategy(idea);
    const sid = opts?.strategyId ?? strategy.config.id;
    // Resolve if strategy was re-registered with custom id
    let instance = strategy;
    if (opts?.strategyId && this.registry) {
      const reg = this.registry.get(opts.strategyId);
      if (reg) instance = reg;
    }

    let cs = candles;
    if (!cs || cs.length === 0) {
      if (this.market) {
        const bars = await this.market.getOHLCV(idea.symbol, idea.timeframe, this.config.candleLimit);
        cs = bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, timestamp: b.timestamp }));
      } else {
        cs = this.syntheticCandles(idea.symbol, this.config.candleLimit);
      }
    }
    if (cs.length < 40) throw new Error(`Insufficient candles: ${cs.length} < 40 required for backtest`);

    const engine = opts?.initialCapital !== undefined ? new BacktestEngine({ initialCapital: opts.initialCapital, feeRate: this.config.feeRate, slippage: this.config.slippage }) : this.engine;
    const result = engine.run(instance, cs, idea.symbol, idea.timeframe);
    // Publish event
    this.bus.publish({ type: LAB_EVENTS.BACKTEST_COMPLETED, data: { ideaId: idea.id, strategyId: sid, symbol: idea.symbol, timeframe: idea.timeframe, totalReturn: result.totalReturn, tradeCount: result.tradeCount, timestamp: Date.now() }, source: "strategy-lab", correlationId: idea.id });
    return result;
  }

  // -------------------------------------------------------------------------
  // Performance / Risk / Candidate — pure analysis
  // -------------------------------------------------------------------------

  performance(result: BacktestResult): PerformanceAnalysis {
    const p = analyzePerformance(result, this.config);
    this.bus.publish({ type: LAB_EVENTS.PERFORMANCE_COMPLETED, data: { strategyId: result.strategyId, symbol: result.symbol, verdict: p.verdict, totalReturn: p.totalReturn, sharpe: p.sharpeRatio, timestamp: Date.now() }, source: "strategy-lab", correlationId: result.strategyId });
    return p;
  }

  risk(result: BacktestResult, perf: PerformanceAnalysis): RiskAnalysis {
    const r = analyzeRisk(result, perf, this.config);
    this.bus.publish({ type: LAB_EVENTS.RISK_COMPLETED, data: { strategyId: result.strategyId, symbol: result.symbol, decision: r.decision, riskScore: r.riskScore, timestamp: Date.now() }, source: "strategy-lab", correlationId: result.strategyId });
    return r;
  }

  candidate(result: BacktestResult, perf: PerformanceAnalysis, risk: RiskAnalysis, idea: StrategyIdea): PaperCandidate {
    const approved = perf.verdict !== "fail" && risk.decision === "APPROVED" && result.tradeCount >= this.config.minTrades;
    const readyForPaper = approved;
    const reason = approved
      ? `Approved for paper trading: ${idea.strategyKind} on ${idea.symbol} (${result.tradeCount} trades, ${(perf.winRate * 100).toFixed(1)}% WR, Sharpe ${result.sharpeRatio.toFixed(2)})`
      : `Rejected: perf=${perf.verdict} risk=${risk.decision} trades=${result.tradeCount} — ${[...perf.reasons, ...risk.reasons].slice(0, 3).join("; ")}`;
    const c: PaperCandidate = { approved, readyForPaper, strategyId: result.strategyId, ideaId: idea.id, symbol: idea.symbol, reason, performance: perf, risk, backtest: result };
    this.bus.publish({ type: approved ? LAB_EVENTS.CANDIDATE_APPROVED : LAB_EVENTS.CANDIDATE_REJECTED, data: { ideaId: idea.id, strategyId: result.strategyId, symbol: idea.symbol, approved, readyForPaper, reason, timestamp: Date.now() }, source: "strategy-lab", correlationId: idea.id });
    return c;
  }

  // -------------------------------------------------------------------------
  // Full pipeline: Idea -> Strategy -> Backtest -> Performance -> Risk -> Candidate
  // -------------------------------------------------------------------------

  async run(input: IdeaInput, candles?: BacktestCandle[]): Promise<LabRun> {
    const idea = this.submitIdea(input);
    const started = Date.now();
    const runId = nextRunId();
    try {
      const bt = await this.backtest(idea, candles);
      const perf = this.performance(bt);
      const r = this.risk(bt, perf);
      const cand = this.candidate(bt, perf, r, idea);
      const completedAt = Date.now();
      const run: LabRun = {
        id: runId, idea, strategyId: cand.strategyId, backtest: bt, performance: perf, risk: r, candidate: cand,
        status: "completed", createdAt: started, completedAt, durationMs: completedAt - started, candlesUsed: bt.equityCurve.length ? candles?.length ?? this.config.candleLimit : (candles?.length ?? 0),
      };
      this.runs.set(runId, run);
      this.bus.publish({ type: LAB_EVENTS.RUN_COMPLETED, data: { runId, ideaId: idea.id, strategyId: cand.strategyId, symbol: idea.symbol, approved: cand.approved, durationMs: run.durationMs, timestamp: completedAt }, source: "strategy-lab", correlationId: idea.id });
      return run;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const completedAt = Date.now();
      // Create a failed run stub (no backtest/perf/risk)
      const failRun = {
        id: runId, idea, strategyId: `lab:${idea.id}:${idea.strategyKind}`, backtest: null as unknown as BacktestResult, performance: null as unknown as PerformanceAnalysis, risk: null as unknown as RiskAnalysis, candidate: null as unknown as PaperCandidate,
        status: "failed" as const, createdAt: started, completedAt, durationMs: completedAt - started, candlesUsed: candles?.length ?? 0, error: msg,
      };
      this.runs.set(runId, failRun as unknown as LabRun);
      this.bus.publish({ type: LAB_EVENTS.RUN_FAILED, data: { runId, ideaId: idea.id, error: msg, timestamp: completedAt }, source: "strategy-lab", correlationId: idea.id });
      throw err;
    }
  }

  // Direct run with pre-parsed idea (useful when caller already submitted idea)
  async runIdea(idea: StrategyIdea, candles?: BacktestCandle[]): Promise<LabRun> {
    const started = Date.now();
    const runId = nextRunId();
    const bt = await this.backtest(idea, candles);
    const perf = this.performance(bt);
    const r = this.risk(bt, perf);
    const cand = this.candidate(bt, perf, r, idea);
    const completedAt = Date.now();
    const run: LabRun = { id: runId, idea, strategyId: cand.strategyId, backtest: bt, performance: perf, risk: r, candidate: cand, status: "completed", createdAt: started, completedAt, durationMs: completedAt - started, candlesUsed: bt.equityCurve.length ? candles?.length ?? this.config.candleLimit : (candles?.length ?? 0) };
    this.runs.set(runId, run);
    this.bus.publish({ type: LAB_EVENTS.RUN_COMPLETED, data: { runId, ideaId: idea.id, strategyId: cand.strategyId, symbol: idea.symbol, approved: cand.approved, durationMs: run.durationMs, timestamp: completedAt }, source: "strategy-lab", correlationId: idea.id });
    return run;
  }

  getRun(id: string): LabRun | undefined { return this.runs.get(id); }
  listRuns(): LabRun[] { return [...this.runs.values()]; }
  clear(): void { this.ideas.clear(); this.runs.clear(); this.labStrategyIds.clear(); }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private syntheticCandles(symbol: string, n: number): BacktestCandle[] {
    // deterministic pseudo-random trending candles
    let h = 0; for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
    let price = 50000 + (h % 20000);
    const now = Date.now() - n * 3600000;
    const out: BacktestCandle[] = [];
    for (let i = 0; i < n; i++) {
      const drift = ((h * 9301 + 49297 * (i + 1)) % 233280) / 233280 - 0.48; // slight up drift
      const change = drift * 200;
      const open = price;
      const close = Math.max(100, open + change + (Math.random() * 20 - 10));
      const high = Math.max(open, close) * (1 + Math.random() * 0.003);
      const low = Math.min(open, close) * (1 - Math.random() * 0.003);
      price = close;
      out.push({ open, high, low, close, volume: 100 + Math.random() * 50, timestamp: now + i * 3600000 });
    }
    return out;
  }
}
