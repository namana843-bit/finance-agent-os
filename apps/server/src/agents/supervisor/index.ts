// ============================================================================
// SupervisorAgent — receives a finance task and produces a deterministic
// execution plan using AgentRegistry / ToolRegistry / EventBus.
// Example: "Analyze BTC" -> Market -> Research -> Strategy -> Risk -> Final
// ============================================================================

import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { AgentRegistry, ToolRegistry } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { createPlan, type Plan, type PlanStep, type ValidationResult } from "./planner.js";

export { createPlan, extractSymbol, classifyTask, stripPlan } from "./planner.js";
export type { Plan, PlanStep, TaskKind, ValidationResult } from "./planner.js";

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

export interface SupervisorOptions {
  bus?: TypedEventBus;
  agentRegistry?: AgentRegistry;
  toolRegistry?: ToolRegistry;
  /** Fail-fast: abort on first step failure. Default: true */
  failFast?: boolean;
}

// ---------------------------------------------------------------------------
// SupervisorAgent
// ---------------------------------------------------------------------------

export class SupervisorAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private agentRegistry?: AgentRegistry;
  private toolRegistry?: ToolRegistry;
  private failFast: boolean;
  private unsubscribe: (() => void) | null = null;
  private executions = new Map<string, PlanExecution>();
  private lastPlan: Plan | null = null;

  constructor(opts: SupervisorOptions = {}) {
    super({
      id: "supervisor",
      name: "Supervisor Agent",
      version: "0.1.0",
      description: "Deterministic planner: task -> Market -> Research -> Strategy -> Risk -> Final",
      capabilities: ["task-planning", "deterministic-routing", "execution-orchestration"],
    });
    this.bus = opts.bus ?? new TypedEventBus();
    this.agentRegistry = opts.agentRegistry;
    this.toolRegistry = opts.toolRegistry;
    this.failFast = opts.failFast ?? true;
  }

  // Allow late binding (useful when runtime creates registries after agent)
  setRegistries(registries: { agentRegistry: AgentRegistry; toolRegistry: ToolRegistry }): void {
    this.agentRegistry = registries.agentRegistry;
    this.toolRegistry = registries.toolRegistry;
  }

  getBus(): TypedEventBus {
    return this.bus;
  }

  async start(): Promise<void> {
    await super.start();
    // Subscribe to supervisor tasks via EventBus (external trigger)
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "supervisor.task" || event.type === "supervisor.execute") {
        const data = event.data as { task?: string; correlationId?: string } | null;
        const task = typeof data?.task === "string" ? data.task : typeof event.data === "string" ? event.data : "";
        if (task) {
          void this.submitTask(task, data?.correlationId).catch((err) => this.recordError(err));
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

      this.bus.publish({
        type: "supervisor.step_started",
        data: { planId: plan.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId ?? null, input: step.input, timestamp: stepStartedAt },
        source: "supervisor-agent",
        agentId: this.id,
        correlationId: plan.id,
      });

      let result: StepResult;

      if (!step.toolId) {
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
