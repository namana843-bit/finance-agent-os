// ============================================================================
// Finance Agent OS — Paper Broker
// Realistic paper trading simulation with limit orders, slippage, fees,
// lifecycle events, and consistency.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";

export interface PaperBrokerConfig {
  initialCash: number;
  slippage: number;
  fee: number;
  latencyMs: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price: number;
  status: "pending" | "submitted" | "filled" | "cancelled" | "rejected";
  createdAt: number;
  filledAt?: number;
  filledPrice?: number;
  fee?: number;
  reason?: string;
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

  constructor(private bus: TypedEventBus, config?: Partial<PaperBrokerConfig>) {
    this.config = {
      initialCash: 100_000,
      slippage: 0.0005,
      fee: 0.001,
      latencyMs: 100,
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
  ): Promise<PaperOrder> {
    const sym = String(symbol ?? "").trim().toUpperCase();

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

    if (type === "market") {
      const currentPrice = this.priceCache.get(sym) ?? price ?? 0;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return this.rejectOrder(sym, side, quantity, type, "No price available");
      }

      // Apply slippage for market orders
      const slippageAmount = currentPrice * this.config.slippage;
      const fillPrice = side === "buy" ? currentPrice + slippageAmount : currentPrice - slippageAmount;
      const fee = fillPrice * quantity * this.config.fee;

      // Validate cash/position before creating
      if (side === "buy") {
        const requiredCash = fillPrice * quantity + fee;
        if (requiredCash > this.cash) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient cash: need ${requiredCash.toFixed(2)}, have ${this.cash.toFixed(2)}`,
          );
        }
      } else {
        const pos = this.positions.get(sym);
        if (!pos || pos.quantity < quantity) {
          return this.rejectOrder(
            sym,
            side,
            quantity,
            type,
            `Insufficient position: need ${quantity}, have ${pos?.quantity ?? 0}`,
          );
        }
      }

      // Create order in 'pending' state
      const order: PaperOrder = {
        id: uuidv4(),
        symbol: sym,
        side,
        type: "market",
        quantity,
        price: currentPrice,
        status: "pending",
        createdAt: Date.now(),
      };

      this.orders.set(order.id, order);
      this.orderHistory.push(order);

      // Emit order.created
      this.bus.publish({
        type: "order.created",
        data: {
          orderId: order.id,
          symbol: sym,
          side,
          type,
          quantity,
          price: currentPrice,
          timestamp: order.createdAt,
        },
        source: "paper-broker",
        agentId: "execution",
      });

      // Simulate latency
      if (this.config.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.latencyMs));
      }

      // Transition to 'submitted'
      order.status = "submitted";
      this.bus.publish({
        type: "order.submitted",
        data: {
          orderId: order.id,
          symbol: sym,
          side,
          quantity,
          price: fillPrice,
          timestamp: Date.now(),
        },
        source: "paper-broker",
        agentId: "execution",
      });

      // Execute fill
      this.fillMarketOrder(order, fillPrice, fee);
      return order;
    }

    // Limit order
    if (price === undefined || typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return this.rejectOrder(sym, side, quantity, type, "Invalid price for limit order: must be a positive number");
    }

    // Validate cash / position at creation time
    if (side === "buy") {
      const estimatedFee = price * quantity * this.config.fee;
      const requiredCash = price * quantity + estimatedFee;
      if (requiredCash > this.cash) {
        return this.rejectOrder(
          sym,
          side,
          quantity,
          type,
          `Insufficient cash: need ${requiredCash.toFixed(2)}, have ${this.cash.toFixed(2)}`,
        );
      }
    } else {
      const pos = this.positions.get(sym);
      if (!pos || pos.quantity < quantity) {
        return this.rejectOrder(
          sym,
          side,
          quantity,
          type,
          `Insufficient position: need ${quantity}, have ${pos?.quantity ?? 0}`,
        );
      }
    }

    // Create limit order in 'pending' state
    const order: PaperOrder = {
      id: uuidv4(),
      symbol: sym,
      side,
      type: "limit",
      quantity,
      price,
      status: "pending",
      createdAt: Date.now(),
    };

    this.orders.set(order.id, order);
    this.orderHistory.push(order);

    // Emit order.created
    this.bus.publish({
      type: "order.created",
      data: {
        orderId: order.id,
        symbol: sym,
        side,
        type,
        quantity,
        price,
        timestamp: order.createdAt,
      },
      source: "paper-broker",
      agentId: "execution",
    });

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }

    // Transition to 'submitted'
    order.status = "submitted";
    this.bus.publish({
      type: "order.submitted",
      data: {
        orderId: order.id,
        symbol: sym,
        side,
        quantity,
        price,
        timestamp: Date.now(),
      },
      source: "paper-broker",
      agentId: "execution",
    });

    // Limit orders do NOT fill immediately — they remain open until matching market tick
    return order;
  }

  cancelOrder(orderId: string): PaperOrder | null {
    const order = this.orders.get(orderId);
    if (!order || (order.status !== "pending" && order.status !== "submitted")) {
      return null;
    }

    order.status = "cancelled";

    this.bus.publish({
      type: "order.cancelled",
      data: {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        timestamp: Date.now(),
      },
      source: "paper-broker",
      agentId: "execution",
    });

    return order;
  }

  private fillMarketOrder(order: PaperOrder, fillPrice: number, fee: number): void {
    order.status = "filled";
    order.filledAt = Date.now();
    order.filledPrice = fillPrice;
    order.fee = fee;

    if (order.side === "buy") {
      const cost = fillPrice * order.quantity + fee;
      this.cash -= cost;

      const existing = this.positions.get(order.symbol);
      if (existing) {
        const totalQty = existing.quantity + order.quantity;
        const avgPrice = (existing.entryPrice * existing.quantity + fillPrice * order.quantity) / totalQty;
        existing.quantity = totalQty;
        existing.entryPrice = avgPrice;
        existing.currentPrice = fillPrice;
        existing.unrealizedPnl = (fillPrice - avgPrice) * totalQty;
      } else {
        this.positions.set(order.symbol, {
          symbol: order.symbol,
          side: "long",
          quantity: order.quantity,
          entryPrice: fillPrice,
          currentPrice: fillPrice,
          unrealizedPnl: 0,
          openedAt: Date.now(),
        });
      }
    } else {
      const pos = this.positions.get(order.symbol)!;
      const realized = (fillPrice - pos.entryPrice) * order.quantity;
      this.realizedPnl += realized;
      this.cash += fillPrice * order.quantity - fee;

      pos.quantity -= order.quantity;
      if (pos.quantity <= 0.0000001) {
        this.positions.delete(order.symbol);
      } else {
        pos.unrealizedPnl = (fillPrice - pos.entryPrice) * pos.quantity;
      }
    }

    this.bus.publish({
      type: "order.filled",
      data: {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: fillPrice,
        fee,
        timestamp: order.filledAt,
      },
      source: "paper-broker",
      agentId: "execution",
    });
  }

  private matchLimitOrders(symbol: string, currentPrice: number): void {
    for (const order of this.orders.values()) {
      if (order.symbol !== symbol) continue;
      if (order.status !== "submitted" && order.status !== "pending") continue;
      if (order.type !== "limit") continue;

      if (order.side === "buy" && currentPrice <= order.price) {
        const fillPrice = order.price;
        const fee = fillPrice * order.quantity * this.config.fee;
        const cost = fillPrice * order.quantity + fee;

        if (this.cash < cost) {
          order.status = "rejected";
          order.reason = `Insufficient cash at fill time: need ${cost.toFixed(2)}, have ${this.cash.toFixed(2)}`;
          this.bus.publish({
            type: "order.rejected",
            data: {
              orderId: order.id,
              symbol: order.symbol,
              side: order.side,
              reason: order.reason,
              timestamp: Date.now(),
            },
            source: "paper-broker",
            agentId: "execution",
          });
          continue;
        }

        this.cash -= cost;
        const existing = this.positions.get(symbol);
        if (existing) {
          const totalQty = existing.quantity + order.quantity;
          const avgPrice = (existing.entryPrice * existing.quantity + fillPrice * order.quantity) / totalQty;
          existing.quantity = totalQty;
          existing.entryPrice = avgPrice;
          existing.currentPrice = currentPrice;
          existing.unrealizedPnl = (currentPrice - avgPrice) * totalQty;
        } else {
          this.positions.set(symbol, {
            symbol,
            side: "long",
            quantity: order.quantity,
            entryPrice: fillPrice,
            currentPrice,
            unrealizedPnl: (currentPrice - fillPrice) * order.quantity,
            openedAt: Date.now(),
          });
        }

        order.status = "filled";
        order.filledAt = Date.now();
        order.filledPrice = fillPrice;
        order.fee = fee;

        this.bus.publish({
          type: "order.filled",
          data: {
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            price: fillPrice,
            fee,
            timestamp: order.filledAt,
          },
          source: "paper-broker",
          agentId: "execution",
        });
      } else if (order.side === "sell" && currentPrice >= order.price) {
        const pos = this.positions.get(symbol);
        if (!pos || pos.quantity < order.quantity) {
          order.status = "rejected";
          order.reason = `Insufficient position at fill time: need ${order.quantity}, have ${pos?.quantity ?? 0}`;
          this.bus.publish({
            type: "order.rejected",
            data: {
              orderId: order.id,
              symbol: order.symbol,
              side: order.side,
              reason: order.reason,
              timestamp: Date.now(),
            },
            source: "paper-broker",
            agentId: "execution",
          });
          continue;
        }

        const fillPrice = order.price;
        const fee = fillPrice * order.quantity * this.config.fee;
        const realized = (fillPrice - pos.entryPrice) * order.quantity;
        this.realizedPnl += realized;
        this.cash += fillPrice * order.quantity - fee;

        pos.quantity -= order.quantity;
        if (pos.quantity <= 0.0000001) {
          this.positions.delete(symbol);
        } else {
          pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.quantity;
        }

        order.status = "filled";
        order.filledAt = Date.now();
        order.filledPrice = fillPrice;
        order.fee = fee;

        this.bus.publish({
          type: "order.filled",
          data: {
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            price: fillPrice,
            fee,
            timestamp: order.filledAt,
          },
          source: "paper-broker",
          agentId: "execution",
        });
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
    };
    this.orderHistory.push(order);

    this.bus.publish({
      type: "order.rejected",
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
      pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity;
    }
  }

  getPortfolio(): PaperPortfolio {
    const positions = [...this.positions.values()].map((p) => ({ ...p }));
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const positionValue = positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

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
      .filter((o) => o.status === "pending" || o.status === "submitted")
      .map((o) => ({ ...o }));
  }
}

