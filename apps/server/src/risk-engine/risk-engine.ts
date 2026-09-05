// ============================================================================
// Finance Agent OS — Risk Engine
// Phase 10: Deterministic risk engine with comprehensive checks
// ============================================================================

import type { RiskConfig, RiskDecision } from "@finance/shared";
import type { TypedEventBus } from "@finance/core";
import { issueRiskTicket, type RiskApprovalTicket } from "./ticket.js";

export type { RiskApprovalTicket };

export interface RiskEngineConfig {
  maxPositionPct: number;
  maxPositionSize: number;
  maxOrderSize: number;
  maxPortfolioExposure: number;
  maxSymbolExposure: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxOpenPositions: number;
  maxLeverage: number;
  cooldownMs: number;
  confidenceThreshold: number;
  staleThresholdMs: number;
  allowedSymbols: string[];
  blockedSymbols: string[];
  requireStopLoss: boolean;
}

export interface RiskMetricsResult {
  exposure: number;
  drawdown: number;
  leverage: number;
  dailyPnl: number;
  positionCount: number;
}

const DEFAULT_CONFIG: RiskEngineConfig = {
  maxPositionPct: 20,
  maxPositionSize: 100,
  maxOrderSize: 10000,
  maxPortfolioExposure: 80,
  maxSymbolExposure: 25,
  maxDailyLoss: 5,
  maxDrawdown: 15,
  maxOpenPositions: 10,
  maxLeverage: 3,
  cooldownMs: 15_000,
  confidenceThreshold: 0.6,
  staleThresholdMs: 30_000,
  allowedSymbols: [],
  blockedSymbols: [],
  requireStopLoss: false,
};

export interface TradeRequest {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  confidence: number;
  strategy: string;
  agentId: string;
  timestamp: number;
  correlationId: string;
  stopLoss?: number;
  takeProfit?: number;
  quoteTimestamp?: number;
}

export interface PortfolioSnapshot {
  cash: number;
  equity: number;
  positions: Array<{ symbol: string; quantity: number; entryPrice: number; currentPrice: number; side: "long" | "short" }>;
  dailyPnl: number;
  peakEquity: number;
}

export class RiskEngine {
  private config: RiskEngineConfig;
  private lastTradeTime = new Map<string, number>();
  private dailyTrades = 0;
  private dailyPnl = 0;
  private peakEquity = 0;

  constructor(private bus: TypedEventBus, config?: Partial<RiskEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(request: TradeRequest, portfolio: PortfolioSnapshot): RiskDecision {
    const rulesChecked: string[] = [];
    const reasons: string[] = [];
    let approvedQuantity = request.quantity;

    // 0. Quantity and price validity check
    rulesChecked.push("quantity_validity");
    if (!Number.isFinite(request.quantity) || request.quantity <= 0 || Number.isNaN(request.quantity)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Invalid order quantity: ${request.quantity}`);
    }
    if (!Number.isFinite(request.price) || request.price <= 0 || Number.isNaN(request.price)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Invalid order price: ${request.price}`);
    }

    // 1. Stale data check
    rulesChecked.push("stale_data");
    const quoteTime = request.quoteTimestamp ?? request.timestamp;
    if (quoteTime && Date.now() - quoteTime > this.config.staleThresholdMs) {
      const ageMs = Date.now() - quoteTime;
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Stale market data: age ${ageMs}ms exceeds limit ${this.config.staleThresholdMs}ms`);
    }

    // 2. Symbol restrictions check
    rulesChecked.push("symbol_restrictions");
    const sym = request.symbol.toUpperCase();
    if (this.config.blockedSymbols.some(s => s.toUpperCase() === sym)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Symbol ${sym} is restricted/blacklisted`);
    }
    if (this.config.allowedSymbols.length > 0 && !this.config.allowedSymbols.some(s => s.toUpperCase() === sym)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Symbol ${sym} is not in allowed list`);
    }

    // 3. Stop-loss requirement check
    rulesChecked.push("stop_loss_requirement");
    if (this.config.requireStopLoss && (!request.stopLoss || request.stopLoss <= 0)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Mandatory stop-loss missing for trade`);
    }

    // 4. Confidence threshold check
    rulesChecked.push("confidence_threshold");
    if (request.confidence < this.config.confidenceThreshold) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Low confidence ${request.confidence} < ${this.config.confidenceThreshold}`);
    }

    // 5. Position size check
    const positionValue = request.quantity * request.price;
    if (positionValue > this.config.maxOrderSize) {
      approvedQuantity = Math.floor(this.config.maxOrderSize / request.price);
      reasons.push(`Order size ${positionValue.toFixed(2)} > max ${this.config.maxOrderSize}`);
    }
    rulesChecked.push("order_size");

    // 6. Max position size (quantity) check
    const existingPosition = portfolio.positions.find((p) => p.symbol.toUpperCase() === sym);
    const currentQty = existingPosition ? existingPosition.quantity : 0;
    if (request.side === "buy" && (currentQty + approvedQuantity > this.config.maxPositionSize)) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Projected position ${currentQty + approvedQuantity} > maxPositionSize ${this.config.maxPositionSize}`);
    }
    rulesChecked.push("position_size");

    // 7. Margin / Cash check
    rulesChecked.push("margin_check");
    const requiredMargin = this.config.maxLeverage > 1 ? positionValue / this.config.maxLeverage : positionValue;
    if (request.side === "buy" && requiredMargin > portfolio.cash) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Insufficient cash/margin: required ${requiredMargin.toFixed(2)} > available ${portfolio.cash.toFixed(2)}`);
    }

    // 8. Cooldown check
    const lastTrade = this.lastTradeTime.get(request.symbol) ?? 0;
    if (Date.now() - lastTrade < this.config.cooldownMs) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Cooldown active`);
    }
    rulesChecked.push("cooldown");

    // 9. Open positions check
    const openPositions = portfolio.positions.length;
    if (request.side === "buy" && !existingPosition && openPositions >= this.config.maxOpenPositions) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Max open positions ${openPositions} >= ${this.config.maxOpenPositions}`);
    }
    rulesChecked.push("open_positions");

    // 10. Symbol exposure check
    const existingValue = existingPosition ? existingPosition.quantity * existingPosition.currentPrice : 0;
    const totalValue = portfolio.equity > 0 ? portfolio.equity : portfolio.cash;
    const symbolExposure = totalValue > 0 ? ((existingValue + positionValue) / totalValue) * 100 : 100;
    if (symbolExposure > this.config.maxSymbolExposure) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Symbol exposure ${symbolExposure.toFixed(1)}% > ${this.config.maxSymbolExposure}%`);
    }
    rulesChecked.push("symbol_exposure");

    // 11. Portfolio exposure check
    const totalPositionValue = portfolio.positions.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0) + positionValue;
    const portfolioExposure = totalValue > 0 ? (totalPositionValue / totalValue) * 100 : 0;
    if (portfolioExposure > this.config.maxPortfolioExposure) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Portfolio exposure ${portfolioExposure.toFixed(1)}% > ${this.config.maxPortfolioExposure}%`);
    }
    rulesChecked.push("portfolio_exposure");

    // 12. Daily loss check
    const dailyLossPct = totalValue > 0 ? (-this.dailyPnl / totalValue) * 100 : 0;
    if (dailyLossPct > this.config.maxDailyLoss) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Daily loss ${dailyLossPct.toFixed(1)}% > ${this.config.maxDailyLoss}%`);
    }
    rulesChecked.push("daily_loss");

    // 13. Drawdown check
    const peak = portfolio.peakEquity > 0 ? portfolio.peakEquity : (this.peakEquity > 0 ? this.peakEquity : totalValue);
    this.peakEquity = Math.max(peak, totalValue);
    const drawdownPct = this.peakEquity > 0 ? ((this.peakEquity - totalValue) / this.peakEquity) * 100 : 0;
    if (drawdownPct > this.config.maxDrawdown) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Drawdown ${drawdownPct.toFixed(1)}% > ${this.config.maxDrawdown}%`);
    }
    rulesChecked.push("drawdown");

    // 14. Leverage check
    const leverage = portfolio.cash > 0 ? totalPositionValue / portfolio.cash : 999;
    if (leverage > this.config.maxLeverage) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Leverage ${leverage.toFixed(2)}x > ${this.config.maxLeverage}x`);
    }
    rulesChecked.push("leverage");

    // All checks passed
    this.lastTradeTime.set(request.symbol, Date.now());
    this.dailyTrades++;

    const decision = this.makeDecision("APPROVED", request, reasons, rulesChecked, approvedQuantity, portfolio, "All risk checks passed");

    this.bus.publish({
      type: "risk.approved",
      data: decision,
      source: "risk-engine",
      agentId: "risk",
      correlationId: request.correlationId,
    });

    return decision;
  }

  private makeDecision(
    decision: "APPROVED" | "REJECTED",
    request: TradeRequest,
    reasons: string[],
    rulesChecked: string[],
    approvedQuantity: number,
    portfolio: PortfolioSnapshot,
    reasonText: string,
  ): RiskDecision {
    const totalPositionValue = portfolio.positions.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0);
    const decisionId = `risk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let ticket: RiskApprovalTicket | undefined = undefined;
    if (decision === "APPROVED" && approvedQuantity > 0) {
      ticket = issueRiskTicket({
        correlationId: request.correlationId,
        riskDecisionId: decisionId,
        symbol: request.symbol,
        side: request.side,
        maxQuantity: approvedQuantity,
        maxPrice: request.price,
        agentId: request.agentId,
        strategy: request.strategy,
      });
    }

    return {
      id: decisionId,
      decision,
      reason: decision === "REJECTED" ? `Rejected: ${reasonText}` : reasonText,
      rulesChecked,
      requestedQuantity: request.quantity,
      approvedQuantity,
      ticket,
      riskMetrics: {
        exposure: portfolio.equity > 0 ? (totalPositionValue / portfolio.equity) * 100 : 0,
        drawdown: this.peakEquity > 0 ? ((this.peakEquity - portfolio.equity) / this.peakEquity) * 100 : 0,
        concentration: 0,
        var: 0,
        sharpe: 0,
        totalValue: portfolio.equity,
        cash: portfolio.cash,
        positionCount: portfolio.positions.length,
        peakValue: this.peakEquity,
        dailyPnL: this.dailyPnl,
        leverage: portfolio.cash > 0 ? totalPositionValue / portfolio.cash : 0,
      },
      timestamp: Date.now(),
      correlationId: request.correlationId,
    };
  }

  updateDailyPnl(pnl: number): void {
    this.dailyPnl += pnl;
  }

  resetDaily(): void {
    this.dailyPnl = 0;
    this.dailyTrades = 0;
  }

  getConfig(): RiskEngineConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<RiskEngineConfig>): void {
    this.config = { ...this.config, ...patch };
  }
}
