// ============================================================================
// Finance Agent OS — Risk Engine
// Phase 10: Deterministic risk engine with comprehensive checks
// ============================================================================

import type { RiskConfig, RiskDecision } from "@finance/shared";
import type { TypedEventBus } from "@finance/core";

export interface RiskEngineConfig {
  maxPositionPct: number;
  maxOrderSize: number;
  maxPortfolioExposure: number;
  maxSymbolExposure: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxOpenPositions: number;
  maxLeverage: number;
  cooldownMs: number;
  confidenceThreshold: number;
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
  maxOrderSize: 10000,
  maxPortfolioExposure: 80,
  maxSymbolExposure: 25,
  maxDailyLoss: 5,
  maxDrawdown: 15,
  maxOpenPositions: 10,
  maxLeverage: 3,
  cooldownMs: 60_000,
  confidenceThreshold: 0.6,
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
  private peakEquity = 100000;

  constructor(private bus: TypedEventBus, config?: Partial<RiskEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(request: TradeRequest, portfolio: PortfolioSnapshot): RiskDecision {
    const rulesChecked: string[] = [];
    const reasons: string[] = [];
    let approvedQuantity = request.quantity;

    // 1. Confidence threshold check
    rulesChecked.push("confidence_threshold");
    if (request.confidence < this.config.confidenceThreshold) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Low confidence ${request.confidence} < ${this.config.confidenceThreshold}`);
    }

    // 2. Position size check
    const positionValue = request.quantity * request.price;
    if (positionValue > this.config.maxOrderSize) {
      approvedQuantity = Math.floor(this.config.maxOrderSize / request.price);
      reasons.push(`Order size ${positionValue.toFixed(2)} > max ${this.config.maxOrderSize}`);
    }
    rulesChecked.push("order_size");

    // 3. Cooldown check
    const lastTrade = this.lastTradeTime.get(request.symbol) ?? 0;
    if (Date.now() - lastTrade < this.config.cooldownMs) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Cooldown active`);
    }
    rulesChecked.push("cooldown");

    // 4. Open positions check
    const openPositions = portfolio.positions.length;
    if (request.side === "buy" && openPositions >= this.config.maxOpenPositions) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Max open positions ${openPositions} >= ${this.config.maxOpenPositions}`);
    }
    rulesChecked.push("open_positions");

    // 5. Symbol exposure check
    const existingPosition = portfolio.positions.find((p) => p.symbol === request.symbol);
    const existingValue = existingPosition ? existingPosition.quantity * existingPosition.currentPrice : 0;
    const totalValue = portfolio.equity;
    const symbolExposure = ((existingValue + positionValue) / totalValue) * 100;
    if (symbolExposure > this.config.maxSymbolExposure) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Symbol exposure ${symbolExposure.toFixed(1)}% > ${this.config.maxSymbolExposure}%`);
    }
    rulesChecked.push("symbol_exposure");

    // 6. Portfolio exposure check
    const totalPositionValue = portfolio.positions.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0) + positionValue;
    const portfolioExposure = (totalPositionValue / totalValue) * 100;
    if (portfolioExposure > this.config.maxPortfolioExposure) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Portfolio exposure ${portfolioExposure.toFixed(1)}% > ${this.config.maxPortfolioExposure}%`);
    }
    rulesChecked.push("portfolio_exposure");

    // 7. Daily loss check
    const dailyLossPct = (-this.dailyPnl / totalValue) * 100;
    if (dailyLossPct > this.config.maxDailyLoss) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Daily loss ${dailyLossPct.toFixed(1)}% > ${this.config.maxDailyLoss}%`);
    }
    rulesChecked.push("daily_loss");

    // 8. Drawdown check
    if (totalValue > this.peakEquity) this.peakEquity = totalValue;
    const drawdownPct = ((this.peakEquity - totalValue) / this.peakEquity) * 100;
    if (drawdownPct > this.config.maxDrawdown) {
      return this.makeDecision("REJECTED", request, reasons, rulesChecked, 0, portfolio, `Drawdown ${drawdownPct.toFixed(1)}% > ${this.config.maxDrawdown}%`);
    }
    rulesChecked.push("drawdown");

    // 9. Leverage check
    const leverage = totalPositionValue / portfolio.cash;
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

    return {
      id: `risk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      decision,
      reason: decision === "REJECTED" ? `Rejected: ${reasonText}` : reasonText,
      rulesChecked,
      requestedQuantity: request.quantity,
      approvedQuantity,
      riskMetrics: {
        exposure: (totalPositionValue / portfolio.equity) * 100,
        drawdown: this.peakEquity > 0 ? ((this.peakEquity - portfolio.equity) / this.peakEquity) * 100 : 0,
        concentration: 0,
        var: 0,
        sharpe: 0,
        totalValue: portfolio.equity,
        cash: portfolio.cash,
        positionCount: portfolio.positions.length,
        peakValue: this.peakEquity,
        dailyPnL: this.dailyPnl,
        leverage: totalPositionValue / portfolio.cash,
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
