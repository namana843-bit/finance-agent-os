// ============================================================================
// Finance Agent OS — Realistic Backtest Execution Simulator
// Phase 7: Slippage, Bid/Ask spread, Maker/Taker fees, Limit fills, and
// volume participation limit modeling.
// ============================================================================

import type { BacktestCandle } from "./backtest-engine.js";

export interface ExecutionConfig {
  slippageBps: number; // Slippage in basis points (e.g. 5 = 0.05%)
  spreadBps: number; // Bid/Ask spread in basis points (e.g. 4 = 0.04%)
  makerFeeRate: number; // Maker fee rate (e.g. 0.0005 = 0.05%)
  takerFeeRate: number; // Taker fee rate (e.g. 0.0010 = 0.10%)
  maxVolumeParticipation: number; // Max fraction of bar volume that can be filled (e.g. 0.10)
  minNotional: number; // Minimum order value in currency (e.g. 5.0)
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  slippageBps: 5,
  spreadBps: 4,
  makerFeeRate: 0.0005,
  takerFeeRate: 0.001,
  maxVolumeParticipation: 0.10,
  minNotional: 5.0,
};

export interface SimulatedOrder {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limitPrice?: number;
  timestamp: number;
}

export interface SimulatedFill {
  filled: boolean;
  order: SimulatedOrder;
  fillPrice: number;
  filledQuantity: number;
  fee: number;
  slippageAmount: number;
  spreadAmount: number;
  isMaker: boolean;
  reason?: string;
}

export class ExecutionSimulator {
  private config: ExecutionConfig;

  constructor(config?: Partial<ExecutionConfig>) {
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config };
  }

  getConfig(): ExecutionConfig {
    return { ...this.config };
  }

  /**
   * Simulates market order fill on the provided candle (typically open of next bar,
   * or close of current bar).
   */
  fillMarketOrder(
    order: SimulatedOrder,
    candle: BacktestCandle,
    availableCash: number,
    basePrice?: number
  ): SimulatedFill {
    const rawPrice = basePrice ?? candle.open ?? candle.close;
    if (rawPrice <= 0) {
      return {
        filled: false,
        order,
        fillPrice: 0,
        filledQuantity: 0,
        fee: 0,
        slippageAmount: 0,
        spreadAmount: 0,
        isMaker: false,
        reason: "Invalid candle price",
      };
    }

    // Volume participation limit: cannot trade more than maxVolumeParticipation of bar
    let qty = order.quantity;
    if (candle.volume > 0 && this.config.maxVolumeParticipation > 0) {
      const maxQty = candle.volume * this.config.maxVolumeParticipation;
      if (qty > maxQty) {
        qty = maxQty;
      }
    }

    const slippagePct = this.config.slippageBps / 10_000;
    const halfSpreadPct = (this.config.spreadBps / 2) / 10_000;

    let fillPrice: number;
    let slippageAmount: number;
    let spreadAmount: number;

    if (order.side === "buy") {
      // Buyer pays spread and incurs upward slippage
      spreadAmount = rawPrice * halfSpreadPct;
      slippageAmount = rawPrice * slippagePct;
      fillPrice = rawPrice + spreadAmount + slippageAmount;
    } else {
      // Seller incurs spread and downward slippage
      spreadAmount = rawPrice * halfSpreadPct;
      slippageAmount = rawPrice * slippagePct;
      fillPrice = rawPrice - spreadAmount - slippageAmount;
    }

    const feeRate = this.config.takerFeeRate;
    const fee = fillPrice * qty * feeRate;

    // Cash check for buy orders
    if (order.side === "buy") {
      const requiredCash = fillPrice * qty + fee;
      if (availableCash < requiredCash) {
        // Adjust quantity down to what available cash can buy
        const maxAffordableQty = availableCash / (fillPrice * (1 + feeRate));
        if (maxAffordableQty < 1e-6 || (maxAffordableQty * fillPrice < this.config.minNotional)) {
          return {
            filled: false,
            order,
            fillPrice,
            filledQuantity: 0,
            fee: 0,
            slippageAmount,
            spreadAmount,
            isMaker: false,
            reason: `Insufficient cash: required ${requiredCash.toFixed(2)} > available ${availableCash.toFixed(2)}`,
          };
        }
        qty = maxAffordableQty;
      }
    }

    return {
      filled: true,
      order,
      fillPrice,
      filledQuantity: qty,
      fee: fillPrice * qty * feeRate,
      slippageAmount,
      spreadAmount,
      isMaker: false,
    };
  }

  /**
   * Simulates limit order fill based on candle high/low range.
   */
  fillLimitOrder(
    order: SimulatedOrder,
    candle: BacktestCandle,
    availableCash: number
  ): SimulatedFill {
    if (!order.limitPrice || order.limitPrice <= 0) {
      return {
        filled: false,
        order,
        fillPrice: 0,
        filledQuantity: 0,
        fee: 0,
        slippageAmount: 0,
        spreadAmount: 0,
        isMaker: true,
        reason: "Missing limitPrice on limit order",
      };
    }

    const limitPrice = order.limitPrice;
    let canFill = false;
    let fillPrice = limitPrice;

    if (order.side === "buy") {
      // Buy limit fills if candle low touched or went below limitPrice
      if (candle.low <= limitPrice) {
        canFill = true;
        // Price improvement if candle opened below limit price
        fillPrice = Math.min(limitPrice, candle.open);
      }
    } else {
      // Sell limit fills if candle high touched or went above limitPrice
      if (candle.high >= limitPrice) {
        canFill = true;
        // Price improvement if candle opened above limit price
        fillPrice = Math.max(limitPrice, candle.open);
      }
    }

    if (!canFill) {
      return {
        filled: false,
        order,
        fillPrice: 0,
        filledQuantity: 0,
        fee: 0,
        slippageAmount: 0,
        spreadAmount: 0,
        isMaker: true,
        reason: `Limit price ${limitPrice} not reached in candle range [${candle.low}, ${candle.high}]`,
      };
    }

    let qty = order.quantity;
    if (candle.volume > 0 && this.config.maxVolumeParticipation > 0) {
      const maxQty = candle.volume * this.config.maxVolumeParticipation;
      if (qty > maxQty) {
        qty = maxQty;
      }
    }

    const feeRate = this.config.makerFeeRate; // Limit orders execute as maker
    const fee = fillPrice * qty * feeRate;

    if (order.side === "buy") {
      const requiredCash = fillPrice * qty + fee;
      if (availableCash < requiredCash) {
        const maxAffordableQty = availableCash / (fillPrice * (1 + feeRate));
        if (maxAffordableQty < 1e-6 || (maxAffordableQty * fillPrice < this.config.minNotional)) {
          return {
            filled: false,
            order,
            fillPrice,
            filledQuantity: 0,
            fee: 0,
            slippageAmount: 0,
            spreadAmount: 0,
            isMaker: true,
            reason: "Insufficient cash for limit fill",
          };
        }
        qty = maxAffordableQty;
      }
    }

    return {
      filled: true,
      order,
      fillPrice,
      filledQuantity: qty,
      fee: fillPrice * qty * feeRate,
      slippageAmount: 0, // Maker limit orders experience zero adverse slippage
      spreadAmount: 0,
      isMaker: true,
    };
  }
}
