// ============================================================================
// SupervisorAgent — receives a finance task and produces a deterministic
// execution plan using AgentRegistry / ToolRegistry / EventBus.
// Phase 5: Enforces LoopGuard, structured TradeProposal gating, deterministic
// quant signal ingestion, secret sanitization, and structured trace memory.
// ============================================================================

import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { AgentRegistry, ToolRegistry } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { createPlan, type Plan, type PlanStep, type ValidationResult } from "./planner.js";
import { LoopGuard } from "../../core/loop-guard.js";
import {
  type TradeProposal,
  validateTradeProposal,
  createTradeProposal,
} from "./proposal.js";
import { agentMemory, type AgentLoopTrace } from "../../memory/agent-memory.js";

export { createPlan, extractSymbol, classifyTask, stripPlan } from "./planner.js";
export type { Plan, PlanStep, TaskKind, ValidationResult } from "./planner.js";
export { LoopGuard } from "../../core/loop-guard.js";
export {
  type TradeProposal,
  type EntryParameters,
  type RiskParameters,
  validateTradeProposal,
  createTradeProposal,
} from "./proposal.js";

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface StepResult {
  stepId: string;
  agentId: string;
  toolId?: string;
  status: "completed" | "skipped" | "failed";
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface PlanExecution {
  planId: string;
  task: string;
  kind: string;
  symbol: string | null;
  valid: boolean;
  validation: ValidationResult;
  steps: StepResult[];
  success: boolean;
  startedAt: number;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExecutionPipelineLike {
  execute(signal: Record<string, unknown>): Promise<{
    success: boolean;
    stage: string;
    reason: string;
    order?: unknown;
    riskDecision?: unknown;
    correlationId: string;
    signalId: string;
  }>;
}

export interface SupervisorOptions {
  bus?: TypedEventBus;
  agentRegistry?: AgentRegistry;
  toolRegistry?: ToolRegistry;
  executionPipeline?: ExecutionPipelineLike;
  loopGuard?: LoopGuard;
  /** Fail-fast: abort on first step failure. Default: true */
  failFast?: boolean;
  /** Automatically process actionable quant signals into trade proposals */
  autoOrchestrateSignals?: boolean;
}

// ---------------------------------------------------------------------------
// SupervisorAgent
// ---------------------------------------------------------------------------

export class SupervisorAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private agentRegistry?: AgentRegistry;
  private toolRegistry?: ToolRegistry;
  private executionPipeline?: ExecutionPipelineLike;
  private loopGuard: LoopGuard;
  private failFast: boolean;
  private autoOrchestrateSignals: boolean;
  private unsubscribe: (() => void) | null = null;
  private executions = new Map<string, PlanExecution>();
  private lastPlan: Plan | null = null;

  constructor(opts: SupervisorOptions = {}) {
    super({
      id: "supervisor",
      name: "Supervisor Agent",
      version: "0.2.0",
      description: "Deterministic planner & reliable trade proposal orchestrator with anti-loop protection",
      capabilities: ["task-planning", "deterministic-routing", "execution-orchestration", "proposal-gating"],
    });
    this.bus = opts.bus ?? new TypedEventBus();
    this.agentRegistry = opts.agentRegistry;
    this.toolRegistry = opts.toolRegistry;
    this.executionPipeline = opts.executionPipeline;
    this.loopGuard = opts.loopGuard ?? new LoopGuard();
    this.failFast = opts.failFast ?? true;
    this.autoOrchestrateSignals = opts.autoOrchestrateSignals ?? false;
  }

  // Allow late binding (useful when runtime creates registries after agent)
  setRegistries(registries: { agentRegistry: AgentRegistry; toolRegistry: ToolRegistry }): void {
    this.agentRegistry = registries.agentRegistry;
    this.toolRegistry = registries.toolRegistry;
  }

  setExecutionPipeline(pipeline: ExecutionPipelineLike): void {
    this.executionPipeline = pipeline;
  }

  getBus(): TypedEventBus {
    return this.bus;
  }

  getLoopGuard(): LoopGuard {
    return this.loopGuard;
  }

  async start(): Promise<void> {
    await super.start();
    // Subscribe to supervisor tasks & quant signals via EventBus
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "supervisor.task" || event.type === "supervisor.execute") {
        const data = event.data as { task?: string; correlationId?: string } | null;
        const task = typeof data?.task === "string" ? data.task : typeof event.data === "string" ? event.data : "";
        if (task) {
          void this.submitTask(task, data?.correlationId).catch((err) => this.recordError(err));
        }
      } else if (event.type === "quant.signal" && this.autoOrchestrateSignals) {
        const signal = event.data as Record<string, unknown> | null;
        if (signal && (signal.action === "buy" || signal.action === "sell")) {
          void this.orchestrateTradeProposal(signal, { correlationId: event.correlationId }).catch((err) => this.recordError(err));
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await super.stop();
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    if (event.type === "supervisor.task" || event.type === "supervisor.execute") {
      const data = event.data as { task?: string; correlationId?: string } | null;
      const task = typeof data?.task === "string" ? data.task : typeof event.data === "string" ? event.data : "";
      if (task) await this.submitTask(task, data?.correlationId);
    } else if (event.type === "quant.signal" && this.autoOrchestrateSignals) {
      const signal = event.data as Record<string, unknown> | null;
      if (signal && (signal.action === "buy" || signal.action === "sell")) {
        await this.orchestrateTradeProposal(signal, { correlationId: event.correlationId });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Structured Trade Proposal Orchestration (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Orchestrates an end-to-end trade proposal through validation, anti-recursion guards,
   * risk evaluation, broker execution, and memory trace recording.
   * Prevents raw free-form text or unvalidated calls from placing orders.
   */
  async orchestrateTradeProposal(
    proposalOrSignal: TradeProposal | Record<string, unknown>,
    opts?: { skipCooldown?: boolean; correlationId?: string }
  ): Promise<{
    success: boolean;
    stage: string;
    reason: string;
    proposal?: TradeProposal;
    order?: unknown;
    riskDecision?: unknown;
    executionResult?: unknown;
  }> {
    let proposal: TradeProposal;

    // 1. Structure validation
    if ("entryParameters" in proposalOrSignal && "riskParameters" in proposalOrSignal) {
      const validation = validateTradeProposal(proposalOrSignal);
      if (!validation.valid || !validation.proposal) {
        const reason = validation.reason ?? "Invalid TradeProposal format";
        agentMemory.recordTrace({
          traceId: String(proposalOrSignal.proposalId ?? `err-${Date.now()}`),
          correlationId: opts?.correlationId ?? "unknown",
          symbol: String(proposalOrSignal.symbol ?? "UNKNOWN"),
          proposal: proposalOrSignal,
          outcome: "rejected_by_guard",
          reason,
          timestamp: Date.now(),
        });
        return { success: false, stage: "validation", reason };
      }
      proposal = validation.proposal;
    } else {
      // Input is raw quantitative signal or parameter object
      const raw = proposalOrSignal as Record<string, unknown>;
      const sym = typeof raw.symbol === "string" ? raw.symbol.trim() : "";
      const price = typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0 ? raw.price : undefined;
      const quantity = typeof raw.quantity === "number" && Number.isFinite(raw.quantity) && raw.quantity > 0 ? raw.quantity : (typeof raw.qty === "number" && Number.isFinite(raw.qty) && raw.qty > 0 ? raw.qty : undefined);
      const side = raw.side === "sell" || raw.action === "sell" ? "sell" : raw.side === "buy" || raw.action === "buy" ? "buy" : undefined;

      if (!sym || price === undefined || quantity === undefined || !side) {
        const reason = "Conversational or unstructured input cannot execute trade: missing required quantitative parameters (symbol, price, quantity, side/action)";
        agentMemory.recordTrace({
          traceId: `err-${Date.now()}`,
          correlationId: opts?.correlationId ?? "unknown",
          symbol: sym || "UNKNOWN",
          proposal: raw,
          outcome: "rejected_by_guard",
          reason,
          timestamp: Date.now(),
        });
        return { success: false, stage: "validation", reason };
      }

      try {
        proposal = createTradeProposal({
          proposalId: typeof raw.id === "string" ? raw.id : typeof raw.proposalId === "string" ? raw.proposalId : undefined,
          correlationId: opts?.correlationId ?? (typeof raw.correlationId === "string" ? raw.correlationId : undefined),
          symbol: sym,
          side,
          quantity,
          price,
          strategy: String(raw.strategy ?? "quantitative-confluence"),
          confidence: typeof raw.confidence === "number" ? raw.confidence : 0.8,
          reasoning: String(raw.reason ?? raw.reasoning ?? "Quantitative confluence signal"),
          entryParameters: {
            targetEntryPrice: price,
            orderType: "market",
          },
          riskParameters: {
            maxSlippagePct: 0.01,
            positionLimitPct: 0.2,
          },
          timeframe: typeof raw.timeframe === "string" ? raw.timeframe : "tick",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        agentMemory.recordTrace({
          traceId: `err-${Date.now()}`,
          correlationId: opts?.correlationId ?? "unknown",
          symbol: sym || "UNKNOWN",
          proposal: raw,
          outcome: "rejected_by_guard",
          reason,
          timestamp: Date.now(),
        });
        return { success: false, stage: "validation", reason };
      }
    }

    // 2. Loop Guard: duplicate event suppression
    if (this.loopGuard.isDuplicateEvent(proposal.proposalId)) {
      const reason = `Duplicate proposal event suppressed: ${proposal.proposalId}`;
      agentMemory.recordTrace({
        traceId: proposal.proposalId,
        correlationId: proposal.correlationId,
        symbol: proposal.symbol,
        proposal,
        outcome: "rejected_by_guard",
        reason,
        timestamp: Date.now(),
      });
      this.bus.publish({
        type: "supervisor.proposal_rejected",
        data: { proposalId: proposal.proposalId, reason, stage: "loop_guard" },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: proposal.correlationId,
      });
      return { success: false, stage: "loop_guard", reason, proposal };
    }

    // 3. Loop Guard: symbol burst cooldown
    if (!opts?.skipCooldown) {
      const cooldown = this.loopGuard.checkSymbolCooldown(proposal.symbol);
      if (!cooldown.allowed) {
        const reason = `Symbol burst cooldown active for ${proposal.symbol} (wait ${cooldown.waitMs}ms)`;
        agentMemory.recordTrace({
          traceId: proposal.proposalId,
          correlationId: proposal.correlationId,
          symbol: proposal.symbol,
          proposal,
          outcome: "rejected_by_guard",
          reason,
          timestamp: Date.now(),
        });
        this.bus.publish({
          type: "supervisor.proposal_rejected",
          data: { proposalId: proposal.proposalId, reason, stage: "loop_guard" },
          source: "supervisor-agent",
          agentId: this.id,
          correlationId: proposal.correlationId,
        });
        return { success: false, stage: "loop_guard", reason, proposal };
      }
    }

    // 4. Loop Guard: recursion depth limit
    const traceCheck = this.loopGuard.enterTrace(proposal.correlationId);
    if (!traceCheck.allowed) {
      const reason = traceCheck.reason!;
      agentMemory.recordTrace({
        traceId: proposal.proposalId,
        correlationId: proposal.correlationId,
        symbol: proposal.symbol,
        proposal,
        outcome: "rejected_by_guard",
        reason,
        timestamp: Date.now(),
      });
      this.bus.publish({
        type: "supervisor.proposal_rejected",
        data: { proposalId: proposal.proposalId, reason, stage: "loop_guard" },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: proposal.correlationId,
      });
      return { success: false, stage: "loop_guard", reason, proposal };
    }

    try {
      // 5. Emit proposal created event
      this.bus.publish({
        type: "supervisor.proposal_created",
        data: { proposal, timestamp: Date.now() },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: proposal.correlationId,
      });

      if (!this.executionPipeline) {
        agentMemory.recordTrace({
          traceId: proposal.proposalId,
          correlationId: proposal.correlationId,
          symbol: proposal.symbol,
          proposal,
          outcome: "held",
          reason: "Execution pipeline not configured",
          timestamp: Date.now(),
        });
        return {
          success: true,
          stage: "proposal_only",
          reason: "Execution pipeline not configured",
          proposal,
        };
      }

      // 6. Route through execution pipeline
      const pipelineSignal = {
        id: proposal.proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        quantity: proposal.quantity,
        price: proposal.price,
        type: proposal.entryParameters.orderType,
        agentId: this.id,
        strategy: proposal.strategy,
        confidence: proposal.confidence,
        timestamp: proposal.timestamp,
        correlationId: proposal.correlationId,
        proposal,
      };

      const pipelineResult = await this.executionPipeline.execute(pipelineSignal as Record<string, unknown>);
      const isCompleted = pipelineResult.success && pipelineResult.stage === "completed";
      const outcome = isCompleted ? "executed" : pipelineResult.stage === "risk" ? "rejected_by_risk" : "execution_failed";

      // 7. Record sanitized trace in agent memory
      agentMemory.recordTrace({
        traceId: proposal.proposalId,
        correlationId: proposal.correlationId,
        symbol: proposal.symbol,
        proposal,
        riskDecision: pipelineResult.riskDecision,
        executionResult: pipelineResult.order,
        outcome,
        reason: pipelineResult.reason,
        timestamp: Date.now(),
      });

      // 8. Publish outcome event
      this.bus.publish({
        type: isCompleted ? "supervisor.proposal_executed" : "supervisor.proposal_rejected",
        data: {
          proposalId: proposal.proposalId,
          stage: pipelineResult.stage,
          reason: pipelineResult.reason,
          order: pipelineResult.order,
          riskDecision: pipelineResult.riskDecision,
          timestamp: Date.now(),
        },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: proposal.correlationId,
      });

      return {
        success: isCompleted,
        stage: pipelineResult.stage,
        reason: pipelineResult.reason,
        proposal,
        order: pipelineResult.order,
        riskDecision: pipelineResult.riskDecision,
        executionResult: pipelineResult,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordError(err);
      agentMemory.recordTrace({
        traceId: proposal.proposalId,
        correlationId: proposal.correlationId,
        symbol: proposal.symbol,
        proposal,
        outcome: "execution_failed",
        reason: msg,
        timestamp: Date.now(),
      });
      return { success: false, stage: "error", reason: msg, proposal };
    } finally {
      this.loopGuard.exitTrace(proposal.correlationId);
      this.loopGuard.recordEvent(proposal.proposalId);
    }
  }

  // -------------------------------------------------------------------------
  // Planning (pure)
  // -------------------------------------------------------------------------

  plan(task: string): Plan {
    if (!task || typeof task !== "string" || !task.trim()) {
      throw new Error("task is required (non-empty string)");
    }
    const plan = createPlan(task);
    this.lastPlan = plan;
    this.recordActivity();

    this.bus.publish({
      type: "supervisor.plan_created",
      data: { planId: plan.id, task: plan.task, symbol: plan.symbol, kind: plan.kind, steps: plan.steps.map((s) => s.id), timestamp: Date.now() },
      source: "supervisor-agent",
      agentId: this.id,
      correlationId: plan.id,
    });

    return plan;
  }

  getLastPlan(): Plan | null {
    return this.lastPlan ? { ...this.lastPlan, steps: [...this.lastPlan.steps] } : null;
  }

  // -------------------------------------------------------------------------
  // Validation (against registries)
  // -------------------------------------------------------------------------

  validate(plan: Plan): ValidationResult {
    const missingAgents: string[] = [];
    const missingTools: string[] = [];
    const reasons: string[] = [];

    const ar = this.agentRegistry;
    const tr = this.toolRegistry;

    if (!ar) {
      reasons.push("AgentRegistry not configured — skipping agent validation");
    } else {
      const seen = new Set<string>();
      for (const s of plan.steps) {
        if (seen.has(s.agentId)) continue;
        seen.add(s.agentId);
        if (!ar.has(s.agentId)) {
          missingAgents.push(s.agentId);
          reasons.push(`missing agent '${s.agentId}' for step '${s.id}'`);
        }
      }
    }

    if (!tr) {
      reasons.push("ToolRegistry not configured — skipping tool validation");
    } else {
      for (const s of plan.steps) {
        if (s.toolId && !tr.has(s.toolId)) {
          if (!missingTools.includes(s.toolId)) {
            missingTools.push(s.toolId);
            reasons.push(`missing tool '${s.toolId}' for step '${s.id}'`);
          }
        }
      }
    }

    const valid = missingAgents.length === 0 && missingTools.length === 0;
    const result: ValidationResult = { valid, missingAgents, missingTools, reasons };

    this.bus.publish({
      type: valid ? "supervisor.plan_validated" : "supervisor.plan_validation_failed",
      data: { planId: plan.id, task: plan.task, valid, missingAgents, missingTools, reasons, timestamp: Date.now() },
      source: "supervisor-agent",
      agentId: this.id,
      correlationId: plan.id,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async executePlan(plan: Plan): Promise<PlanExecution> {
    const validation = this.validate(plan);
    const startedAt = Date.now();

    this.bus.publish({
      type: "supervisor.plan_execution_started",
      data: { planId: plan.id, task: plan.task, kind: plan.kind, symbol: plan.symbol, valid: validation.valid, timestamp: startedAt },
      source: "supervisor-agent",
      agentId: this.id,
      correlationId: plan.id,
    });

    const stepResults: StepResult[] = [];
    let success = true;

    for (const step of plan.steps) {
      const stepStartedAt = Date.now();

      // Smooth step pacing delay for realistic inter-agent handoff feel
      await new Promise((resolve) => setTimeout(resolve, 600));

      this.bus.publish({
        type: "supervisor.step_started",
        data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId ?? null, input: step.input, timestamp: stepStartedAt },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: plan.id,
      });

      let result: StepResult;

      if (!step.toolId) {
        // Execution pipeline integration: route trade execution through
        // structured proposal validation -> LoopGuard -> Risk Gate -> Paper broker
        if (step.agentId === "execution" && this.executionPipeline) {
          try {
            const rawInput = step.input as Record<string, unknown>;
            const proposalResult = await this.orchestrateTradeProposal(
              {
                proposalId: `${plan.id}:${step.id}`,
                correlationId: plan.id,
                symbol: String(rawInput.symbol ?? plan.symbol ?? "BTCUSDT"),
                side: (rawInput.side === "sell" ? "sell" : "buy") as "buy" | "sell",
                quantity: Number(rawInput.quantity ?? 0.05),
                price: Number(rawInput.price ?? 50000),
                strategy: plan.kind,
                confidence: 0.85,
                reasoning: step.description ?? `Execution of ${plan.task}`,
                entryParameters: {
                  targetEntryPrice: Number(rawInput.price ?? 50000),
                  orderType: "market",
                },
                riskParameters: {
                  maxSlippagePct: 0.01,
                  positionLimitPct: 0.2,
                },
              },
              { skipCooldown: true, correlationId: plan.id }
            );

            const isOk = proposalResult.success && proposalResult.stage === "completed";
            result = {
              stepId: step.id,
              agentId: step.agentId,
              input: step.input,
              status: isOk ? "completed" : "failed",
              output: proposalResult.executionResult ?? proposalResult,
              error: isOk ? undefined : proposalResult.reason,
              durationMs: Date.now() - stepStartedAt,
            };
            this.bus.publish({
              type: isOk ? "supervisor.step_completed" : "supervisor.step_failed",
              data: {
                planId: plan.id,
                stepId: step.id,
                agentId: step.agentId,
                status: result.status,
                output: result.output,
                pipelineStage: proposalResult.stage,
                reason: proposalResult.reason,
                durationMs: result.durationMs,
                timestamp: Date.now(),
              },
              source: "supervisor-agent",
              agentId: this.id,
              correlationId: plan.id,
            });
            if (!isOk) success = false;
            if (!isOk && this.failFast) {
              stepResults.push(result);
              break;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = {
              stepId: step.id,
              agentId: step.agentId,
              input: step.input,
              status: "failed",
              error: msg,
              durationMs: Date.now() - stepStartedAt,
            };
            success = false;
            this.recordError(err);
            this.bus.publish({
              type: "supervisor.step_failed",
              data: { planId: plan.id, stepId: step.id, agentId: step.agentId, error: msg, timestamp: Date.now() },
              source: "supervisor-agent",
              agentId: this.id,
              correlationId: plan.id,
            });
            if (this.failFast) {
              stepResults.push(result);
              break;
            }
          }
        } else {
          // Agent-mediated step — no tool call, mark completed (deterministic)
          result = {
            stepId: step.id,
            agentId: step.agentId,
            input: step.input,
            status: "completed",
            output: { note: `agent:${step.agentId} step (no tool)`, description: step.description },
            durationMs: Date.now() - stepStartedAt,
          };
          this.bus.publish({
            type: "supervisor.step_completed",
            data: { planId: plan.id, stepId: step.id, agentId: step.agentId, status: "completed", output: result.output, durationMs: result.durationMs, timestamp: Date.now() },
            source: "supervisor-agent",
            agentId: this.id,
            correlationId: plan.id,
          });
        }
      } else if (!this.toolRegistry) {
        result = {
          stepId: step.id,
          agentId: step.agentId,
          toolId: step.toolId,
          input: step.input,
          status: "skipped",
          error: "ToolRegistry not configured",
          durationMs: Date.now() - stepStartedAt,
        };
        success = false;
        this.bus.publish({
          type: "supervisor.step_failed",
          data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId, error: result.error, timestamp: Date.now() },
          source: "supervisor-agent",
          agentId: this.id,
          correlationId: plan.id,
        });
        if (this.failFast) {
          stepResults.push(result);
          break;
        }
      } else if (!this.toolRegistry.has(step.toolId)) {
        result = {
          stepId: step.id,
          agentId: step.agentId,
          toolId: step.toolId,
          input: step.input,
          status: "failed",
          error: `Tool '${step.toolId}' not found`,
          durationMs: Date.now() - stepStartedAt,
        };
        success = false;
        this.bus.publish({
          type: "supervisor.step_failed",
          data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId, error: result.error, timestamp: Date.now() },
          source: "supervisor-agent",
          agentId: this.id,
          correlationId: plan.id,
        });
        if (this.failFast) {
          stepResults.push(result);
          break;
        }
      } else {
        try {
          const output = await this.toolRegistry.execute(step.toolId, step.input);
          result = {
            stepId: step.id,
            agentId: step.agentId,
            toolId: step.toolId,
            input: step.input,
            status: "completed",
            output,
            durationMs: Date.now() - stepStartedAt,
          };
          this.bus.publish({
            type: "supervisor.step_completed",
            data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId, output, durationMs: result.durationMs, timestamp: Date.now() },
            source: "supervisor-agent",
            agentId: this.id,
            correlationId: plan.id,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            stepId: step.id,
            agentId: step.agentId,
            toolId: step.toolId,
            input: step.input,
            status: "failed",
            error: msg,
            durationMs: Date.now() - stepStartedAt,
          };
          success = false;
          this.recordError(err);
          this.bus.publish({
            type: "supervisor.step_failed",
            data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId, error: msg, timestamp: Date.now() },
            source: "supervisor-agent",
            agentId: this.id,
            correlationId: plan.id,
          });
          if (this.failFast) {
            stepResults.push(result);
            break;
          }
        }
      }

      stepResults.push(result);
      this.recordActivity();
    }

    // If validation failed but we still executed, overall success is false
    if (!validation.valid) success = false;
    // If any step failed, success is false (already)
    if (stepResults.some((r) => r.status === "failed")) success = false;

    const completedAt = Date.now();
    const execution: PlanExecution = {
      planId: plan.id,
      task: plan.task,
      kind: plan.kind,
      symbol: plan.symbol,
      valid: validation.valid,
      validation,
      steps: stepResults,
      success,
      startedAt,
      completedAt,
    };

    this.executions.set(plan.id, execution);

    this.bus.publish({
      type: success ? "supervisor.plan_completed" : "supervisor.plan_failed",
      data: {
        planId: plan.id,
        task: plan.task,
        kind: plan.kind,
        symbol: plan.symbol,
        success,
        stepCount: stepResults.length,
        failedSteps: stepResults.filter((s) => s.status === "failed").map((s) => s.stepId),
        timestamp: completedAt,
        durationMs: completedAt - startedAt,
      },
      source: "supervisor-agent",
      agentId: this.id,
      correlationId: plan.id,
    });

    return execution;
  }

  // Convenience: plan + validate + execute in one call
  async submitTask(task: string, correlationId?: string): Promise<PlanExecution> {
    const plan = this.plan(task);
    if (correlationId) {
      // Re-publish plan_created with caller correlationId for tracing
      this.bus.publish({
        type: "supervisor.task_received",
        data: { planId: plan.id, task, correlationId, timestamp: Date.now() },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: correlationId ?? plan.id,
      });
    }
    return this.executePlan(plan);
  }

  getExecution(planId: string): PlanExecution | undefined {
    return this.executions.get(planId);
  }

  listExecutions(): PlanExecution[] {
    return [...this.executions.values()];
  }

  getHistory(limit?: number): PlanExecution[] {
    const all = [...this.executions.values()].sort((a, b) => a.startedAt - b.startedAt);
    if (limit !== undefined && limit > 0) return all.slice(-limit);
    return all;
  }
}
