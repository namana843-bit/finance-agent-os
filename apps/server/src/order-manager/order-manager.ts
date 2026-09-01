// ============================================================================
// Finance Agent OS — Order Manager
// Phase 13: Order lifecycle management with state machine
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type OrderStatus =
  | "CREATED"
  | "PENDING"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED";

export interface ManagedOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  stopPrice?: number;
  status: OrderStatus;
  strategy?: string;
  agent?: string;
  executionMode: "paper" | "live";
  filledQuantity: number;
  averageFillPrice: number;
  fees: number;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
}

export interface OrderFill {
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  timestamp: number;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["PENDING", "CANCELLED", "REJECTED", "FAILED"],
  PENDING: ["SUBMITTED", "CANCELLED", "REJECTED", "FAILED"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "FAILED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  FAILED: ["PENDING"], // Allow retry
};

export class OrderManager {
  private orders = new Map<string, ManagedOrder>();
  private ordersByClient = new Map<string, ManagedOrder>();

  constructor(private bus: TypedEventBus) {}

  createOrder(params: {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    quantity: number;
    price: number;
    stopPrice?: number;
    strategy?: string;
    agent?: string;
    executionMode: "paper" | "live";
    clientOrderId?: string;
  }): ManagedOrder {
    const now = Date.now();
    const order: ManagedOrder = {
      id: uuidv4(),
      clientOrderId: params.clientOrderId ?? uuidv4(),
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      price: params.price,
      stopPrice: params.stopPrice,
      status: "CREATED",
      strategy: params.strategy,
      agent: params.agent,
      executionMode: params.executionMode,
      filledQuantity: 0,
      averageFillPrice: 0,
      fees: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(order.id, order);
    this.ordersByClient.set(order.clientOrderId, order);

    this.bus.publish({
      type: "order.created",
      data: { ...order },
      source: "order-manager",
      agentId: params.agent,
    });

    return order;
  }

  updateStatus(orderId: string, newStatus: OrderStatus): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    const valid = VALID_TRANSITIONS[order.status];
    if (!valid.includes(newStatus)) {
      console.warn(`[order-manager] Invalid transition: ${order.status} -> ${newStatus} for order ${orderId}`);
      return false;
    }

    order.status = newStatus;
    order.updatedAt = Date.now();

    if (newStatus === "SUBMITTED") order.submittedAt = Date.now();
    if (newStatus === "FILLED") order.filledAt = Date.now();
    if (newStatus === "CANCELLED") order.cancelledAt = Date.now();

    const eventType = `order.${newStatus.toLowerCase()}` as string;
    this.bus.publish({
      type: eventType,
      data: { ...order },
      source: "order-manager",
      agentId: order.agent,
    });

    return true;
  }

  applyFill(orderId: string, fill: OrderFill): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    order.filledQuantity += fill.quantity;
    order.fees += fill.fee;

    // Recalculate average fill price
    if (order.filledQuantity > 0) {
      const totalCost = order.averageFillPrice * (order.filledQuantity - fill.quantity) + fill.price * fill.quantity;
      order.averageFillPrice = totalCost / order.filledQuantity;
    }

    order.updatedAt = Date.now();

    if (order.filledQuantity >= order.quantity) {
      this.updateStatus(orderId, "FILLED");
    } else {
      this.updateStatus(orderId, "PARTIALLY_FILLED");
    }

    return true;
  }

  getOrder(orderId: string): ManagedOrder | undefined {
    return this.orders.get(orderId);
  }

  getOrderByClientOrderId(clientOrderId: string): ManagedOrder | undefined {
    return this.ordersByClient.get(clientOrderId);
  }

  getAllOrders(): ManagedOrder[] {
    return [...this.orders.values()];
  }

  getOpenOrders(): ManagedOrder[] {
    return [...this.orders.values()].filter(
      (o) => o.status === "CREATED" || o.status === "PENDING" || o.status === "SUBMITTED" || o.status === "PARTIALLY_FILLED"
    );
  }

  getOrdersByStatus(status: OrderStatus): ManagedOrder[] {
    return [...this.orders.values()].filter((o) => o.status === status);
  }

  size(): number {
    return this.orders.size;
  }
}
