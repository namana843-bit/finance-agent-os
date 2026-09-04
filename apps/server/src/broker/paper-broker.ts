// ============================================================================
// Finance Agent OS — Paper Broker
// Phase 14: Realistic paper trading simulation
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
  status: "pending" | "filled" | "cancelled" | "rejected";
  createdAt: number;
  filledAt?: number;
  filledPrice?: number;
  fee?: number;
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
  private config: PaperBrokerConfig;
  private cash: number;
  private positions = new Map<string, PaperPosition>();
  private orders: PaperOrder[] = [];
  private realizedPnl = 0;
  private orderHistory: PaperOrder[] = [];
  private priceCache = new Map<string, number>();

  constructor(private bus: TypedEventBus, config?: Partial<PaperBrokerConfig>) {
    this.config = {
      initialCash: 100_000,
      slippage: 0.0005,
      fee: 0.001,
      latencyMs: 100,
      ...config,
    };
    this.cash = this.config.initialCash;

    // Listen for market ticks to update prices
    bus.subscribeTo("market.tick", (event) => {
      const tick = event.data as { symbol: string; price: number };
      if (tick && tick.symbol) {
        this.priceCache.set(tick.symbol.toUpperCase(), tick.price);
        this.updatePositionPrices(tick.symbol.toUpperCase(), tick.price);
      }
    });
  }

  async createOrder(symbol: string, side: "buy" | "sell", quantity: number, type: "market" | "limit" = "market", price?: number): Promise<PaperOrder> {
    const sym = symbol.toUpperCase();
    const currentPrice = this.priceCache.get(sym) ?? price ?? 0;

    if (currentPrice <= 0) {
      return this.rejectOrder(sym, side, quantity, "No price available");
    }

    const orderPrice = type === "market" ? currentPrice : (price ?? currentPrice);

    // Validate
    if (side === "buy") {
      const requiredCash = orderPrice * quantity * (1 + this.config.fee);
      if (requiredCash > this.cash) {
        return this.rejectOrder(sym, side, quantity, `Insufficient cash: need ${requiredCash.toFixed(2)}, have ${this.cash.toFixed(2)}`);
      }
    } else {
      const pos = this.positions.get(sym);
      if (!pos || pos.quantity < quantity) {
        return this.rejectOrder(sym, side, quantity, `Insufficient position: need ${quantity}, have ${pos?.quantity ?? 0}`);
      }
    }

    // Apply slippage for market orders
    let fillPrice = orderPrice;
    if (type === "market") {
      const slippageAmount = orderPrice * this.config.slippage;
      fillPrice = side === "buy" ? orderPrice + slippageAmount : orderPrice - slippageAmount;
    }

    // Create order
    const order: PaperOrder = {
      id: uuidv4(),
      symbol: sym,
      side,
      type,
      quantity,
      price: orderPrice,
      status: "pending",
      createdAt: Date.now(),
    };

    this.orders.push(order);
    this.orderHistory.push({ ...order });

    // Emit order.created
    this.bus.publish({
      type: "order.created",
      data: {
        orderId: order.id,
        symbol: sym,
        side,
        type,
        quantity,
        price: orderPrice,
        timestamp: order.createdAt,
      },
      source: "paper-broker",
      agentId: "execution",
    });

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }

    // Emit order.submitted
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

    // Execute
    order.status = "filled";
    order.filledAt = Date.now();
    order.filledPrice = fillPrice;
    order.fee = fillPrice * quantity * this.config.fee;

    if (side === "buy") {
      const cost = fillPrice * quantity + order.fee;
      this.cash -= cost;

      const existing = this.positions.get(sym);
      if (existing) {
        const totalQty = existing.quantity + quantity;
        const avgPrice = (existing.entryPrice * existing.quantity + fillPrice * quantity) / totalQty;
        existing.quantity = totalQty;
        existing.entryPrice = avgPrice;
      } else {
        this.positions.set(sym, {
          symbol: sym,
          side: "long",
          quantity,
          entryPrice: fillPrice,
          currentPrice: fillPrice,
          unrealizedPnl: 0,
          openedAt: Date.now(),
        });
      }
    } else {
      const pos = this.positions.get(sym)!;
      const realized = (fillPrice - pos.entryPrice) * quantity;
      this.realizedPnl += realized;
      this.cash += fillPrice * quantity - order.fee;

      pos.quantity -= quantity;
      if (pos.quantity <= 0.0000001) {
        this.positions.delete(sym);
      }
    }

    // Publish events
    this.bus.publish({
      type: "order.filled",
      data: {
        orderId: order.id,
        symbol: sym,
        side,
        quantity,
        price: fillPrice,
        fee: order.fee,
        timestamp: order.filledAt,
      },
      source: "paper-broker",
      agentId: "execution",
    });

    return order;
  }

  private rejectOrder(symbol: string, side: "buy" | "sell", quantity: number, reason: string): PaperOrder {
    const order: PaperOrder = {
      id: uuidv4(),
      symbol,
      side,
      type: "market",
      quantity,
      price: 0,
      status: "rejected",
      createdAt: Date.now(),
    };
    this.orderHistory.push({ ...order });

    this.bus.publish({
      type: "order.rejected",
      data: { orderId: order.id, symbol, side, reason, timestamp: Date.now() },
      source: "paper-broker",
      agentId: "execution",
    });

    return order;
  }

  private updatePositionPrices(symbol: string, price: number): void {
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.currentPrice = price;
      pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity;
    }
  }

  getPortfolio(): PaperPortfolio {
    const positions = [...this.positions.values()];
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
    return [...this.orderHistory];
  }

  getOpenOrders(): PaperOrder[] {
    return this.orders.filter((o) => o.status === "pending");
  }
}
