// ============================================================================
// Trade Workflow Orchestrator
// Research (market-research-agent) -> Strategy Proposal (btc-quant-agent) ->
// Risk Review (risk-guardian-agent) -> User Approval (API, exact-order-param
// match) -> Paper Execution (existing 7-stage ExecutionPipeline) ->
// Portfolio Update -> Audit Record.
//
// Safety invariants (enforced server-side, never by prompts):
// - The LLM can only ever *produce* a proposal string; structured output is
//   re-validated here before it can become a pipeline signal.
// - Execution only happens on approve(); approve() requires the caller to echo
//   the exact symbol/side/quantity of the recorded proposal.
// - Execution is delegated to ExecutionPipeline.execute() which re-runs risk
//   (deterministic RiskAgent + HMAC ticket), permissions, kill switch, hard
//   limits and the PaperBroker. This orchestrator never calls the broker
//   directly with its own fills.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import { WorkflowStore } from "./store.js";
import { validateProposal, type WorkflowAgentStep, type WorkflowProposal, type WorkflowRun, type WorkflowStage } from "./types.js";
import type { PipelineSignal } from "../execution-pipeline/types.js";

export interface AgentRunner {
  /** Runs one agent turn and returns its final text. */
  runAgent(agentId: string, prompt: string, history?: Array<{ role: string; content: string }>): Promise<string>;
}

export interface PipelineRunner {
  execute(signal: unknown): Promise<{
    success: boolean;
    stage: string;
    reason: string;
    correlationId: string;
    signalId: string;
    order?: { status?: string; quantity?: number; filledPrice?: number; fee?: number; [key: string]: unknown };
    auditIds?: string[];
  }>;
}

export interface MarketFreshness {
  /** Epoch ms of the freshest tick for the symbol, or undefined if unknown. */
  getLastUpdate(symbol: string): number | undefined;
}

export interface PortfolioReader {
  snapshot(): Record<string, unknown> | undefined;
}

export interface OrchestratorOptions {
  bus?: TypedEventBus;
  store?: WorkflowStore;
  agentRunner: AgentRunner;
  pipeline: PipelineRunner;
  freshness?: MarketFreshness;
  portfolio?: PortfolioReader;
  /** Max age (ms) of tolerated market data at approval time. Default 5 min. */
  maxDataAgeMs?: number;
}

const ids = {
  RESEARCH: "market-research-agent",
  QUANT: "btc-quant-agent",
  RISK: "risk-guardian-agent",
} as const;

const MAX_MARKET_UPDATE_AGE_MS_DEFAULT = 5 * 60 * 1000;

export class TradeWorkflowOrchestrator {
  private readonly runs = new Map<string, WorkflowRun>();
  readonly id = "trade-workflow-orchestrator";
  private readonly store: WorkflowStore;
  private readonly agentRunner: AgentRunner;
  private readonly pipeline: PipelineRunner;
  private readonly freshness?: MarketFreshness;
  private readonly portfolio?: PortfolioReader;
  private readonly maxDataAgeMs: number;
  private readonly bus?: TypedEventBus;
  private readonly inFlight = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.bus = opts.bus;
    this.store = opts.store ?? new WorkflowStore();
    this.agentRunner = opts.agentRunner;
    this.pipeline = opts.pipeline;
    this.freshness = opts.freshness;
    this.portfolio = opts.portfolio;
    this.maxDataAgeMs = opts.maxDataAgeMs ?? MAX_MARKET_UPDATE_AGE_MS_DEFAULT;
  }

  async hydrate(): Promise<void> {
    const runs = await this.store.loadAll();
    for (const run of runs) this.runs.set(run.id, run);
  }

  list(limit = 50): WorkflowRun[] {
    return Array.from(this.runs.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  get(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  /** Research -> proposal -> risk review, then stop at awaiting_approval. */
  async startRun(input: { symbol?: string; context?: string }): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: `wf-${Date.now()}-${uuidv4().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      stage: "research",
      agents: [],
      auditIds: [],
    };
    const symbol = typeof input?.symbol === "string" && /^[A-Za-z0-9]{2,20}$/.test(input.symbol.trim())
      ? input.symbol.trim().toUpperCase()
      : "BTCUSDT";
    const context = typeof input?.context === "string" ? input.context.trim().slice(0, 2_000) : "";
    this.runs.set(run.id, run);
    await this.store.saveRun(run);
    this.publish({ type: "orchestrator.workflow_started", data: { runId: run.id, symbol }, source: this.id });

    try {
      // --- Stage 1: Market Research ---
      await this.step(run, ids.RESEARCH, "research",
        `Write a concise market brief for ${symbol}. Facts vs assumptions, bull/base/bear scenario, one data-limitation caveat. Plain text, max 250 words.`);

      // --- Stage 2: Strategy Proposal (strict JSON) ---
      const prompt = [
        `Produce a paper-trading strategy proposal for ${symbol} as JSON only (no prose, no code fences) with exactly these fields:`,
        `{"symbol":"${symbol}","side":"buy"|"sell","quantity":<positive number>, "price":<positive number>, "type":"market"|"limit", "rationale": "<at least 10 chars>", "assumptions":"<short>"}`,
        context ? `Additional user context: ${context}` : "",
        "Base the price on reasonable recent levels. The trade will be simulated (paper) and re-checked by a risk engine.",
      ].filter(Boolean).join("\n");
      await this.step(run, ids.QUANT, "proposal", prompt);

      const proposalStep = [...run.agents].reverse().find((a) => a.stage === "proposal");
      const parsed = this.extractJson(proposalStep?.output ?? "");
      const v = validateProposal(parsed);
      if (!v.valid || !v.proposal) {
        run.status = "failed";
        run.stage = "proposal";
        run.error = `Strategy proposal rejected by validation: ${v.reason}`;
        run.updatedAt = new Date().toISOString();
        await this.store.saveRun(run);
        this.publish({ type: "orchestrator.workflow_failed", data: { runId: run.id, reason: run.error }, source: this.id });
        return run;
      }
      run.proposal = v.proposal as WorkflowProposal;

      // --- Stage 3: Risk Review (narrative; the binding check re-runs at approval) ---
      const riskPrompt = [
        "Pre-trade risk review for the following paper-trading proposal. JSON only:",
        `{"verdict":"ok"|"concern"|"block","concerns":["..."],"notes":"<short>"}`,
        `Proposal: ${JSON.stringify({ symbol: run.proposal.symbol, side: run.proposal.side, quantity: run.proposal.quantity, price: run.proposal.price, type: run.proposal.type })}`,
        `Scenario context: ${(run.agents.find((a) => a.stage === "research")?.output ?? "").slice(0, 1_000)}`,
        "Judge position sizing, concentration, plausible stop-loss distance, and data reliability.",
      ].join("\n");
      await this.step(run, ids.RISK, "risk_review", riskPrompt);
      const riskStep = [...run.agents].reverse().find((a) => a.stage === "risk_review");
      run.riskReview = this.parseRiskReview(riskStep?.output ?? "");

      if (run.riskReview.verdict === "block") {
        run.status = "failed";
        run.stage = "risk_review";
        run.error = "Risk Guardian blocked the proposal before approval: " + (run.riskReview.concerns.join("; ") || "blocked");
        run.updatedAt = new Date().toISOString();
        await this.store.saveRun(run);
        this.publish({ type: "orchestrator.workflow_failed", data: { runId: run.id, reason: run.error }, source: this.id });
        return run;
      }

      // --- Stage 4: wait for explicit user approval (API-gated) ---
      run.status = "awaiting_approval";
      run.stage = "awaiting_approval";
      run.updatedAt = new Date().toISOString();
      await this.store.saveRun(run);
      this.publish({ type: "orchestrator.workflow_awaiting_approval", data: { runId: run.id, proposal: run.proposal, riskReview: run.riskReview }, source: this.id });
      return run;
    } catch (err) {
      run.status = "failed";
      run.stage = "research";
      run.error = err instanceof Error ? err.message : String(err);
      run.updatedAt = new Date().toISOString();
      await this.store.saveRun(run);
      return run;
    }
  }

  /** Rejection path. Requires a user-authored reason for the audit record. */
  async reject(id: string, reason: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status !== "awaiting_approval") return undefined;
    const clean = reason.trim().slice(0, 1_000);
    if (!clean) return run; // reason is mandatory
    run.approval = { decidedAt: new Date().toISOString(), decision: "rejected", reason: clean };
    run.status = "user_rejected";
    run.stage = "done";
    run.updatedAt = new Date().toISOString();
    if (this.bus) {
      this.bus.publish({ type: "audit.recorded", data: { id: `audit-${run.id}-rejected`, type: "orchestrator.rejection", data: { runId: run.id, proposal: run.proposal, reason: clean } }, source: this.id });
    }
    run.auditIds.push(`audit-${run.id}-rejected`);
    await this.store.saveRun(run);
    this.publish({ type: "orchestrator.workflow_rejected", data: { runId: run.id, reason: clean }, source: this.id });
    return run;
  }

  /**
   * Approval path — server-validated against the exact recorded proposal:
   * status must be awaiting_approval, param echo must match, market data must
   * be fresh (when known) and paper/kill-switch state is checked by reissuing
   * through the ExecutionPipeline (risk re-runs there non-bypassably).
   */
  async approve(id: string, confirmation: { symbol: string; side: "buy" | "sell"; quantity: number }): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(id);
    if (!run || !run.proposal) return undefined;
    if (run.status !== "awaiting_approval") return run; // not approvable in current state
    if (this.inFlight.has(id)) return run;
    const p = run.proposal;
    const sameSymbol = String(confirmation?.symbol ?? "").trim().toUpperCase() === p.symbol;
    const sameSide = confirmation?.side === p.side;
    const sameQty = Number.isFinite(confirmation?.quantity) && Number(confirmation.quantity) === p.quantity;
    if (!sameSymbol || !sameSide || !sameQty) {
      run.error = "Approval confirmation did not match the recorded proposal exactly (symbol/side/quantity). Not executing.";
      run.updatedAt = new Date().toISOString();
      await this.store.saveRun(run);
      return run;
    }
    // Approval decay: market data must be fresh right now (when a reader exists).
    if (this.freshness) {
      const last = this.freshness.getLastUpdate(p.symbol);
      const age = last === undefined ? Infinity : Date.now() - last;
      if (age > this.maxDataAgeMs || last === undefined) {
        run.status = "failed";
        run.stage = "awaiting_approval";
        run.error = `Approval rejected at pre-execution recheck: market data for ${p.symbol} is ${last === undefined ? "missing" : `stale (${Math.round(age / 1000)}s old)`}.`;
        run.updatedAt = new Date().toISOString();
        await this.store.saveRun(run);
        return run;
      }
    }

    run.approval = {
      decidedAt: new Date().toISOString(),
      decision: "approved",
      confirmed: { symbol: p.symbol, side: p.side, quantity: p.quantity },
    };
    run.status = "running";
    run.stage = "paper_execution";
    await this.store.saveRun(run);
    this.inFlight.add(id);
    try {
      const signal: PipelineSignal = {
        id: `sig-${run.id}`,
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        price: p.price,
        type: p.type,
        strategy: "orchestrator-workflow",
        agentId: "execution-agent",
        timestamp: Date.now(),
      };
      const result = await this.pipeline.execute(signal) as {
        success: boolean; stage: string; reason: string; correlationId: string; signalId: string;
        order?: { status?: string; quantity?: number; filledPrice?: number; fee?: number } & Record<string, unknown>;
        auditIds?: string[];
      };
      run.execution = {
        correlationId: result.correlationId,
        signalId: result.signalId,
        success: result.success,
        stage: result.stage,
        reason: result.reason,
        order: result.order,
        filledPrice: result.order?.filledPrice,
        filledQuantity: result.order?.quantity,
        fee: result.order?.fee,
      };
      run.auditIds.push(...(result.auditIds ?? []));
      run.status = result.success ? "completed" : "failed";
      run.stage = result.success ? "audit_record" : "paper_execution";
      run.error = result.success ? undefined : `Execution rejected at pipeline stage '${result.stage}': ${result.reason}`;
      if (result.success && this.portfolio) {
        run.stage = "portfolio_update";
        run.portfolioAfter = this.portfolio.snapshot();
      }
    } catch (err) {
      run.status = "failed";
      run.stage = "paper_execution";
      run.error = `Execution pipeline error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.inFlight.delete(id);
    }
    run.updatedAt = new Date().toISOString();
    await this.store.saveRun(run);
    this.publish({ type: "orchestrator.workflow_recorded", data: { runId: run.id, status: run.status, execution: run.execution }, source: this.id });
    return run;
  }

  /**
   * Recover a persisted in-flight run after a server restart. If it was still
   * running (crashed mid-stage before reaching approval), mark it failed so no
   * orphan order can ever resume without an approval event that happened.
   */
  private async cleanOrphans(): Promise<void> {
    for (const run of Array.from(this.runs.values())) {
      if (run.status === "running") {
        run.status = "failed";
        run.error = "Workflow was interrupted by a server restart before approval/execution; it must be re-run.";
        run.updatedAt = new Date().toISOString();
        await this.store.saveRun(run);
      }
    }
  }

  async recoverAfterRestart(): Promise<void> {
    await this.hydrate();
    await this.cleanOrphans();
  }

  private extractJson(text: string): unknown {
    if (!text) return null;
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
      }
      return null;
    }
  }

  private parseRiskReview(text: string) {
    const parsed = this.extractJson(text) as { verdict?: unknown; concerns?: unknown; notes?: unknown } | null;
    const verdict = parsed?.verdict === "concern" || parsed?.verdict === "block" ? parsed.verdict : "ok";
    const concerns = Array.isArray(parsed?.concerns)
      ? parsed.concerns.filter((c): c is string => typeof c === "string").slice(0, 10)
      : [];
    return {
      agentId: ids.RISK,
      verdict: verdict as "ok" | "concern" | "block",
      concerns,
      notes: typeof parsed?.notes === "string" ? parsed.notes.slice(0, 2_000) : undefined,
    };
  }

  private async step(run: WorkflowRun, agentId: string, stage: WorkflowStage, prompt: string): Promise<void> {
    const step: WorkflowAgentStep = { agentId, stage, startedAt: new Date().toISOString(), ok: false };
    run.agents.push(step);
    run.updatedAt = new Date().toISOString();
    await this.store.saveRun(run);
    try {
      const output = await this.agentRunner.runAgent(agentId, prompt);
      step.ok = true;
      step.output = output;
    } catch (err) {
      step.ok = false;
      step.error = err instanceof Error ? err.message : String(err);
      throw new Error(`Agent step failed at stage '${stage}' (${agentId}): ${step.error}`);
    } finally {
      step.finishedAt = new Date().toISOString();
    }
  }

  private publish(event: { type: string; data: unknown; source: string }): void {
    this.bus?.publish(event as never);
  }
}

// ---------------------------------------------------------------------------
// Service wrapper — registers on the FinanceRuntime like other services
// ---------------------------------------------------------------------------

export class TradeWorkflowService implements ServiceLifecycle {
  private orchestrator: TradeWorkflowOrchestrator;
  private info: ServiceInfo = {
    id: "trade-workflow-orchestrator",
    name: "Trade Workflow Orchestrator",
    version: "0.1.0",
    description: "Research -> Proposal -> Risk -> Approval -> Paper execution with persisted audit history",
    status: "registered",
  };

  constructor(opts: OrchestratorOptions) {
    this.orchestrator = new TradeWorkflowOrchestrator(opts);
  }

  async initialize(): Promise<void> {
    await this.orchestrator.recoverAfterRestart();
    this.info.status = "initialized";
  }
  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }
  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }
  getHealth(): ServiceInfo { return { ...this.info }; }
  getInstance(): TradeWorkflowOrchestrator { return this.orchestrator; }
}
