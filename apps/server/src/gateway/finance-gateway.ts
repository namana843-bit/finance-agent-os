// ============================================================================
// Finance Agent OS — Finance Gateway
// Phase 11: Central authority between agents and execution layer
// Agents MUST request actions through the gateway — never execute directly.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { issueRiskTicket, type RiskApprovalTicket } from "../risk-engine/ticket.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionMode = "paper" | "live";

export interface GatewayConfig {
  executionMode: ExecutionMode;
  liveTradingEnabled: boolean;
  maxPendingRequests: number;
  requestTimeoutMs: number;
  requireRiskTicket?: boolean;
}

export interface TradeRequest {
  id?: string;
  clientOrderId?: string;
  idempotencyKey?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price: number;
  strategy?: string;
  agentId: string;
  correlationId?: string;
  ticket?: RiskApprovalTicket;
}

export interface GatewayDecision {
  requestId: string;
  approved: boolean;
  reason: string;
  riskApproved: boolean;
  portfolioApproved: boolean;
  executionMode: ExecutionMode;
  timestamp: number;
  correlationId: string;
  ticket?: RiskApprovalTicket;
}

export interface GatewayStats {
  totalRequests: number;
  approvedRequests: number;
  rejectedRequests: number;
  pendingRequests: number;
  lastRequestTime: number;
  executionMode: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Agent Permissions
// ---------------------------------------------------------------------------

export interface AgentPermissions {
  canTrade: boolean;
  canSubmitOrders: boolean;
  canCancelOrders: boolean;
  maxOrderSize: number;
  maxDailyOrders: number;
  allowedSymbols: string[];
  allowedStrategies: string[];
}

const DEFAULT_PERMISSIONS: AgentPermissions = {
  canTrade: true,
  canSubmitOrders: true,
  canCancelOrders: true,
  maxOrderSize: 50_000,
  maxDailyOrders: 100,
  allowedSymbols: [], // empty = all
  allowedStrategies: [], // empty = all
};

// ---------------------------------------------------------------------------
// Finance Gateway
// ---------------------------------------------------------------------------

export class FinanceGateway {
  private config: GatewayConfig;
  private agentPermissions = new Map<string, AgentPermissions>();
  private pendingRequests = new Map<string, TradeRequest>();
  private requestHistory: GatewayDecision[] = [];
  private agentDailyOrders = new Map<string, number>();
  private dedupByIdempotency = new Map<string, GatewayDecision>();
  private pendingByCorrelation = new Map<string, Promise<GatewayDecision>>();
  private lastRequestTime = 0;
  private totalRequests = 0;
  private approvedRequests = 0;
  private rejectedRequests = 0;

  constructor(
    private bus: TypedEventBus,
    config?: Partial<GatewayConfig>,
  ) {
    this.config = {
      executionMode: "paper",
      liveTradingEnabled: false,
      maxPendingRequests: 50,
      requestTimeoutMs: 15_000,
      ...config,
    };

    // NOTE: The gateway does NOT subscribe to gateway.trade_request to avoid
    // infinite recursion (it publishes that event in waitForRiskDecision).
    // Agents route through the gateway via submitRequest() directly.
    // The gateway publishes gateway.trade_request which the Risk Agent processes.
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  setExecutionMode(mode: ExecutionMode): void {
    this.config.executionMode = mode;
    console.log(`[gateway] execution mode set to: ${mode}`);
  }

  setAgentPermissions(agentId: string, permissions: Partial<AgentPermissions>): void {
    const existing = this.agentPermissions.get(agentId) ?? { ...DEFAULT_PERMISSIONS };
    this.agentPermissions.set(agentId, { ...existing, ...permissions });
    console.log(`[gateway] permissions set for agent: ${agentId}`);
  }

  getAgentPermissions(agentId: string): AgentPermissions {
    return this.agentPermissions.get(agentId) ?? { ...DEFAULT_PERMISSIONS };
  }

  // -------------------------------------------------------------------------
  // Request Processing — API submission path
  // -------------------------------------------------------------------------

  async submitRequest(request: TradeRequest): Promise<GatewayDecision> {
    const requestId = request.id?.trim() || request.clientOrderId?.trim() || uuidv4();
    const correlationId = request.correlationId?.trim() || uuidv4();
    const idempotencyKey = request.idempotencyKey?.trim() || request.clientOrderId?.trim() || `gw:${request.agentId}:${request.symbol.toUpperCase()}:${request.side}:${request.quantity}:${request.price}`;
    // Idempotent duplicate protection — return prior decision if same key already processed
    const prior = this.dedupByIdempotency.get(idempotencyKey);
    if (prior) return { ...prior };
    const pendingSame = this.pendingByCorrelation.get(correlationId);
    if (pendingSame) return pendingSame;
    const now = Date.now();
    this.lastRequestTime = now;
    this.totalRequests++;

    // 1. Validate the request
    const validation = this.validateRequest(request);
    if (!validation.valid) {
      this.rejectedRequests++;
      return this.makeDecision(requestId, false, validation.reason!, false, false, correlationId);
    }

    // 2. Check agent permissions
    const permCheck = this.checkAgentPermissions(request);
    if (!permCheck.allowed) {
      this.rejectedRequests++;
      return this.makeDecision(requestId, false, permCheck.reason!, false, false, correlationId);
    }

    // 3. Check pending request limit
    if (this.pendingRequests.size >= this.config.maxPendingRequests) {
      this.rejectedRequests++;
      return this.makeDecision(requestId, false, "Too many pending requests", false, false, correlationId);
    }

    // 4. Check execution mode safety
    if (this.config.executionMode === "live" && !this.config.liveTradingEnabled) {
      this.rejectedRequests++;
      return this.makeDecision(requestId, false, "Live trading not enabled — set LIVE_TRADING_ENABLED=true", false, false, correlationId);
    }

    // 5. Subscribe to risk decision and publish trade request — with idempotent tracking
    this.pendingRequests.set(requestId, { ...request, id: requestId, correlationId });
    const pendingPromise = this.waitForRiskDecision(requestId, correlationId, request).then(d => {
      this.dedupByIdempotency.set(idempotencyKey, d);
      this.pendingByCorrelation.delete(correlationId);
      // audit event for every gateway decision
      this.bus.publish({ type: d.approved ? "audit.gateway_approved" : "audit.gateway_rejected", data: { requestId, correlationId, idempotencyKey, approved: d.approved, reason: d.reason, timestamp: Date.now() }, source: "finance-gateway", agentId: request.agentId, correlationId });
      return d;
    });
    this.pendingByCorrelation.set(correlationId, pendingPromise);
    const decision = await pendingPromise;
    return decision;
  }

  // -------------------------------------------------------------------------
  // Risk decision wait — subscribes to both approved and rejected, cleans up both
  // -------------------------------------------------------------------------

  private waitForRiskDecision(
    requestId: string,
    correlationId: string,
    request: TradeRequest,
  ): Promise<GatewayDecision> {
    return new Promise<GatewayDecision>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        unsubApprove();
        unsubReject();
        this.pendingRequests.delete(requestId);
      };

      const onDecision = (approved: boolean, ticket?: RiskApprovalTicket) => {
        cleanup();

        if (!approved) {
          this.rejectedRequests++;
          resolve(this.makeDecision(requestId, false, "Risk engine rejected", false, false, correlationId));
          return;
        }

        const riskTicket = ticket ?? (this.config.requireRiskTicket ? undefined : issueRiskTicket({
          correlationId,
          riskDecisionId: `gw-${requestId}`,
          symbol: request.symbol,
          side: request.side,
          maxQuantity: request.quantity,
          maxPrice: request.price,
          agentId: request.agentId,
          strategy: request.strategy,
        }));

        if (!riskTicket && this.config.requireRiskTicket) {
          this.rejectedRequests++;
          resolve(this.makeDecision(requestId, false, "Risk approval rejected: missing verified risk approval ticket", false, false, correlationId));
          return;
        }

        // Check portfolio constraints
        const portfolioOk = this.checkPortfolioConstraints(request);
        if (!portfolioOk) {
          this.rejectedRequests++;
          resolve(this.makeDecision(requestId, false, "Portfolio constraints violated", true, false, correlationId, riskTicket));
          return;
        }

        this.approvedRequests++;
        this.agentDailyOrders.set(
          request.agentId,
          (this.agentDailyOrders.get(request.agentId) ?? 0) + 1,
        );

        const decision = this.makeDecision(requestId, true, "All gateway checks passed", true, true, correlationId, riskTicket);
        this.requestHistory.push(decision);
        if (this.requestHistory.length > 2000) {
          this.requestHistory.splice(0, this.requestHistory.length - 2000);
        }

        // Emit approval and forward as order.created — with proper ids, correlation, and ticket for canonical lifecycle
        this.bus.publish({
          type: "gateway.approved",
          data: { ...decision, request, ticket },
          source: "finance-gateway",
          correlationId,
        });

        this.bus.publish({
          type: "order.created",
          data: {
            id: requestId,
            clientOrderId: request.clientOrderId ?? requestId,
            correlationId,
            idempotencyKey: request.idempotencyKey ?? request.clientOrderId ?? requestId,
            symbol: request.symbol,
            side: request.side,
            type: request.type,
            quantity: request.quantity,
            price: request.price,
            strategy: request.strategy,
            agent: request.agentId,
            executionMode: this.config.executionMode,
            ticket,
            timestamp: Date.now(),
          },
          source: "finance-gateway",
          agentId: request.agentId,
          correlationId,
        });

        resolve(decision);
      };

      const unsubApprove = this.bus.subscribeTo("risk.approved", (event: FinanceEvent) => {
        const data = event.data as { correlationId?: string; id?: string; ticket?: RiskApprovalTicket };
        if (data?.correlationId === correlationId || data?.id === requestId) {
          onDecision(true, data?.ticket);
        }
      });

      const unsubReject = this.bus.subscribeTo("risk.rejected", (event: FinanceEvent) => {
        const data = event.data as { correlationId?: string; id?: string };
        if (data?.correlationId === correlationId || data?.id === requestId) {
          onDecision(false);
        }
      });

      const timeout = setTimeout(() => {
        cleanup();
        this.rejectedRequests++;
        resolve(this.makeDecision(requestId, false, "Risk decision timeout", false, false, correlationId));
      }, this.config.requestTimeoutMs);

      // Publish the trade request for risk evaluation
      this.bus.publish({
        type: "gateway.trade_request",
        data: { ...request, id: requestId, correlationId },
        source: "finance-gateway",
        agentId: request.agentId,
        correlationId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getStats(): GatewayStats {
    return {
      totalRequests: this.totalRequests,
      approvedRequests: this.approvedRequests,
      rejectedRequests: this.rejectedRequests,
      pendingRequests: this.pendingRequests.size,
      lastRequestTime: this.lastRequestTime,
      executionMode: this.config.executionMode,
    };
  }

  getRecentDecisions(limit = 50): GatewayDecision[] {
    return this.requestHistory.slice(-limit);
  }

  getConfig(): Readonly<GatewayConfig> {
    return { ...this.config };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private validateRequest(request: TradeRequest): { valid: boolean; reason?: string } {
    if (!request.symbol || typeof request.symbol !== "string") {
      return { valid: false, reason: "Symbol is required" };
    }
    if (!["buy", "sell"].includes(request.side)) {
      return { valid: false, reason: "Side must be buy or sell" };
    }
    if (!["market", "limit"].includes(request.type)) {
      return { valid: false, reason: "Type must be market or limit" };
    }
    if (typeof request.quantity !== "number" || request.quantity <= 0 || !Number.isFinite(request.quantity)) {
      return { valid: false, reason: "Quantity must be a positive number" };
    }
    if (typeof request.price !== "number" || request.price <= 0 || !Number.isFinite(request.price)) {
      return { valid: false, reason: "Price must be a positive number" };
    }
    if (!request.agentId || typeof request.agentId !== "string") {
      return { valid: false, reason: "Agent ID is required" };
    }
    return { valid: true };
  }

  private checkAgentPermissions(request: TradeRequest): { allowed: boolean; reason?: string } {
    const permissions = this.agentPermissions.get(request.agentId);

    if (permissions && !permissions.canTrade) {
      return { allowed: false, reason: `Agent '${request.agentId}' is not allowed to trade` };
    }

    if (permissions && !permissions.canSubmitOrders) {
      return { allowed: false, reason: `Agent '${request.agentId}' is not allowed to submit orders` };
    }

    if (permissions && permissions.maxOrderSize > 0) {
      const orderValue = request.quantity * request.price;
      if (orderValue > permissions.maxOrderSize) {
        return {
          allowed: false,
          reason: `Order value ${orderValue.toFixed(2)} exceeds max ${permissions.maxOrderSize}`,
        };
      }
    }

    if (permissions && permissions.maxDailyOrders > 0) {
      const dailyCount = this.agentDailyOrders.get(request.agentId) ?? 0;
      if (dailyCount >= permissions.maxDailyOrders) {
        return { allowed: false, reason: `Daily order limit reached: ${dailyCount}/${permissions.maxDailyOrders}` };
      }
    }

    if (permissions && permissions.allowedSymbols.length > 0) {
      if (!permissions.allowedSymbols.includes(request.symbol.toUpperCase())) {
        return {
          allowed: false,
          reason: `Symbol '${request.symbol}' not in allowed list for agent '${request.agentId}'`,
        };
      }
    }

    if (permissions && permissions.allowedStrategies.length > 0 && request.strategy) {
      if (!permissions.allowedStrategies.includes(request.strategy)) {
        return {
          allowed: false,
          reason: `Strategy '${request.strategy}' not allowed for agent '${request.agentId}'`,
        };
      }
    }

    return { allowed: true };
  }

  private checkPortfolioConstraints(_request: TradeRequest): boolean {
    // In a full implementation, this would check portfolio limits
    return true;
  }

  private makeDecision(
    requestId: string,
    approved: boolean,
    reason: string,
    riskApproved: boolean,
    portfolioApproved: boolean,
    correlationId: string,
    ticket?: RiskApprovalTicket,
  ): GatewayDecision {
    const decision: GatewayDecision = {
      requestId,
      approved,
      reason,
      riskApproved,
      portfolioApproved,
      executionMode: this.config.executionMode,
      timestamp: Date.now(),
      correlationId,
      ticket,
    };
    return decision;
  }

  private emitDecision(decision: GatewayDecision): void {
    const eventType = decision.approved ? "gateway.approved" : "gateway.rejected";
    this.bus.publish({
      type: eventType,
      data: decision,
      source: "finance-gateway",
      correlationId: decision.correlationId,
    });
  }

  resetDailyCounts(): void {
    this.agentDailyOrders.clear();
    console.log("[gateway] daily order counts reset");
  }
}
