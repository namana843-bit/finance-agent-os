import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import {
  ApprovalError,
  type ApprovalServiceOptions,
  type ProposalStatus,
  type ProposeInput,
  type TradeProposal,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asSide(value: unknown): "buy" | "sell" | null {
  return value === "buy" || value === "sell" ? value : null;
}

type ExecuteFn = (signal: Record<string, unknown>) => Promise<unknown>;

// Returns the executor bound to its owner so class methods keep `this`.
function asExecuteFn(value: unknown): ExecuteFn | undefined {
  if (typeof value === "function") {
    return value as ExecuteFn;
  }
  if (value !== null && typeof value === "object") {
    const execute = (value as { execute?: unknown }).execute;
    if (typeof execute === "function") {
      return (execute as ExecuteFn).bind(value);
    }
  }
  return undefined;
}

export class ApprovalService {
  private readonly bus: TypedEventBus;
  private readonly getPipeline: ApprovalServiceOptions["getPipeline"];
  private readonly mode: "auto-paper" | "always";
  private readonly executionMode: string;
  private readonly ttlMs: number;
  private readonly proposals = new Map<string, TradeProposal>();
  private nextId = 0;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(opts: ApprovalServiceOptions) {
    this.bus = opts.bus;
    this.getPipeline = opts.getPipeline;
    this.mode = opts.mode ?? "auto-paper";
    this.executionMode = opts.executionMode ?? "paper";
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  isGating(): boolean {
    return this.mode === "always" || this.executionMode === "live";
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type !== "quant.signal") return;
      try {
        const data = asRecord(event.data);
        if (!this.isGating()) return;
        const symbol = asString(data["symbol"]);
        if (symbol.length === 0) return;
        const side = asSide(data["action"] ?? data["side"]);
        if (side === null) return;
        const price = asNumber(data["price"], NaN);
        if (!Number.isFinite(price)) return;
        const quantity = asNumber(data["quantity"], asNumber(data["qty"], 0.05));
        const confidence = typeof data["confidence"] === "number" ? (data["confidence"] as number) : undefined;
        const reason = asString(data["reason"], "");
        const strategy = asString(data["strategy"], "");
        const signalId = asString(data["id"], "");
        const correlationId =
          typeof event.correlationId === "string" && event.correlationId.length > 0
            ? event.correlationId
            : asString(data["correlationId"], "");
        const threadId =
          typeof event.threadId === "string" && event.threadId.length > 0 ? event.threadId : null;
        this.propose({
          symbol,
          side,
          quantity,
          price,
          confidence,
          reason: reason.length > 0 ? reason : undefined,
          strategy: strategy.length > 0 ? strategy : undefined,
          signalId: signalId.length > 0 ? signalId : undefined,
          threadId,
          planId: correlationId.length > 0 ? correlationId : null,
        });
      } catch {
        // Never throw out of the event handler.
      }
    });
  }

  stop(): void {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        // ignore unsubscribe errors
      }
      this.unsubscribe = null;
    }
    this.started = false;
  }

  propose(input: ProposeInput): TradeProposal {
    const now = Date.now();
    this.nextId += 1;
    const proposal: TradeProposal = {
      id: `prop-${now}-${this.nextId}`,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      confidence: input.confidence,
      reason: input.reason,
      strategy: input.strategy,
      signalId: input.signalId,
      threadId: input.threadId ?? null,
      planId: input.planId ?? null,
      status: "pending",
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
    };
    this.proposals.set(proposal.id, proposal);
    this.bus.publish({
      type: "trade.proposal_created",
      data: { proposal },
      source: "approvals",
      threadId: input.threadId ?? undefined,
      correlationId: input.planId ?? input.signalId ?? undefined,
    });
    return proposal;
  }

  list(status?: ProposalStatus): TradeProposal[] {
    this.sweep();
    const all = [...this.proposals.values()];
    if (status === undefined) return all;
    return all.filter((p) => p.status === status);
  }

  get(id: string): TradeProposal | undefined {
    this.sweep();
    return this.proposals.get(id);
  }

  sweep(): void {
    const now = Date.now();
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== "pending") continue;
      if (proposal.expiresAt > now) continue;
      proposal.status = "expired";
      proposal.decidedAt = now;
      this.bus.publish({
        type: "trade.proposal_expired",
        data: { proposalId: proposal.id, proposal },
        source: "approvals",
        threadId: proposal.threadId ?? undefined,
        correlationId: proposal.planId ?? proposal.signalId ?? undefined,
      });
    }
  }

  async approve(
    id: string,
    opts?: { agentId?: string },
  ): Promise<{ proposal: TradeProposal; result: unknown }> {
    this.sweep();
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new ApprovalError("NOT_FOUND", `proposal not found: ${id}`);
    }
    if (proposal.status === "expired") {
      throw new ApprovalError("EXPIRED", `proposal expired: ${id}`);
    }
    if (proposal.status !== "pending") {
      throw new ApprovalError("NOT_PENDING", `proposal is not pending: ${id}`);
    }
    if (Date.now() > proposal.expiresAt) {
      proposal.status = "expired";
      proposal.decidedAt = Date.now();
      this.bus.publish({
        type: "trade.proposal_expired",
        data: { proposalId: proposal.id, proposal },
        source: "approvals",
        threadId: proposal.threadId ?? undefined,
        correlationId: proposal.planId ?? proposal.signalId ?? undefined,
      });
      throw new ApprovalError("EXPIRED", `proposal expired: ${id}`);
    }
    const pipelineFactory = this.getPipeline;
    if (pipelineFactory === undefined || pipelineFactory === null) {
      throw new ApprovalError("NO_PIPELINE", "no execution pipeline available");
    }
    const signal: Record<string, unknown> = {
      id: proposal.id,
      symbol: proposal.symbol,
      side: proposal.side,
      quantity: proposal.quantity,
      price: proposal.price,
      type: "market",
      agentId: opts?.agentId ?? "approvals",
      strategy: proposal.strategy ?? "approval",
      confidence: proposal.confidence ?? 0.7,
      timestamp: Date.now(),
      correlationId: proposal.planId ?? proposal.id,
    };
    let result: unknown;
    try {
      // Primary contract: factory returns `{ execute }`.
      // Tolerance: `getPipeline` may itself be an (async) executor
      // `(signal) => Promise<result>` — then the produced/awaited value
      // without an `execute` function IS the execution result.
      const produced: unknown = pipelineFactory();
      const direct = asExecuteFn(produced);
      if (direct !== undefined) {
        result = await direct(signal);
      } else if (produced instanceof Promise) {
        const awaited: unknown = await produced;
        const nested = asExecuteFn(awaited);
        if (nested !== undefined) {
          result = await nested(signal);
        } else if (awaited !== undefined && awaited !== null) {
          result = awaited;
        } else {
          throw new ApprovalError("NO_PIPELINE", "no execution pipeline available");
        }
      } else {
        throw new ApprovalError("NO_PIPELINE", "no execution pipeline available");
      }
    } catch (err) {
      if (err instanceof ApprovalError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      proposal.status = "failed";
      proposal.decidedAt = Date.now();
      this.bus.publish({
        type: "trade.proposal_failed",
        data: { proposalId: proposal.id, error: message },
        source: "approvals",
        threadId: proposal.threadId ?? undefined,
        correlationId: proposal.planId ?? proposal.signalId ?? undefined,
      });
      throw err;
    }
    proposal.status = "approved";
    proposal.decidedAt = Date.now();
    proposal.result = result;
    this.bus.publish({
      type: "trade.proposal_approved",
      data: { proposalId: proposal.id, proposal, result },
      source: "approvals",
      threadId: proposal.threadId ?? undefined,
      correlationId: proposal.planId ?? proposal.id,
    });
    return { proposal, result };
  }

  reject(id: string, reason = "rejected by user"): TradeProposal {
    this.sweep();
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new ApprovalError("NOT_FOUND", `proposal not found: ${id}`);
    }
    if (proposal.status !== "pending") {
      throw new ApprovalError("NOT_PENDING", `proposal is not pending: ${id}`);
    }
    proposal.status = "rejected";
    proposal.decidedAt = Date.now();
    this.bus.publish({
      type: "trade.proposal_rejected",
      data: { proposalId: proposal.id, proposal, reason },
      source: "approvals",
      threadId: proposal.threadId ?? undefined,
      correlationId: proposal.planId ?? proposal.signalId ?? undefined,
    });
    return proposal;
  }
}
