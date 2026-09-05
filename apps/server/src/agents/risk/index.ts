import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import {
  calculateExposure,
  calculateDrawdown,
  calculateVaR,
  calculateSharpe,
} from "./metrics.js";
import { issueRiskTicket, type RiskApprovalTicket } from "../../risk-engine/ticket.js";

export { calculateExposure, calculateDrawdown, calculateVaR, calculateSharpe, issueRiskTicket };
export type { RiskApprovalTicket };

export interface RiskSignal {
  id?: string;
  symbol: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  price: number;
  timestamp?: number;
  reason?: string;
  indicators?: unknown;
  qty?: number;
  quantity?: number;
  stopLoss?: number;
  correlationId?: string;
  agentId?: string;
  strategy?: string;
}

export interface RiskConfig {
  maxPositionPct: number;
  maxDrawdownPct: number;
  maxDailyLoss: number;
  maxLeverage: number;
  maxOpenPositions: number;
  confidenceThreshold: number;
  maxPositionSize?: number;
  staleThresholdMs?: number;
  allowedSymbols?: string[];
  blockedSymbols?: string[];
  requireStopLoss?: boolean;
}

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
  currentPrice?: number;
  value?: number;
}

export interface PortfolioState {
  cash: number;
  positions: Map<string, Position>;
  dailyPnL: number;
  peakValue: number;
}

export interface RiskChecks {
  exposure: boolean;
  drawdown: boolean;
  concentration: boolean;
  confidence: boolean;
  var: boolean;
  validity?: boolean;
  freshness?: boolean;
  restrictions?: boolean;
}

export interface RiskDecision {
  approved: boolean;
  signal: RiskSignal;
  reason: string;
  checks: RiskChecks;
  ticket?: RiskApprovalTicket;
  metrics?: {
    exposure: number;
    drawdown: number;
    var: number;
  };
}

export interface RiskMetrics {
  exposure: number;
  drawdown: number;
  concentration: number;
  var: number;
  sharpe: number;
  totalValue: number;
  cash: number;
  positionCount: number;
  peakValue: number;
  dailyPnL: number;
  maxPositionPct: number;
  maxDrawdownPct: number;
  leverage: number;
}

function generateDecisionId(): string {
  return `risk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RiskAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private config: RiskConfig;
  private portfolio: PortfolioState;
  private unsubscribe: (() => void) | null = null;
  private rejectedLog: Array<{ signal: RiskSignal; reason: string; checks: RiskChecks; timestamp: number }> = [];
  private returnsHistory: number[] = [];
  private maxReturnsHistory = 200;

  constructor(bus?: TypedEventBus, config?: Partial<RiskConfig>, initialPortfolio?: Partial<PortfolioState>) {
    super({
      id: "risk",
      name: "Risk Agent",
      version: "0.1.0",
      description: "Risk management with exposure, drawdown, VaR, and Sharpe analysis",
      capabilities: ["risk-assessment", "trade-approval", "portfolio-protection"],
    });
    this.bus = bus ?? new TypedEventBus();
    this.config = {
      maxPositionPct: 20,
      maxDrawdownPct: 10,
      maxDailyLoss: 5,
      maxLeverage: 3,
      maxOpenPositions: 5,
      confidenceThreshold: 0.6,
      ...config,
    };
    const positions = initialPortfolio?.positions ?? new Map<string, Position>();
    this.portfolio = {
      cash: initialPortfolio?.cash ?? 100000,
      positions: positions instanceof Map ? new Map(positions) : new Map(),
      dailyPnL: initialPortfolio?.dailyPnL ?? 0,
      peakValue: initialPortfolio?.peakValue ?? 100000,
    };
    const total = this.getTotalValue();
    if (total > this.portfolio.peakValue) this.portfolio.peakValue = total;
  }

  async start(): Promise<void> {
    await super.start();
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "quant.signal" || event.type === "gateway.trade_request") {
        const signal = event.data as RiskSignal;
        if (signal && typeof signal.symbol === "string" && typeof signal.price === "number") {
          try {
            this.evaluate(signal);
          } catch (err) {
            this.recordError(err);
          }
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
    if (event.type === "quant.signal" || event.type === "gateway.trade_request") {
      const signal = event.data as RiskSignal;
      if (signal && typeof signal.symbol === "string" && typeof signal.price === "number") {
        this.evaluate(signal);
      }
    }
  }

  evaluate(signal: RiskSignal): RiskDecision {
    this.recordActivity();
    const sym = signal.symbol.toUpperCase();
    const normalized: RiskSignal = { ...signal, symbol: sym };

    const checks: RiskChecks = {
      exposure: true,
      drawdown: true,
      concentration: true,
      confidence: true,
      var: true,
      validity: true,
      freshness: true,
      restrictions: true,
    };

    const reasons: string[] = [];
    const isBuy = normalized.action === "buy" || (normalized as unknown as { side?: string }).side === "buy";
    const qty = normalized.qty ?? normalized.quantity ?? 1;

    // 0. Validity check (quantity and price)
    if (!Number.isFinite(qty) || qty <= 0 || Number.isNaN(qty)) {
      checks.validity = false;
      reasons.push(`Invalid quantity: ${qty}`);
    }
    if (!Number.isFinite(normalized.price) || normalized.price <= 0 || Number.isNaN(normalized.price)) {
      checks.validity = false;
      reasons.push(`Invalid price: ${normalized.price}`);
    }

    // 1. Freshness / Stale data check
    const sigTime = normalized.timestamp;
    const staleLimit = this.config.staleThresholdMs ?? 30_000;
    if (sigTime && Date.now() - sigTime > staleLimit) {
      checks.freshness = false;
      reasons.push(`Stale market data: age ${Date.now() - sigTime}ms exceeds limit ${staleLimit}ms`);
    }

    // 2. Symbol restrictions check
    if (this.config.blockedSymbols?.some(s => s.toUpperCase() === sym)) {
      checks.restrictions = false;
      reasons.push(`Symbol ${sym} is restricted/blacklisted`);
    }
    if (this.config.allowedSymbols && this.config.allowedSymbols.length > 0 && !this.config.allowedSymbols.some(s => s.toUpperCase() === sym)) {
      checks.restrictions = false;
      reasons.push(`Symbol ${sym} is not in allowed symbols list`);
    }

    // 3. Stop-loss requirement
    if (this.config.requireStopLoss && (!normalized.stopLoss || normalized.stopLoss <= 0)) {
      checks.restrictions = false;
      reasons.push(`Mandatory stop-loss missing for trade on ${sym}`);
    }

    // 4. Confidence threshold
    const conf = typeof normalized.confidence === "number" ? normalized.confidence : 0;
    if (conf < this.config.confidenceThreshold) {
      checks.confidence = false;
      reasons.push(`low confidence ${conf} < ${this.config.confidenceThreshold}`);
    }

    const totalValue = this.getTotalValue();
    const positionValues = this.getPositionValues();
    const exposure = calculateExposure(positionValues, totalValue);
    const drawdown = calculateDrawdown(totalValue, this.portfolio.peakValue);

    const maxTotalExposure = this.config.maxPositionPct * this.config.maxOpenPositions;
    if (exposure > maxTotalExposure) {
      checks.exposure = false;
      reasons.push(`exposure ${exposure.toFixed(2)}% > limit ${maxTotalExposure}%`);
    }

    if (drawdown > this.config.maxDrawdownPct) {
      checks.drawdown = false;
      reasons.push(`drawdown ${drawdown.toFixed(2)}% > maxDrawdown ${this.config.maxDrawdownPct}%`);
    }

    const existingPos = this.portfolio.positions.get(sym);
    const existingValue = existingPos ? this.estimatePositionValue(existingPos) : 0;
    const concentrationCurrent = totalValue > 0 ? (existingValue / totalValue) * 100 : 0;
    const notional = Number.isFinite(qty) && Number.isFinite(normalized.price) ? normalized.price * qty : 0;
    const projectedValue = isBuy ? existingValue + notional : existingValue;

    // Margin / Cash check
    if (isBuy && notional > this.portfolio.cash) {
      checks.exposure = false;
      reasons.push(`Insufficient cash/margin: required ${notional.toFixed(2)} > cash ${this.portfolio.cash.toFixed(2)}`);
    }

    // Max position size (quantity) check
    if (isBuy && this.config.maxPositionSize) {
      const currentQty = existingPos ? existingPos.qty : 0;
      if (currentQty + qty > this.config.maxPositionSize) {
        checks.concentration = false;
        reasons.push(`Projected position size ${currentQty + qty} > maxPositionSize ${this.config.maxPositionSize}`);
      }
    }

    const concentrationProjected = totalValue > 0 ? (projectedValue / totalValue) * 100 : 0;
    const concentrationToCheck = isBuy ? concentrationProjected : concentrationCurrent;
    if (concentrationToCheck > this.config.maxPositionPct) {
      checks.concentration = false;
      reasons.push(`concentration ${concentrationToCheck.toFixed(2)}% > maxPositionPct ${this.config.maxPositionPct}%`);
    }

    if (isBuy && !this.portfolio.positions.has(sym)) {
      if (this.portfolio.positions.size >= this.config.maxOpenPositions) {
        checks.concentration = false;
        reasons.push(`maxOpenPositions ${this.portfolio.positions.size} >= limit ${this.config.maxOpenPositions}`);
      }
    }

    let varValue = 0;
    if (this.returnsHistory.length >= 2) {
      varValue = calculateVaR(this.returnsHistory, 0.95);
      const varPct = varValue < 1 && varValue > 0 ? varValue * 100 : varValue;
      if (varPct > this.config.maxDailyLoss) {
        checks.var = false;
        reasons.push(`VaR ${varPct.toFixed(2)}% > maxDailyLoss ${this.config.maxDailyLoss}%`);
      }
    } else {
      const dailyLossPct = totalValue > 0 ? (-this.portfolio.dailyPnL / totalValue) * 100 : 0;
      varValue = Math.max(0, dailyLossPct);
      if (varValue > this.config.maxDailyLoss) {
        checks.var = false;
        reasons.push(`daily loss ${varValue.toFixed(2)}% > maxDailyLoss ${this.config.maxDailyLoss}%`);
      }
    }

    const approved = Object.values(checks).every(Boolean);
    const reason = approved ? "All risk checks passed" : `Rejected: ${reasons.join("; ")}`;

    const decisionId = generateDecisionId();
    const sigCorrelation = normalized.correlationId;
    const sigId = normalized.id;

    let ticket: RiskApprovalTicket | undefined = undefined;
    if (approved) {
      ticket = issueRiskTicket({
        correlationId: sigCorrelation ?? sigId ?? decisionId,
        riskDecisionId: decisionId,
        symbol: sym,
        side: isBuy ? "buy" : "sell",
        maxQuantity: qty,
        maxPrice: normalized.price,
        agentId: normalized.agentId ?? "risk",
        strategy: normalized.strategy,
      });
    }

    const decision: RiskDecision = {
      approved,
      signal: normalized,
      reason,
      checks,
      ticket,
      metrics: { exposure, drawdown, var: varValue },
    };

    const eventType = approved ? "risk.approved" : "risk.rejected";
    this.bus.publish({
      type: eventType,
      data: {
        ...decision,
        id: decisionId,
        ticket,
        correlationId: sigCorrelation ?? sigId,
        timestamp: Date.now(),
      },
      source: "risk-agent",
      agentId: "risk",
      correlationId: sigCorrelation ?? sigId,
    });

    // Also publish audit event
    this.bus.publish({
      type: approved ? "audit.risk_approved" : "audit.risk_rejected",
      data: {
        decisionId,
        approved,
        reason,
        symbol: sym,
        ticketId: ticket?.ticketId,
        correlationId: sigCorrelation ?? sigId,
        timestamp: Date.now(),
      },
      source: "risk-agent",
      agentId: "risk",
      correlationId: sigCorrelation ?? sigId,
    });

    if (!approved) {
      this.rejectedLog.push({ signal: normalized, reason, checks, timestamp: Date.now() });
      if (this.rejectedLog.length > 500) {
        this.rejectedLog.splice(0, this.rejectedLog.length - 500);
      }
    }

    if (totalValue > this.portfolio.peakValue) {
      this.portfolio.peakValue = totalValue;
    }

    return decision;
  }

  getRiskMetrics(): RiskMetrics {
    const totalValue = this.getTotalValue();
    const positionValues = this.getPositionValues();
    const exposure = calculateExposure(positionValues, totalValue);
    const drawdown = calculateDrawdown(totalValue, this.portfolio.peakValue);
    const varVal = this.returnsHistory.length >= 2 ? calculateVaR(this.returnsHistory, 0.95) : 0;
    const sharpe = this.returnsHistory.length >= 2 ? calculateSharpe(this.returnsHistory) : 0;

    let maxConcentration = 0;
    for (const pos of this.portfolio.positions.values()) {
      const val = this.estimatePositionValue(pos);
      const conc = totalValue > 0 ? (val / totalValue) * 100 : 0;
      if (conc > maxConcentration) maxConcentration = conc;
    }

    const positionSum = positionValues.reduce((a, b) => a + b, 0);
    const leverage = totalValue > 0 ? positionSum / totalValue : 0;

    return {
      exposure: Math.round(exposure * 100) / 100,
      drawdown: Math.round(drawdown * 100) / 100,
      concentration: Math.round(maxConcentration * 100) / 100,
      var: Math.round(varVal * 10000) / 10000,
      sharpe: Math.round(sharpe * 10000) / 10000,
      totalValue: Math.round(totalValue * 100) / 100,
      cash: this.portfolio.cash,
      positionCount: this.portfolio.positions.size,
      peakValue: this.portfolio.peakValue,
      dailyPnL: this.portfolio.dailyPnL,
      maxPositionPct: this.config.maxPositionPct,
      maxDrawdownPct: this.config.maxDrawdownPct,
      leverage: Math.round(leverage * 100) / 100,
    };
  }

  getPortfolio(): PortfolioState {
    return {
      cash: this.portfolio.cash,
      positions: new Map(this.portfolio.positions),
      dailyPnL: this.portfolio.dailyPnL,
      peakValue: this.portfolio.peakValue,
    };
  }

  addPosition(pos: Position): void {
    this.portfolio.positions.set(pos.symbol.toUpperCase(), { ...pos, symbol: pos.symbol.toUpperCase() });
    const total = this.getTotalValue();
    if (total > this.portfolio.peakValue) this.portfolio.peakValue = total;
  }

  removePosition(symbol: string): void {
    this.portfolio.positions.delete(symbol.toUpperCase());
  }

  getRejectedLog() {
    return [...this.rejectedLog];
  }

  getConfig(): RiskConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  setReturnsHistory(returns: number[]): void {
    this.returnsHistory = [...returns];
  }

  appendReturn(ret: number): void {
    this.returnsHistory.push(ret);
    if (this.returnsHistory.length > this.maxReturnsHistory) {
      this.returnsHistory.splice(0, this.returnsHistory.length - this.maxReturnsHistory);
    }
  }

  private getTotalValue(): number {
    let posSum = 0;
    for (const pos of this.portfolio.positions.values()) {
      posSum += this.estimatePositionValue(pos);
    }
    return this.portfolio.cash + posSum;
  }

  private getPositionValues(): number[] {
    const vals: number[] = [];
    for (const pos of this.portfolio.positions.values()) {
      vals.push(this.estimatePositionValue(pos));
    }
    return vals;
  }

  private estimatePositionValue(pos: Position): number {
    if (typeof pos.value === "number" && Number.isFinite(pos.value)) return pos.value;
    if (typeof pos.currentPrice === "number" && Number.isFinite(pos.currentPrice)) {
      return pos.qty * pos.currentPrice;
    }
    return pos.qty * pos.avgPrice;
  }
}
