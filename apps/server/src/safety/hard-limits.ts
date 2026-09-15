// ============================================================================
// Finance Agent OS — Production Live Trading Safety: Hard Limits
// Phase 8: Hard, non-bypassable limit constraints.
// Enforces mathematical ceilings on order sizing, symbol exposure,
// portfolio exposure, daily loss drawdown, and concurrency before execution.
// ============================================================================

export interface HardLimitsConfig {
  /** Maximum notional value (USD/quote) for any single order */
  maxSingleOrderNotional: number;
  /** Maximum aggregate position notional allowed for any single symbol */
  maxPositionNotionalPerSymbol: number;
  /** Maximum gross exposure across all symbols combined */
  maxTotalPortfolioExposure: number;
  /** Maximum allowable daily loss before auto-blocking new trades */
  maxDailyLoss: number;
  /** Maximum number of concurrently open/pending orders */
  maxOpenOrders: number;
  /** Maximum orders allowed per 24-hour window */
  maxDailyOrders: number;
  /** Whether unhedged short selling is permitted */
  allowShorting: boolean;
  /** Maximum leverage factor (e.g. 1.0 = no margin) */
  maxLeverage: number;
}

export const DEFAULT_HARD_LIMITS: HardLimitsConfig = {
  maxSingleOrderNotional: 25_000,
  maxPositionNotionalPerSymbol: 50_000,
  maxTotalPortfolioExposure: 100_000,
  maxDailyLoss: 2_500,
  maxOpenOrders: 20,
  maxDailyOrders: 200,
  allowShorting: false,
  maxLeverage: 1.0,
};

export interface OrderEvaluationRequest {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  currentPositions: Array<{ symbol: string; quantity: number; currentPrice: number }>;
  currentOpenOrdersCount: number;
  currentDailyLoss: number;
  currentDailyOrdersCount: number;
  accountEquity: number;
}

export interface HardLimitViolation {
  code:
    | "EXCEEDS_SINGLE_ORDER_NOTIONAL"
    | "EXCEEDS_SYMBOL_POSITION_LIMIT"
    | "EXCEEDS_TOTAL_PORTFOLIO_EXPOSURE"
    | "EXCEEDS_DAILY_LOSS_LIMIT"
    | "EXCEEDS_MAX_OPEN_ORDERS"
    | "EXCEEDS_MAX_DAILY_ORDERS"
    | "UNAUTHORIZED_SHORTING"
    | "EXCEEDS_MAX_LEVERAGE"
    | "INVALID_QUANTITY_OR_PRICE";
  message: string;
  limitValue: number;
  actualValue: number;
}

export interface HardLimitsCheckResult {
  allowed: boolean;
  violations: HardLimitViolation[];
}

export class HardLimitViolationError extends Error {
  readonly violations: HardLimitViolation[];

  constructor(violations: HardLimitViolation[]) {
    super(`Hard limit violation: ${violations.map((v) => `[${v.code}] ${v.message}`).join("; ")}`);
    this.name = "HardLimitViolationError";
    this.violations = violations;
  }
}

export class HardLimitsValidator {
  private config: HardLimitsConfig;

  constructor(customConfig?: Partial<HardLimitsConfig>) {
    this.config = { ...DEFAULT_HARD_LIMITS, ...customConfig };
  }

  getConfig(): HardLimitsConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<HardLimitsConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Evaluates an incoming order against all hard limits.
   * Returns validation result or throws if assertAllowed=true.
   */
  evaluate(req: OrderEvaluationRequest, assertAllowed = false): HardLimitsCheckResult {
    const violations: HardLimitViolation[] = [];

    // 1. Basic sanity
    if (req.quantity <= 0 || req.price <= 0 || !Number.isFinite(req.quantity) || !Number.isFinite(req.price)) {
      violations.push({
        code: "INVALID_QUANTITY_OR_PRICE",
        message: `Quantity (${req.quantity}) and price (${req.price}) must be positive finite numbers`,
        limitValue: 0,
        actualValue: Math.min(req.quantity, req.price),
      });
      return { allowed: false, violations };
    }

    const orderNotional = req.quantity * req.price;

    // 2. Single order notional ceiling
    if (orderNotional > this.config.maxSingleOrderNotional) {
      violations.push({
        code: "EXCEEDS_SINGLE_ORDER_NOTIONAL",
        message: `Order notional $${orderNotional.toFixed(2)} exceeds hard single order limit $${this.config.maxSingleOrderNotional.toFixed(2)}`,
        limitValue: this.config.maxSingleOrderNotional,
        actualValue: orderNotional,
      });
    }

    // 3. Daily loss drawdown ceiling
    if (req.currentDailyLoss >= this.config.maxDailyLoss) {
      violations.push({
        code: "EXCEEDS_DAILY_LOSS_LIMIT",
        message: `Current daily loss $${req.currentDailyLoss.toFixed(2)} exceeds maximum daily loss threshold $${this.config.maxDailyLoss.toFixed(2)}`,
        limitValue: this.config.maxDailyLoss,
        actualValue: req.currentDailyLoss,
      });
    }

    // 4. Open orders count
    if (req.currentOpenOrdersCount >= this.config.maxOpenOrders) {
      violations.push({
        code: "EXCEEDS_MAX_OPEN_ORDERS",
        message: `Current open orders count (${req.currentOpenOrdersCount}) reached max limit (${this.config.maxOpenOrders})`,
        limitValue: this.config.maxOpenOrders,
        actualValue: req.currentOpenOrdersCount,
      });
    }

    // 5. Daily order count
    if (req.currentDailyOrdersCount >= this.config.maxDailyOrders) {
      violations.push({
        code: "EXCEEDS_MAX_DAILY_ORDERS",
        message: `Daily order count (${req.currentDailyOrdersCount}) reached max limit (${this.config.maxDailyOrders})`,
        limitValue: this.config.maxDailyOrders,
        actualValue: req.currentDailyOrdersCount,
      });
    }

    // 6. Existing symbol position & projected notional
    const currentPos = req.currentPositions.find(
      (p) => p.symbol.toUpperCase() === req.symbol.toUpperCase()
    );
    const currentQty = currentPos?.quantity ?? 0;
    const posPrice = currentPos?.currentPrice ?? req.price;

    let projectedQty = currentQty;
    if (req.side === "buy") {
      projectedQty += req.quantity;
    } else {
      projectedQty -= req.quantity;
    }

    // Shorting check
    if (!this.config.allowShorting && projectedQty < -1e-6) {
      violations.push({
        code: "UNAUTHORIZED_SHORTING",
        message: `Order results in short position (${projectedQty.toFixed(4)}) but shorting is disabled`,
        limitValue: 0,
        actualValue: projectedQty,
      });
    }

    const projectedSymbolNotional = Math.abs(projectedQty * posPrice);
    if (projectedSymbolNotional > this.config.maxPositionNotionalPerSymbol) {
      violations.push({
        code: "EXCEEDS_SYMBOL_POSITION_LIMIT",
        message: `Projected position notional for ${req.symbol} ($${projectedSymbolNotional.toFixed(2)}) exceeds limit $${this.config.maxPositionNotionalPerSymbol.toFixed(2)}`,
        limitValue: this.config.maxPositionNotionalPerSymbol,
        actualValue: projectedSymbolNotional,
      });
    }

    // 7. Total portfolio gross exposure & leverage
    let totalGrossExposure = 0;
    let foundSymbol = false;
    for (const p of req.currentPositions) {
      if (p.symbol.toUpperCase() === req.symbol.toUpperCase()) {
        totalGrossExposure += projectedSymbolNotional;
        foundSymbol = true;
      } else {
        totalGrossExposure += Math.abs(p.quantity * p.currentPrice);
      }
    }
    if (!foundSymbol) {
      totalGrossExposure += projectedSymbolNotional;
    }

    if (totalGrossExposure > this.config.maxTotalPortfolioExposure) {
      violations.push({
        code: "EXCEEDS_TOTAL_PORTFOLIO_EXPOSURE",
        message: `Projected gross portfolio exposure ($${totalGrossExposure.toFixed(2)}) exceeds maximum limit $${this.config.maxTotalPortfolioExposure.toFixed(2)}`,
        limitValue: this.config.maxTotalPortfolioExposure,
        actualValue: totalGrossExposure,
      });
    }

    if (req.accountEquity > 0) {
      const leverage = totalGrossExposure / req.accountEquity;
      if (leverage > this.config.maxLeverage) {
        violations.push({
          code: "EXCEEDS_MAX_LEVERAGE",
          message: `Projected leverage (${leverage.toFixed(2)}x) exceeds max leverage (${this.config.maxLeverage.toFixed(2)}x)`,
          limitValue: this.config.maxLeverage,
          actualValue: leverage,
        });
      }
    }

    const result = {
      allowed: violations.length === 0,
      violations,
    };

    if (assertAllowed && !result.allowed) {
      throw new HardLimitViolationError(violations);
    }

    return result;
  }
}
