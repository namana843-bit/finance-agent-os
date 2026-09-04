// ============================================================================
// Execution Pipeline — Signal -> Risk -> Permission -> Paper -> Result
// Orchestrates: validation, risk engine (RiskAgent.evaluate), permission check
// (via FinanceGateway permissions), paper trading (PaperBroker), audit logging.
// Live trading is always blocked unless liveTradingEnabled===true AND
// LIVE_TRADING_ENABLED env === "true" (default: disabled).
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import type { RiskAgent, RiskDecision } from "../agents/risk/index.js";
import type { FinanceGateway } from "../gateway/finance-gateway.js";
import type { PaperBroker } from "../broker/paper-broker.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { validateSignal, validateNotional } from "./validation.js";
import { checkPermission, type PermissionInput } from "./permission.js";
import { PipelineAuditLog } from "./audit.js";
import type { PipelineSignal, PipelineConfig, PipelineResult, AuditEntry } from "./types.js";
import { DEFAULT_PIPELINE_CONFIG, PIPELINE_EVENTS } from "./types.js";

export interface ExecutionPipelineDeps {
  bus: TypedEventBus;
  riskAgent: RiskAgent;
  gateway: FinanceGateway;
  paperBroker: PaperBroker;
  auditLogger?: AuditLogger;
  pipelineAudit?: PipelineAuditLog;
  config?: Partial<PipelineConfig>;
}

function isLiveEnvEnabled(): boolean {
  return process.env.LIVE_TRADING_ENABLED === "true";
}

export class ExecutionPipeline {
  readonly id = "execution-pipeline";
  private bus: TypedEventBus;
  private riskAgent: RiskAgent;
  private gateway: FinanceGateway;
  private paperBroker: PaperBroker;
  private auditLogger?: AuditLogger;
  private audit: PipelineAuditLog;
  private config: PipelineConfig;
  private dailyCounts = new Map<string, number>();

  constructor(deps: ExecutionPipelineDeps) {
    this.bus = deps.bus;
    this.riskAgent = deps.riskAgent;
    this.gateway = deps.gateway;
    this.paperBroker = deps.paperBroker;
    this.auditLogger = deps.auditLogger;
    this.audit = deps.pipelineAudit ?? new PipelineAuditLog(this.bus);
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...deps.config };
    // force live disabled unless env explicitly allows — default is always false
    if (this.config.liveTradingEnabled && !isLiveEnvEnabled()) {
      console.warn("[execution-pipeline] liveTradingEnabled requested but LIVE_TRADING_ENABLED!=true — forcing paper-only");
      this.config.liveTradingEnabled = false;
    }
  }

  getConfig(): PipelineConfig { return { ...this.config }; }

  getAuditLog(): PipelineAuditLog { return this.audit; }

  isLiveEnabled(): boolean { return this.config.liveTradingEnabled && isLiveEnvEnabled(); }

  enableLiveTrading(): void {
    if (!isLiveEnvEnabled()) {
      throw new Error("Live trading not enabled — set LIVE_TRADING_ENABLED=true in env first");
    }
    this.config.liveTradingEnabled = true;
  }

  disableLiveTrading(): void { this.config.liveTradingEnabled = false; }

  /** Direct permission setup — delegates to gateway for single source of truth */
  setAgentPermissions(agentId: string, perms: Partial<PermissionInput>): void {
    this.gateway.setAgentPermissions(agentId, perms as unknown as Record<string, unknown>);
  }

  getAgentPermissions(agentId: string): PermissionInput {
    return this.gateway.getAgentPermissions(agentId) as unknown as PermissionInput;
  }

  resetDailyCounts(): void { this.dailyCounts.clear(); this.gateway.resetDailyCounts(); }

  // -------------------------------------------------------------------------
  // Main pipeline: Signal -> Risk -> Permission -> Paper -> Result
  // -------------------------------------------------------------------------

  async execute(signal: unknown): Promise<PipelineResult> {
    const started = Date.now();
    const correlationId = (signal as PipelineSignal)?.correlationId?.trim() || uuidv4();
    const signalId = (signal as PipelineSignal)?.id?.trim() || `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const auditIds: string[] = [];

    const pushAudit = (stage: string, eventType: string, approved: boolean | null, reason?: string, details: Record<string, unknown> = {}): AuditEntry => {
      const e = this.audit.record({ correlationId, signalId, stage, eventType, approved, reason, details, timestamp: Date.now() });
      auditIds.push(e.id);
      // also mirror into global audit logger if available
      if (this.auditLogger) {
        this.auditLogger.record({ id: e.id, type: eventType, data: { stage, approved, reason, ...details }, timestamp: e.timestamp, source: "execution-pipeline", correlationId, agentId: (signal as PipelineSignal)?.agentId });
      }
      return e;
    };

    // Live guard — pipeline is paper-only unless live is explicitly enabled
    if (this.config.liveTradingEnabled && !isLiveEnvEnabled()) {
      pushAudit("live_disabled", PIPELINE_EVENTS.LIVE_BLOCKED, false, "Live trading blocked — LIVE_TRADING_ENABLED != true", { signal });
      return this.result(false, "live_disabled", "Live trading blocked — set LIVE_TRADING_ENABLED=true", correlationId, signalId, auditIds, started);
    }
    // If caller somehow requests live mode via signal (non-paper), block
    // Our pipeline always routes to paperBroker; live path is not implemented.

    // 0) Received
    this.bus.publish({ type: PIPELINE_EVENTS.SIGNAL_RECEIVED, data: { signalId, correlationId, signal, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
    pushAudit("received", PIPELINE_EVENTS.SIGNAL_RECEIVED, null, undefined, { signal });

    // 1) Validation
    const v = validateSignal(signal);
    if (!v.valid || !v.normalized) {
      pushAudit("validation", PIPELINE_EVENTS.VALIDATION_FAILED, false, v.reason, { signal });
      this.bus.publish({ type: PIPELINE_EVENTS.VALIDATION_FAILED, data: { signalId, correlationId, reason: v.reason, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(false, "validation", v.reason!, correlationId, signalId, auditIds, started);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }
    let normalized = v.normalized;
    // enforce maxOrderValue if configured
    const notionalCheck = validateNotional(normalized, this.config.maxOrderValue);
    if (!notionalCheck.valid) {
      pushAudit("validation", PIPELINE_EVENTS.VALIDATION_FAILED, false, notionalCheck.reason, { signal: normalized });
      this.bus.publish({ type: PIPELINE_EVENTS.VALIDATION_FAILED, data: { signalId, correlationId, reason: notionalCheck.reason, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(false, "validation", notionalCheck.reason!, correlationId, signalId, auditIds, started);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }
    // ensure ids propagated
    normalized.correlationId = correlationId;
    normalized.id = signalId;
    pushAudit("validation", PIPELINE_EVENTS.VALIDATED, true, "validation passed", { signal: normalized });
    this.bus.publish({ type: PIPELINE_EVENTS.VALIDATED, data: { signalId, correlationId, signal: normalized, timestamp: Date.now() }, source: "execution-pipeline", correlationId });

    // 2) Risk Engine
    let riskDecision: RiskDecision | undefined;
    try {
      // RiskAgent expects RiskSignal shape — map PipelineSignal -> RiskSignal
      const riskSignal = {
        id: normalized.id,
        symbol: normalized.symbol,
        action: normalized.side,
        side: normalized.side,
        confidence: normalized.confidence ?? 0.8,
        price: normalized.price,
        quantity: normalized.quantity,
        qty: normalized.quantity,
        timestamp: normalized.timestamp,
        correlationId,
        agentId: normalized.agentId,
        strategy: normalized.strategy,
      } as unknown as Parameters<RiskAgent["evaluate"]>[0];

      const decision = this.riskAgent.evaluate(riskSignal as never) as RiskDecision;
      // RiskAgent already publishes risk.approved/rejected — we just capture decision
      riskDecision = decision as unknown as RiskDecision;
      const approved = (decision as unknown as { approved: boolean }).approved;
      if (this.config.requireRiskApproval && !approved) {
        const reason = (decision as unknown as { reason: string }).reason ?? "Risk engine rejected";
        pushAudit("risk", PIPELINE_EVENTS.RISK_REJECTED, false, reason, { riskDecision: decision });
        this.bus.publish({ type: PIPELINE_EVENTS.RISK_REJECTED, data: { signalId, correlationId, reason, riskDecision: decision, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
        const r = this.result(false, "risk", reason, correlationId, signalId, auditIds, started, riskDecision);
        this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
        return r;
      }
      pushAudit("risk", PIPELINE_EVENTS.RISK_CHECKED, true, (decision as unknown as { reason: string }).reason ?? "risk approved", { riskDecision: decision });
      this.bus.publish({ type: PIPELINE_EVENTS.RISK_CHECKED, data: { signalId, correlationId, riskDecision: decision, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pushAudit("risk", PIPELINE_EVENTS.RISK_REJECTED, false, `risk error: ${reason}`, {});
      const r = this.result(false, "risk", `risk error: ${reason}`, correlationId, signalId, auditIds, started);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }

    // 3) Permission Check (after risk — per spec order)
    try {
      const perms = this.gateway.getAgentPermissions(normalized.agentId) as unknown as PermissionInput;
      const daily = this.dailyCounts.get(normalized.agentId) ?? 0;
      const permResult = checkPermission(normalized, perms, daily);
      if (!permResult.allowed) {
        pushAudit("permission", PIPELINE_EVENTS.PERMISSION_DENIED, false, permResult.reason, { agentId: normalized.agentId, perms });
        this.bus.publish({ type: PIPELINE_EVENTS.PERMISSION_DENIED, data: { signalId, correlationId, reason: permResult.reason, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
        const r = this.result(false, "permission", permResult.reason!, correlationId, signalId, auditIds, started, riskDecision);
        this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
        return r;
      }
      pushAudit("permission", PIPELINE_EVENTS.PERMISSION_CHECKED, true, "permission granted", { agentId: normalized.agentId });
      this.bus.publish({ type: PIPELINE_EVENTS.PERMISSION_CHECKED, data: { signalId, correlationId, agentId: normalized.agentId, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pushAudit("permission", PIPELINE_EVENTS.PERMISSION_DENIED, false, reason, {});
      const r = this.result(false, "permission", reason, correlationId, signalId, auditIds, started, riskDecision);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }

    // 4) Paper Trading (always paper — never live)
    try {
      const order = await this.paperBroker.createOrder(
        normalized.symbol,
        normalized.side,
        normalized.quantity,
        normalized.type ?? "market",
        normalized.price,
      );
      if (order.status === "rejected") {
        pushAudit("paper", PIPELINE_EVENTS.PAPER_FAILED, false, "paper broker rejected order", { order });
        this.bus.publish({ type: PIPELINE_EVENTS.PAPER_FAILED, data: { signalId, correlationId, order, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
        const r = this.result(false, "paper", "paper broker rejected order", correlationId, signalId, auditIds, started, riskDecision);
        (r as unknown as Record<string, unknown>).order = order;
        this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
        return r;
      }
      // success — increment daily counts
      this.dailyCounts.set(normalized.agentId, (this.dailyCounts.get(normalized.agentId) ?? 0) + 1);
      pushAudit("paper", PIPELINE_EVENTS.PAPER_EXECUTED, true, "paper order filled", { order });
      this.bus.publish({ type: PIPELINE_EVENTS.PAPER_EXECUTED, data: { signalId, correlationId, order, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(true, "completed", "paper order executed", correlationId, signalId, auditIds, started, riskDecision, order);
      this.bus.publish({ type: PIPELINE_EVENTS.COMPLETED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pushAudit("paper", PIPELINE_EVENTS.PAPER_FAILED, false, reason, {});
      const r = this.result(false, "paper", reason, correlationId, signalId, auditIds, started, riskDecision);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }
  }

  private result(
    success: boolean,
    stage: PipelineResult["stage"],
    reason: string,
    correlationId: string,
    signalId: string,
    auditIds: string[],
    started: number,
    riskDecision?: RiskDecision,
    order?: unknown,
  ): PipelineResult {
    return {
      success,
      stage,
      reason,
      correlationId,
      signalId,
      riskDecision,
      order: order as PipelineResult["order"],
      durationMs: Date.now() - started,
      auditIds: [...auditIds],
      timestamp: Date.now(),
    };
  }

  // Convenience alias
  async submit(signal: PipelineSignal): Promise<PipelineResult> {
    return this.execute(signal);
  }
}
