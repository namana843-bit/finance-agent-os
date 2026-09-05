// ============================================================================
// Execution Pipeline — Signal -> Risk -> Permission -> Paper -> Result
// Orchestrates: validation, risk engine (RiskAgent.evaluate), permission check
// (via FinanceGateway permissions), canonical OrderManager, paper trading (PaperBroker), audit logging.
// Live trading is always blocked unless liveTradingEnabled===true AND
// LIVE_TRADING_ENABLED env === "true" (default: disabled).
// Enhanced: idempotent processing, duplicate protection, proper correlation IDs,
// partial-fill support, cancel/reject/retry-safe, event ordering guarantees,
// consistent order/trade/position relationships, audit events.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import type { RiskAgent, RiskDecision } from "../agents/risk/index.js";
import type { FinanceGateway } from "../gateway/finance-gateway.js";
import type { PaperBroker } from "../broker/paper-broker.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { OrderManager } from "../order-manager/order-manager.js";
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
  orderManager?: OrderManager;
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
  private orderManager?: OrderManager;
  private auditLogger?: AuditLogger;
  private audit: PipelineAuditLog;
  private config: PipelineConfig;
  private dailyCounts = new Map<string, number>();
  private inflight = new Map<string, Promise<PipelineResult>>();
  private completedByCorrelation = new Map<string, PipelineResult>();
  private orderIdempotency = new Map<string, string>(); // idempotencyKey -> orderId

  constructor(deps: ExecutionPipelineDeps) {
    this.bus = deps.bus;
    this.riskAgent = deps.riskAgent;
    this.gateway = deps.gateway;
    this.paperBroker = deps.paperBroker;
    this.orderManager = deps.orderManager;
    this.auditLogger = deps.auditLogger;
    this.audit = deps.pipelineAudit ?? new PipelineAuditLog(this.bus);
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...deps.config };
    if (this.config.liveTradingEnabled && !isLiveEnvEnabled()) {
      console.warn("[execution-pipeline] liveTradingEnabled requested but LIVE_TRADING_ENABLED!=true — forcing paper-only");
      this.config.liveTradingEnabled = false;
    }
  }

  getConfig(): PipelineConfig { return { ...this.config }; }
  getAuditLog(): PipelineAuditLog { return this.audit; }
  isLiveEnabled(): boolean { return this.config.liveTradingEnabled && isLiveEnvEnabled(); }
  enableLiveTrading(): void {
    if (!isLiveEnvEnabled()) throw new Error("Live trading not enabled — set LIVE_TRADING_ENABLED=true in env first");
    this.config.liveTradingEnabled = true;
  }
  disableLiveTrading(): void { this.config.liveTradingEnabled = false; }
  setAgentPermissions(agentId: string, perms: Partial<PermissionInput>): void { this.gateway.setAgentPermissions(agentId, perms as unknown as Record<string, unknown>); }
  getAgentPermissions(agentId: string): PermissionInput { return this.gateway.getAgentPermissions(agentId) as unknown as PermissionInput; }
  resetDailyCounts(): void { this.dailyCounts.clear(); this.gateway.resetDailyCounts(); this.completedByCorrelation.clear(); this.inflight.clear(); }
  setOrderManager(om: OrderManager): void { this.orderManager = om; }

  // Cancel/reject delegation to OrderManager with audit
  cancelOrder(orderId: string, reason?: string): boolean {
    if (this.orderManager) return this.orderManager.cancelOrder(orderId, reason);
    const cancelled = this.paperBroker.cancelOrder(orderId, reason);
    return !!cancelled;
  }
  rejectOrder(orderId: string, reason: string): boolean {
    if (this.orderManager) return this.orderManager.rejectOrder(orderId, reason);
    return false;
  }

  async execute(signal: unknown): Promise<PipelineResult> {
    const started = Date.now();
    const raw = signal as PipelineSignal;
    const correlationId = raw?.correlationId?.trim() || uuidv4();
    const signalId = raw?.id?.trim() || `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const idempotencyKey = (raw as unknown as { idempotencyKey?: string })?.idempotencyKey?.trim() || signalId || correlationId;

    // Idempotent duplicate protection — retry-safe execution
    const inflightKey = `${correlationId}:${idempotencyKey}`;
    const priorCompleted = this.completedByCorrelation.get(inflightKey);
    if (priorCompleted) return { ...priorCompleted, durationMs: Date.now() - started };
    const priorInflight = this.inflight.get(inflightKey);
    if (priorInflight) return priorInflight;

    const execPromise = this.executeInternal(signal, correlationId, signalId, started);
    this.inflight.set(inflightKey, execPromise);
    execPromise.then(res => {
      this.completedByCorrelation.set(inflightKey, res);
      this.inflight.delete(inflightKey);
    }).catch(() => this.inflight.delete(inflightKey));
    return execPromise;
  }

  private async executeInternal(signal: unknown, correlationId: string, signalId: string, started: number): Promise<PipelineResult> {
    const auditIds: string[] = [];
    const pushAudit = (stage: string, eventType: string, approved: boolean | null, reason?: string, details: Record<string, unknown> = {}): AuditEntry => {
      const e = this.audit.record({ correlationId, signalId, stage, eventType, approved, reason, details, timestamp: Date.now() });
      auditIds.push(e.id);
      if (this.auditLogger) {
        this.auditLogger.record({ id: e.id, type: eventType, data: { stage, approved, reason, ...details }, timestamp: e.timestamp, source: "execution-pipeline", correlationId, agentId: (signal as PipelineSignal)?.agentId } as unknown as Parameters<AuditLogger["record"]>[0]);
      }
      return e;
    };

    if (this.config.liveTradingEnabled && !isLiveEnvEnabled()) {
      pushAudit("live_disabled", PIPELINE_EVENTS.LIVE_BLOCKED, false, "Live trading blocked — LIVE_TRADING_ENABLED != true", { signal });
      return this.result(false, "live_disabled", "Live trading blocked — set LIVE_TRADING_ENABLED=true", correlationId, signalId, auditIds, started);
    }

    this.bus.publish({ type: PIPELINE_EVENTS.SIGNAL_RECEIVED, data: { signalId, correlationId, signal, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
    pushAudit("received", PIPELINE_EVENTS.SIGNAL_RECEIVED, null, undefined, { signal });

    const v = validateSignal(signal);
    if (!v.valid || !v.normalized) {
      pushAudit("validation", PIPELINE_EVENTS.VALIDATION_FAILED, false, v.reason, { signal });
      this.bus.publish({ type: PIPELINE_EVENTS.VALIDATION_FAILED, data: { signalId, correlationId, reason: v.reason, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(false, "validation", v.reason!, correlationId, signalId, auditIds, started);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }
    let normalized = v.normalized;
    const notionalCheck = validateNotional(normalized, this.config.maxOrderValue);
    if (!notionalCheck.valid) {
      pushAudit("validation", PIPELINE_EVENTS.VALIDATION_FAILED, false, notionalCheck.reason, { signal: normalized });
      this.bus.publish({ type: PIPELINE_EVENTS.VALIDATION_FAILED, data: { signalId, correlationId, reason: notionalCheck.reason, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(false, "validation", notionalCheck.reason!, correlationId, signalId, auditIds, started);
      this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
      return r;
    }
    normalized.correlationId = correlationId;
    normalized.id = signalId;
    pushAudit("validation", PIPELINE_EVENTS.VALIDATED, true, "validation passed", { signal: normalized });
    this.bus.publish({ type: PIPELINE_EVENTS.VALIDATED, data: { signalId, correlationId, signal: normalized, timestamp: Date.now() }, source: "execution-pipeline", correlationId });

    let riskDecision: RiskDecision | undefined;
    try {
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

    // Canonical order creation + execution with event ordering and retry-safe handling
    try {
      // Create canonical order via OrderManager if available
      let canonicalOrderId: string | undefined;
      let managedOrder: unknown = undefined;
      if (this.orderManager) {
        const idempotencyKey = normalized.id ?? signalId;
        // deduplicate
        const existingId = this.orderIdempotency.get(idempotencyKey);
        if (existingId) {
          const existingOrder = this.orderManager.getOrder(existingId);
          if (existingOrder && existingOrder.status !== "REJECTED" && existingOrder.status !== "FAILED") {
            managedOrder = existingOrder;
            canonicalOrderId = existingOrder.id;
          }
        }
        if (!canonicalOrderId) {
          const mo = this.orderManager.createOrder({
            symbol: normalized.symbol,
            side: normalized.side,
            type: (normalized.type as "market" | "limit" | "stop" | "stop_limit") ?? "market",
            quantity: normalized.quantity,
            price: normalized.price,
            strategy: normalized.strategy,
            agent: normalized.agentId,
            executionMode: "paper",
            clientOrderId: signalId,
            correlationId,
            idempotencyKey,
          });
          mo && (managedOrder = mo);
          canonicalOrderId = (mo as { id: string }).id;
          this.orderIdempotency.set(idempotencyKey, canonicalOrderId);
          // Move to PENDING -> SUBMITTED with ordering guarantee
          this.orderManager.updateStatus(canonicalOrderId, "PENDING");
          this.orderManager.updateStatus(canonicalOrderId, "SUBMITTED");
        }
      }

      const order = await this.paperBroker.createOrder(
        normalized.symbol,
        normalized.side,
        normalized.quantity,
        normalized.type ?? "market",
        normalized.price,
        { clientOrderId: signalId, correlationId, idempotencyKey: signalId },
      );
      if (order.status === "rejected") {
        if (this.orderManager && canonicalOrderId) this.orderManager.rejectOrder(canonicalOrderId, order.reason ?? "broker rejected");
        pushAudit("paper", PIPELINE_EVENTS.PAPER_FAILED, false, order.reason ?? "paper broker rejected order", { order });
        this.bus.publish({ type: PIPELINE_EVENTS.PAPER_FAILED, data: { signalId, correlationId, order, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
        const r = this.result(false, "paper", order.reason ?? "paper broker rejected order", correlationId, signalId, auditIds, started, riskDecision);
        (r as unknown as Record<string, unknown>).order = order;
        this.bus.publish({ type: PIPELINE_EVENTS.REJECTED, data: { ...r }, source: "execution-pipeline", correlationId });
        return r;
      }
      // Apply fill to canonical order for consistent state and trade linkage
      if (this.orderManager && canonicalOrderId) {
        if (order.status === "filled" || order.status === "partially_filled") {
          const fillQty = order.quantity;
          const fillPrice = order.filledPrice ?? normalized.price;
          const fee = order.fee ?? fillPrice * fillQty * 0.001;
          this.orderManager.applyFill(canonicalOrderId, { orderId: canonicalOrderId, symbol: normalized.symbol, side: normalized.side, quantity: fillQty, price: fillPrice, fee, timestamp: Date.now(), correlationId });
        }
      }
      this.dailyCounts.set(normalized.agentId, (this.dailyCounts.get(normalized.agentId) ?? 0) + 1);
      pushAudit("paper", PIPELINE_EVENTS.PAPER_EXECUTED, true, "paper order filled", { order, canonicalOrderId });
      this.bus.publish({ type: PIPELINE_EVENTS.PAPER_EXECUTED, data: { signalId, correlationId, order, canonicalOrderId, timestamp: Date.now() }, source: "execution-pipeline", correlationId });
      const r = this.result(true, "completed", "paper order executed", correlationId, signalId, auditIds, started, riskDecision, order);
      if (managedOrder) (r as unknown as Record<string, unknown>).managedOrder = managedOrder;
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

  async submit(signal: PipelineSignal): Promise<PipelineResult> { return this.execute(signal); }
}
