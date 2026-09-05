// ============================================================================
// Finance Agent OS — Paper Broker
// Realistic paper trading simulation supporting spot and futures-style
// Long/Short positions, position increase, partial/full close, position reversal,
// accurate average entry prices, fees, slippage, and PnL accounting.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import { verifyRiskTicket, markTicketRedeemed, type RiskApprovalTicket } from "../risk-engine/ticket.js";

export type { RiskApprovalTicket };

export interface PaperBrokerConfig {
  initialCash: number;
  slippage: number;
  fee: number;
  latencyMs: number;
  allowShort: boolean;
  requireRiskApproval?: boolean;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price: number;
  status: "pending" | "submitted" | "filled" | "partially_filled" | "cancelled" | "rejected";
  createdAt: number;
  filledAt?: number;
  filledPrice?: number;
  fee?: number;
  reason?: string;
  // extended for canonical lifecycle
  clientOrderId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  filledQuantity?: number;
  averageFillPrice?: number;
  version?: number;
}

export interface PaperPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: number;
}

export interface PaperPortfolio {
  cash: number;
  equity: number;
  positions: PaperPosition[];
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export class PaperBroker {
  public config: PaperBrokerConfig;
  public priceCache = new Map<string, number>();
  private cash: number;
  private positions = new Map<string, PaperPosition>();
  private orders = new Map<string, PaperOrder>();
  private orderHistory: PaperOrder[] = [];
  private realizedPnl = 0;
  private ordersByClient = new Map<string, PaperOrder>();
  private ordersByCorrelation = new Map<string, Set<string>>();
  private fillDedup = new Set<string>();
  private pendingByIdempotency = new Map<string, PaperOrder>();

  constructor(private bus: TypedEventBus, config?: Partial<PaperBrokerConfig>) {
    this.config = {
      initialCash: 100_000,
      slippage: 0.0005,
      fee: 0.001,
      latencyMs: 100,
      allowShort: true,
      ...config,
    };
    this.cash = this.config.initialCash;

    // Listen for market ticks to update prices and trigger pending limit orders
    bus.subscribeTo("market.tick", (event) => {
      const tick = event.data as { symbol?: string; price?: number };
      if (tick?.symbol && typeof tick.price === "number" && Number.isFinite(tick.price) && tick.price > 0) {
        this.updatePrice(tick.symbol, tick.price);
      }
    });
  }

  /**
   * Update market price for a symbol, recalculate position PnL,
   * and process any pending limit orders.
   */
  updatePrice(symbol: string, price: number): void {
    const sym = String(symbol ?? "").trim().toUpperCase();
    if (!sym || typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;

    this.priceCache.set(sym, price);
    this.updatePositionPrices(sym, price);
    this.matchLimitOrders(sym, price);
  }

  async createOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    type: "market" | "limit" = "market",
    price?: number,
    opts?: {
      clientOrderId?: string;
      correlationId?: string;
      idempotencyKey?: string;
      riskApprovalTicket?: RiskApprovalTicket;
      bypassRiskGate?: boolean;
    },
  ): Promise<PaperOrder> {
    const sym = String(symbol ?? "").trim().toUpperCase();
    // Idempotent duplicate protection by clientOrderId / idempotencyKey
    const dedupKey = opts?.idempotencyKey?.trim() || opts?.clientOrderId?.trim();
    if (dedupKey) {
      const existing = this.pendingByIdempotency.get(dedupKey) ?? this.ordersByClient.get(dedupKey);
      if (existing && existing.status !== "rejected" && existing.status !== "cancelled") return { ...existing };
    }
    if (opts?.clientOrderId) {
      const ex2 = this.ordersByClient.get(opts.clientOrderId);
      if (ex2 && ex2.status !== "rejected") return { ...ex2 };
    }

    if (!sym) {
      return this.rejectOrder("", side, quantity, type, "Invalid symbol");
    }

    if (side !== "buy" && side !== "sell") {
      return this.rejectOrder(sym, side, quantity, type, "Invalid side: must be 'buy' or 'sell'");
    }

    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
      return this.rejectOrder(sym, side, quantity, type, "Invalid quantity: must be a positive number");
    }

    if (type !== "market" && type !== "limit") {
      return this.rejectOrder(sym, side, quantity, type, "Invalid order type: must be 'market' or 'limit'");
    }

    // Phase 4: Strict Risk Gate enforcement at broker boundary
    if (this.config.requireRiskApproval && !opts?.bypassRiskGate) {
      const ticket = opts?.riskApprovalTicket;
      if (!ticket) {
        this.bus.publish({
          type: "audit.risk_bypass_attempt",
          data: {
            symbol: sym,
            side,
            quantity,
            price,
            reason: "Order attempted without mandatory RiskApprovalTicket",
            correlationId: opts?.correlationId,
            timestamp: Date.now(),
          },
          source: "paper-broker",
          agentId: "broker",
          correlationId: opts?.correlationId,
        });
        return this.rejectOrder(sym, side, quantity, type, "Risk approval missing: direct execution blocked by Risk Gate");
      }

      const verification = verifyRiskTicket(ticket, {
        symbol: sym,
        side,
        quantity,
        price,
        correlationId: opts?.correlationId,
      });

      if (!verification.valid) {
        this.bus.publish({
          type: "audit.risk_bypass_attempt",
          data: {
            symbol: sym,
            side,
            quantity,
            price,
            ticketId: ticket.ticketId,
            reason: verification.reason,
            correlationId: opts?.correlationId,
            timestamp: Date.now(),
          },
          source: "paper-broker",
          agentId: "broker",
          correlationId: opts?.correlationId,
        });
        return this.rejectOrder(sym, side, quantity, type, `Risk approval invalid: ${verification.reason}`);
      }

      // Mark redeemed to prevent ticket replay attacks
      markTicketRedeemed(ticket.ticketId, ticket.expiresAt);
    }

    const pos = this.positions.get(sym);

    if (type === "market") {
      const currentPrice = this.priceCache.get(sym) ?? price ?? 0;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return this.rejectOrder(sym, side, quantity, type, "No price available");
      }

      // Apply slippage for market orders
      const slippageAmount = currentPrice * this.config.slippage;
      const fillPrice = side === "buy" ? currentPrice + slippageAmount : currentPrice - slippageAmount;
      const fee = fillPrice * quantity * this.config.fee;

      // Pre-validation for cash / margin / position
      if (side === "buy") {
        const requiredCash = fillPrice * quantity + fee;
        if (this.cash < requiredCash) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient cash: need ${requiredCash.toFixed(2)}, have ${this.cash.toFixed(2)}`,
          );
        }
      } else {
        // side === "sell"
        if (pos && pos.side === "long") {
          // Long reduction or reversal
          if (quantity > pos.quantity && !this.config.allowShort) {
            return this.rejectOrder(
              sym,
              side,
              quantity,
              type,
              `Insufficient position: need ${quantity}, have ${pos.quantity}`,
            );
          }
          if (quantity > pos.quantity && this.config.allowShort) {
            const closeQty = pos.quantity;
            const closeProceeds = fillPrice * closeQty * (1 - this.config.fee);
            const availableCash = this.cash + closeProceeds;
            const shortQty = quantity - pos.quantity;
            const requiredMargin = fillPrice * shortQty * (1 + this.config.fee);
            if (availableCash < requiredMargin) {
              return this.rejectOrder(
                sym,
                side,
                quantity,
                type,
                `Insufficient margin to open short on reversal: need ${requiredMargin.toFixed(2)}, have ${availableCash.toFixed(2)}`,
              );
            }
          }
        } else {
          // No position or Short position
          if (!this.config.allowShort) {
            return this.rejectOrder(
              sym,
              side,
              quantity,
              type,
              `Insufficient position: need ${quantity}, have ${pos?.quantity ?? 0}`,
            );
          }
          const requiredMargin = fillPrice * quantity * (1 + this.config.fee);
          if (this.cash < requiredMargin) {
            return this.rejectOrder(
              sym,
              side,
              quantity,
              type,
              `Insufficient margin to open short: need ${requiredMargin.toFixed(2)}, have ${this.cash.toFixed(2)}`,
            );
          }
        }
      }

      // Create order in 'pending' state (with correlation/ids for canonical trace)
      const correlationId = opts?.correlationId ?? uuidv4();
      const clientOrderId = opts?.clientOrderId ?? uuidv4();
      const idempotencyKey = opts?.idempotencyKey ?? clientOrderId;
      const order: PaperOrder = {
        id: uuidv4(),
        symbol: sym,
        side,
        type: "market",
        quantity,
        price: currentPrice,
        status: "pending",
        createdAt: Date.now(),
        clientOrderId,
        correlationId,
        idempotencyKey,
        filledQuantity: 0,
        version: 1,
      };

      this.orders.set(order.id, order);
      this.orderHistory.push(order);
      this.ordersByClient.set(clientOrderId, order);
      this.pendingByIdempotency.set(idempotencyKey, order);
      if (!this.ordersByCorrelation.has(correlationId)) this.ordersByCorrelation.set(correlationId, new Set());
      this.ordersByCorrelation.get(correlationId)!.add(order.id);

      // Emit order.created — event ordering guarantee: created before submitted before filled
      this.bus.publish({
        type: "order.created",
        data: {
          orderId: order.id,
          clientOrderId,
          correlationId,
          symbol: sym,
          side,
          type,
          quantity,
          price: currentPrice,
          timestamp: order.createdAt,
          version: 1,
        },
        source: "paper-broker",
        agentId: "execution",
        correlationId,
      });

      // Simulate latency
      if (this.config.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.latencyMs));
      }

      // Transition to 'submitted' — versioned ordering guarantee
      order.status = "submitted";
      order.version = 2;
      this.bus.publish({
        type: "order.submitted",
        data: {
          orderId: order.id,
          clientOrderId: order.clientOrderId,
          correlationId: order.correlationId,
          symbol: sym,
          side,
          quantity,
          price: fillPrice,
          timestamp: Date.now(),
          version: 2,
        },
        source: "paper-broker",
        agentId: "execution",
        correlationId: order.correlationId,
      });

      // Execute trade fill — with idempotency guard
      this.executeTradeFill(order, fillPrice, fee, currentPrice);
      return { ...order };
    }

    // Limit order
    if (price === undefined || typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return this.rejectOrder(sym, side, quantity, type, "Invalid price for limit order: must be a positive number");
    }

    // Pre-validation for limit orders
    if (side === "buy") {
      const estimatedFee = price * quantity * this.config.fee;
      const requiredCash = price * quantity + estimatedFee;
      if (this.cash < requiredCash) {
        return this.rejectOrder(
          sym,
          side,
          quantity,
          type,
          `Insufficient cash: need ${requiredCash.toFixed(2)}, have ${this.cash.toFixed(2)}`,
        );
      }
    } else {
      if (pos && pos.side === "long") {
        if (quantity > pos.quantity && !this.config.allowShort) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient position: need ${quantity}, have ${pos.quantity}`,
          );
        }
        if (quantity > pos.quantity && this.config.allowShort) {
          const closeQty = pos.quantity;
          const closeProceeds = price * closeQty * (1 - this.config.fee);
          const availableCash = this.cash + closeProceeds;
          const shortQty = quantity - pos.quantity;
          const requiredMargin = price * shortQty * (1 + this.config.fee);
          if (availableCash < requiredMargin) {
            return this.rejectOrder(
              sym,
              side,
              quantity,
              type,
              `Insufficient margin to open short on reversal: need ${requiredMargin.toFixed(2)}, have ${availableCash.toFixed(2)}`,
            );
          }
        }
      } else {
        if (!this.config.allowShort) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient position: need ${quantity}, have ${pos?.quantity ?? 0}`,
          );
        }
        const requiredMargin = price * quantity * (1 + this.config.fee);
        if (this.cash < requiredMargin) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient margin to open short: need ${requiredMargin.toFixed(2)}, have ${this.cash.toFixed(2)}`,
          );
        }
      }
    }

    // Create limit order in 'pending' state with ids
    const limCorrelationId = opts?.correlationId ?? uuidv4();
    const limClientOrderId = opts?.clientOrderId ?? uuidv4();
    const limIdempotencyKey = opts?.idempotencyKey ?? limClientOrderId;
    const order: PaperOrder = {
      id: uuidv4(),
      symbol: sym,
      side,
      type: "limit",
      quantity,
      price,
      status: "pending",
      createdAt: Date.now(),
      clientOrderId: limClientOrderId,
      correlationId: limCorrelationId,
      idempotencyKey: limIdempotencyKey,
      filledQuantity: 0,
      version: 1,
    };

    this.orders.set(order.id, order);
    this.orderHistory.push(order);
    this.ordersByClient.set(limClientOrderId, order);
    this.pendingByIdempotency.set(limIdempotencyKey, order);
    if (!this.ordersByCorrelation.has(limCorrelationId)) this.ordersByCorrelation.set(limCorrelationId, new Set());
    this.ordersByCorrelation.get(limCorrelationId)!.add(order.id);

    // Emit order.created
    this.bus.publish({
      type: "order.created",
      data: {
        orderId: order.id,
        clientOrderId: limClientOrderId,
        correlationId: limCorrelationId,
        symbol: sym,
        side,
        type,
        quantity,
        price,
        timestamp: order.createdAt,
        version: 1,
      },
      source: "paper-broker",
      agentId: "execution",
      correlationId: limCorrelationId,
    });

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }

    // Transition to 'submitted'
    order.status = "submitted";
    order.version = 2;
    this.bus.publish({
      type: "order.submitted",
      data: {
        orderId: order.id,
        clientOrderId: limClientOrderId,
        correlationId: limCorrelationId,
        symbol: sym,
        side,
        quantity,
        price,
        timestamp: Date.now(),
        version: 2,
      },
      source: "paper-broker",
      agentId: "execution",
      correlationId: limCorrelationId,
    });

    // Limit orders remain open until matching market tick
    return { ...order };
  }

  cancelOrder(orderId: string, reason?: string): PaperOrder | null {
    const order = this.orders.get(orderId);
    if (!order) {
      // also try by clientOrderId
      const byClient = this.ordersByClient.get(orderId);
      if (byClient && (byClient.status === "pending" || byClient.status === "submitted" || byClient.status === "partially_filled")) {
        return this.cancelOrder(byClient.id, reason);
      }
      return null;
    }
    if (order.status !== "pending" && order.status !== "submitted" && order.status !== "partially_filled") {
      if (order.status === "cancelled") return { ...order }; // idempotent
      return null;
    }

    order.status = "cancelled";
    order.reason = reason ?? "cancel requested";
    order.version = (order.version ?? 1) + 1;

    this.bus.publish({
      type: "order.cancelled",
      data: {
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        correlationId: order.correlationId,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        timestamp: Date.now(),
        version: order.version,
        reason: order.reason,
      },
      source: "paper-broker",
      agentId: "execution",
      correlationId: order.correlationId,
    });

    return { ...order };
  }

  /**
   * Partial fill support — fills qty portion of order (idempotent via fillId)
   */
  async partialFill(orderId: string, fillQty: number, fillPrice?: number, opts?: { fillId?: string; correlationId?: string }): Promise<PaperOrder | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status === "filled" || order.status === "cancelled" || order.status === "rejected") return null;
    if (order.status !== "submitted" && order.status !== "pending" && order.status !== "partially_filled") return null;
    if (typeof fillQty !== "number" || !Number.isFinite(fillQty) || fillQty <= 0) return null;
    const already = order.filledQuantity ?? 0;
    if (already + fillQty > order.quantity + 1e-9) return null;
    const dedupKey = `${orderId}:${opts?.fillId ?? `${fillQty}:${fillPrice}`}`;
    if (this.fillDedup.has(dedupKey)) return { ...order };
    this.fillDedup.add(dedupKey);
    const price = fillPrice ?? order.price;
    const fee = price * fillQty * this.config.fee;
    const currentPrice = this.priceCache.get(order.symbol) ?? price;
    // Reuse trade fill logic for partial qty
    const filled = this.executePartialTradeFill(order, fillQty, price, fee, currentPrice);
    if (!filled) return null;
    // update filledQuantity and versioned status
    order.filledQuantity = (order.filledQuantity ?? 0) + fillQty;
    order.filledPrice = price;
    order.fee = (order.fee ?? 0) + fee;
    order.averageFillPrice = order.averageFillPrice ?? price;
    // average handled inside executePartial...
    if ((order.filledQuantity ?? 0) >= order.quantity - 1e-9) {
      order.status = "filled";
      order.filledAt = Date.now();
      order.version = (order.version ?? 1) + 1;
      this.bus.publish({
        type: "order.filled",
        data: { orderId: order.id, clientOrderId: order.clientOrderId, correlationId: order.correlationId ?? opts?.correlationId, symbol: order.symbol, side: order.side, quantity: fillQty, price, fee, timestamp: order.filledAt, version: order.version, filledQuantity: order.filledQuantity },
        source: "paper-broker",
        agentId: "execution",
        correlationId: order.correlationId ?? opts?.correlationId,
      });
    } else {
      order.status = "partially_filled";
      order.version = (order.version ?? 1) + 1;
      this.bus.publish({
        type: "order.partially_filled",
        data: { orderId: order.id, clientOrderId: order.clientOrderId, correlationId: order.correlationId ?? opts?.correlationId, symbol: order.symbol, side: order.side, quantity: fillQty, price, fee, timestamp: Date.now(), version: order.version, filledQuantity: order.filledQuantity, remaining: order.quantity - (order.filledQuantity ?? 0) },
        source: "paper-broker",
        agentId: "execution",
        correlationId: order.correlationId ?? opts?.correlationId,
      });
    }
    return { ...order };
  }

  private executePartialTradeFill(order: PaperOrder, qty: number, fillPrice: number, fee: number, currentMarketPrice: number): boolean {
    // Delegate to existing logic but with qty override — temporarily patch quantity
    const origQty = order.quantity;
    (order as unknown as { quantity: number }).quantity = qty;
    const ok = this.executeTradeFill(order, fillPrice, fee, currentMarketPrice);
    (order as unknown as { quantity: number }).quantity = origQty;
    // revert status set by executeTradeFill (it sets filled); we manage status ourselves, so undo its side-effects that assume full fill
    // executeTradeFill sets order.status=filled — caller will override; for partial we already set partially_filled
    // but for full close logic to remain correct we keep the position changes already applied
    if (!ok) {
      // restore
      (order as unknown as { quantity: number }).quantity = origQty;
    }
    return ok;
  }

  private executeTradeFill(
    order: PaperOrder,
    fillPrice: number,
    fee: number,
    currentMarketPrice: number,
  ): boolean {
    const sym = order.symbol;
    const side = order.side;
    const qty = order.quantity;
    const pos = this.positions.get(sym);
    const EPSILON = 1e-7;

    if (side === "buy") {
      const requiredCash = fillPrice * qty + fee;
      if (this.cash < requiredCash) {
        return false;
      }

      if (!pos) {
        // 1. Long entry
        this.cash -= (fillPrice * qty + fee);
        this.positions.set(sym, {
          symbol: sym,
          side: "long",
          quantity: qty,
          entryPrice: fillPrice,
          currentPrice: currentMarketPrice,
          unrealizedPnl: (currentMarketPrice - fillPrice) * qty,
          openedAt: Date.now(),
        });
      } else if (pos.side === "long") {
        // 2. Long increase
        this.cash -= (fillPrice * qty + fee);
        const totalQty = pos.quantity + qty;
        const avgPrice = (pos.entryPrice * pos.quantity + fillPrice * qty) / totalQty;
        pos.quantity = totalQty;
        pos.entryPrice = avgPrice;
        pos.currentPrice = currentMarketPrice;
        pos.unrealizedPnl = (currentMarketPrice - avgPrice) * totalQty;
      } else {
        // pos.side === "short"
        if (qty < pos.quantity - EPSILON) {
          // 7. Short partial close
          const realized = (pos.entryPrice - fillPrice) * qty;
          this.realizedPnl += realized;
          this.cash -= (fillPrice * qty + fee);
          pos.quantity -= qty;
          pos.currentPrice = currentMarketPrice;
          pos.unrealizedPnl = (pos.entryPrice - currentMarketPrice) * pos.quantity;
        } else if (Math.abs(qty - pos.quantity) <= EPSILON) {
          // 8. Short full close
          const realized = (pos.entryPrice - fillPrice) * pos.quantity;
          this.realizedPnl += realized;
          this.cash -= (fillPrice * pos.quantity + fee);
          this.positions.delete(sym);
        } else {
          // 12. Short to Long reversal (qty > pos.quantity)
          const closeQty = pos.quantity;
          const closeFee = fillPrice * closeQty * this.config.fee;
          const realized = (pos.entryPrice - fillPrice) * closeQty;
          this.realizedPnl += realized;
          this.cash -= (fillPrice * closeQty + closeFee);

          const remainQty = qty - closeQty;
          const openFee = fillPrice * remainQty * this.config.fee;
          this.cash -= (fillPrice * remainQty + openFee);
          this.positions.set(sym, {
            symbol: sym,
            side: "long",
            quantity: remainQty,
            entryPrice: fillPrice,
            currentPrice: currentMarketPrice,
            unrealizedPnl: (currentMarketPrice - fillPrice) * remainQty,
            openedAt: Date.now(),
          });
        }
      }
    } else {
      // side === "sell"
      if (!pos) {
        // 5. Short entry
        if (!this.config.allowShort) return false;
        const requiredMargin = fillPrice * qty * (1 + this.config.fee);
        if (this.cash < requiredMargin) {
          return false;
        }
        this.cash += (fillPrice * qty - fee);
        this.positions.set(sym, {
          symbol: sym,
          side: "short",
          quantity: qty,
          entryPrice: fillPrice,
          currentPrice: currentMarketPrice,
          unrealizedPnl: (fillPrice - currentMarketPrice) * qty,
          openedAt: Date.now(),
        });
      } else if (pos.side === "short") {
        // 6. Short increase
        if (!this.config.allowShort) return false;
        const requiredMargin = fillPrice * qty * (1 + this.config.fee);
        if (this.cash < requiredMargin) {
          return false;
        }
        this.cash += (fillPrice * qty - fee);
        const totalQty = pos.quantity + qty;
        const avgPrice = (pos.entryPrice * pos.quantity + fillPrice * qty) / totalQty;
        pos.quantity = totalQty;
        pos.entryPrice = avgPrice;
        pos.currentPrice = currentMarketPrice;
        pos.unrealizedPnl = (avgPrice - currentMarketPrice) * totalQty;
      } else {
        // pos.side === "long"
        if (qty < pos.quantity - EPSILON) {
          // 3. Long partial close
          const realized = (fillPrice - pos.entryPrice) * qty;
          this.realizedPnl += realized;
          this.cash += (fillPrice * qty - fee);
          pos.quantity -= qty;
          pos.currentPrice = currentMarketPrice;
          pos.unrealizedPnl = (currentMarketPrice - pos.entryPrice) * pos.quantity;
        } else if (Math.abs(qty - pos.quantity) <= EPSILON) {
          // 4. Long full close
          const realized = (fillPrice - pos.entryPrice) * pos.quantity;
          this.realizedPnl += realized;
          this.cash += (fillPrice * pos.quantity - fee);
          this.positions.delete(sym);
        } else {
          // 12. Long to Short reversal (qty > pos.quantity)
          if (!this.config.allowShort) return false;
          const closeQty = pos.quantity;
          const closeFee = fillPrice * closeQty * this.config.fee;
          const realized = (fillPrice - pos.entryPrice) * closeQty;
          this.realizedPnl += realized;
          this.cash += (fillPrice * closeQty - closeFee);

          const remainQty = qty - closeQty;
          const openFee = fillPrice * remainQty * this.config.fee;
          const requiredMargin = fillPrice * remainQty * (1 + this.config.fee);
          if (this.cash < requiredMargin) {
            this.positions.delete(sym);
            return false;
          }
          this.cash += (fillPrice * remainQty - openFee);
          this.positions.set(sym, {
            symbol: sym,
            side: "short",
            quantity: remainQty,
            entryPrice: fillPrice,
            currentPrice: currentMarketPrice,
            unrealizedPnl: (fillPrice - currentMarketPrice) * remainQty,
            openedAt: Date.now(),
          });
        }
      }
    }

    order.status = "filled";
    order.filledAt = Date.now();
    order.filledPrice = fillPrice;
    order.fee = fee;
    order.filledQuantity = order.quantity;
    order.version = (order.version ?? 1) + 1;

    this.bus.publish({
      type: "order.filled",
      data: {
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        correlationId: order.correlationId,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: fillPrice,
        fee,
        timestamp: order.filledAt,
        version: order.version,
      },
      source: "paper-broker",
      agentId: "execution",
      correlationId: order.correlationId,
    });
    // audit event
    this.bus.publish({
      type: "audit.order_filled",
      data: { orderId: order.id, clientOrderId: order.clientOrderId, correlationId: order.correlationId, symbol: order.symbol, side: order.side, price: fillPrice, fee, version: order.version, timestamp: order.filledAt },
      source: "paper-broker",
      agentId: "execution",
      correlationId: order.correlationId,
    });

    return true;
  }

  private matchLimitOrders(symbol: string, currentPrice: number): void {
    for (const order of this.orders.values()) {
      if (order.symbol !== symbol) continue;
      if (order.status !== "submitted" && order.status !== "pending") continue;
      if (order.type !== "limit") continue;

      if (order.side === "buy" && currentPrice <= order.price) {
        const fillPrice = order.price;
        const fee = fillPrice * order.quantity * this.config.fee;
        const filled = this.executeTradeFill(order, fillPrice, fee, currentPrice);

        if (!filled) {
          order.status = "rejected";
          order.reason = "Insufficient cash or margin at fill time";
          order.version = (order.version ?? 1) + 1;
          this.bus.publish({
            type: "order.rejected",
            data: {
              orderId: order.id,
              clientOrderId: order.clientOrderId,
              correlationId: order.correlationId,
              symbol: order.symbol,
              side: order.side,
              reason: order.reason,
              timestamp: Date.now(),
              version: order.version,
            },
            source: "paper-broker",
            agentId: "execution",
            correlationId: order.correlationId,
          });
        }
      } else if (order.side === "sell" && currentPrice >= order.price) {
        const fillPrice = order.price;
        const fee = fillPrice * order.quantity * this.config.fee;
        const filled = this.executeTradeFill(order, fillPrice, fee, currentPrice);

        if (!filled) {
          order.status = "rejected";
          order.reason = "Insufficient position or margin at fill time";
          order.version = (order.version ?? 1) + 1;
          this.bus.publish({
            type: "order.rejected",
            data: {
              orderId: order.id,
              clientOrderId: order.clientOrderId,
              correlationId: order.correlationId,
              symbol: order.symbol,
              side: order.side,
              reason: order.reason,
              timestamp: Date.now(),
              version: order.version,
            },
            source: "paper-broker",
            agentId: "execution",
            correlationId: order.correlationId,
          });
        }
      }
    }
  }

  private rejectOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    type: "market" | "limit" = "market",
    reason: string,
  ): PaperOrder {
    const order: PaperOrder = {
      id: uuidv4(),
      symbol,
      side: side === "buy" || side === "sell" ? side : "buy",
      type: type === "market" || type === "limit" ? type : "market",
      quantity: typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
      price: 0,
      status: "rejected",
      reason,
      createdAt: Date.now(),
      version: 1,
    };
    this.orderHistory.push(order);

    this.bus.publish({
      type: "order.rejected",
      data: { orderId: order.id, symbol, side: order.side, reason, timestamp: Date.now(), version: 1 },
      source: "paper-broker",
      agentId: "execution",
    });
    this.bus.publish({
      type: "audit.order_rejected",
      data: { orderId: order.id, symbol, side: order.side, reason, timestamp: Date.now() },
      source: "paper-broker",
      agentId: "execution",
    });

    return order;
  }

  updatePositionPrices(symbol: string, price: number): void {
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.currentPrice = price;
      if (pos.side === "long") {
        pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity;
      } else {
        pos.unrealizedPnl = (pos.entryPrice - price) * pos.quantity;
      }
    }
  }

  getPortfolio(): PaperPortfolio {
    const positions = [...this.positions.values()].map((p) => ({ ...p }));
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const positionValue = positions.reduce(
      (sum, p) => sum + (p.side === "long" ? p.currentPrice * p.quantity : -p.currentPrice * p.quantity),
      0,
    );

    return {
      cash: this.cash,
      equity: this.cash + positionValue,
      positions,
      totalPnl: this.realizedPnl + unrealizedPnl,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
    };
  }

  getOrderHistory(): PaperOrder[] {
    return this.orderHistory.map((o) => ({ ...o }));
  }

  getOpenOrders(): PaperOrder[] {
    return Array.from(this.orders.values())
      .filter((o) => o.status === "pending" || o.status === "submitted" || o.status === "partially_filled")
      .map((o) => ({ ...o }));
  }

  // Idempotent lookup helpers for canonical lifecycle
  getOrder(id: string): PaperOrder | undefined { return this.orders.get(id) ? { ...this.orders.get(id)! } : undefined; }
  getOrderByClientOrderId(clientOrderId: string): PaperOrder | undefined { const o = this.ordersByClient.get(clientOrderId); return o ? { ...o } : undefined; }
  getOrderByCorrelationId(correlationId: string): PaperOrder[] { const s = this.ordersByCorrelation.get(correlationId); if (!s) return []; return [...s].map(id => this.orders.get(id)!).filter(Boolean).map(o => ({ ...o })); }
}


