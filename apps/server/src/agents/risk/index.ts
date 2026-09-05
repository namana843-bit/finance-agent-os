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

export { calculateExposure, calculateDrawdown, calculateVaR, calculateSharpe };

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
}

export interface RiskConfig {
  maxPositionPct: number;
  maxDrawdownPct: number;
  maxDailyLoss: number;
  maxLeverage: number;
  maxOpenPositions: number;
  confidenceThreshold: number;
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
}

export interface RiskDecision {
  approved: boolean;
  signal: RiskSignal;
  reason: string;
  checks: RiskChecks;
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
    };

    const reasons: string[] = [];

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
    const isBuy = normalized.action === "buy" || (normalized as unknown as { side?: string }).side === "buy";
    let projectedValue = existingValue;
    if (isBuy) {
      const qty = normalized.qty ?? normalized.quantity ?? 1;
      const notional = Number.isFinite(qty) ? normalized.price * qty : normalized.price;
      projectedValue = existingValue + notional;
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

    const decision: RiskDecision = {
      approved,
      signal: normalized,
      reason,
      checks,
      metrics: { exposure, drawdown, var: varValue },
    };

    const eventType = approved ? "risk.approved" : "risk.rejected";
    const sigCorrelation = (normalized as unknown as { correlationId?: string }).correlationId;
    const sigId = (normalized as unknown as { id?: string }).id;
    this.bus.publish({
      type: eventType,
      data: {
        ...decision,
        id: generateDecisionId(),
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
