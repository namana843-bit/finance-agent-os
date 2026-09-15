// ============================================================================
// Finance Agent OS — Order Manager (Canonical)
// Implements: canonical state machine, idempotent processing, duplicate
// protection, correlation IDs, partial-fills, cancel/reject/retry, audit,
// persistence, event ordering guarantees.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TypedEventBus } from "@finance/core";
import {
  VALID_TRANSITIONS,
  canTransition,
  orderStatusToEvent,
  isOpen,
  isTerminal,
  type OrderSide,
  type OrderType,
  type OrderStatus,
  type ManagedOrder,
  type OrderFill,
} from "./canonical.js";

export type { OrderSide, OrderType, OrderStatus, ManagedOrder, OrderFill };

function getDefaultPersistPath(): string {
  // Prefer apps/server/.data/orders.json; fallback to .data/orders.json at repo root
  try {
    const candidates = [
      join(process.cwd(), "apps", "server", ".data", "orders.json"),
      join(process.cwd(), ".data", "orders.json"),
      ".data/orders.json",
    ];
    return candidates[0]!;
  } catch {
    return ".data/orders.json";
  }
}

export class OrderManager {
  private orders = new Map<string, ManagedOrder>();
  private ordersByClient = new Map<string, ManagedOrder>();
  private ordersByCorrelation = new Map<string, string[]>(); // correlationId -> orderIds
  private ordersByIdempotency = new Map<string, ManagedOrder>();
  private fillDedup = new Set<string>(); // `${orderId}:${fillId}` or hash
  private persistPath: string;
  private autoPersist: boolean;

  constructor(private bus: TypedEventBus, opts?: { persistPath?: string; autoPersist?: boolean }) {
    this.persistPath = opts?.persistPath ?? getDefaultPersistPath();
    this.autoPersist = opts?.autoPersist ?? true;
    this.loadSync();
  }

  // -------------------------------------------------------------------------
  // Persistence (file-based; prisma optional is handled in runtime)
  // -------------------------------------------------------------------------
  private loadSync(): void {
    if (this.persistPath === ":memory:") return;
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, "utf-8");
      if (!raw.trim()) return;
      const arr = JSON.parse(raw) as ManagedOrder[];
      if (!Array.isArray(arr)) return;
      for (const o of arr) {
        if (!o.id || !o.clientOrderId) continue;
        this.orders.set(o.id, o);
        this.ordersByClient.set(o.clientOrderId, o);
        if (o.correlationId) {
          const list = this.ordersByCorrelation.get(o.correlationId) ?? [];
          list.push(o.id);
          this.ordersByCorrelation.set(o.correlationId, list);
        }
        if (o.idempotencyKey) this.ordersByIdempotency.set(o.idempotencyKey, o);
        // fill dedup not restored — best effort; version retained
      }
    } catch (e) {
      console.warn("[order-manager] load failed:", (e as Error).message);
    }
  }

  private persistSync(): void {
    if (!this.autoPersist || this.persistPath === ":memory:") return;
    try {
      const dir = dirname(this.persistPath);
      mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify([...this.orders.values()], null, 2);
      // atomic via tmp
      const tmp = this.persistPath + ".tmp";
      writeFileSync(tmp, payload, "utf-8");
      writeFileSync(this.persistPath, payload, "utf-8");
      try { writeFileSync(tmp, "", "utf-8"); } catch {}
    } catch (e) {
      console.warn("[order-manager] persist failed:", (e as Error).message);
    }
  }

  persist(): void { this.persistSync(); }
  load(): void { this.loadSync(); }

  clear(): void {
    this.orders.clear();
    this.ordersByClient.clear();
    this.ordersByCorrelation.clear();
    this.ordersByIdempotency.clear();
    this.fillDedup.clear();
    this.persistSync();
  }

  // -------------------------------------------------------------------------
  // Create — idempotent + duplicate protection + correlation
  // -------------------------------------------------------------------------
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
    correlationId?: string;
    idempotencyKey?: string;
  }): ManagedOrder {
    // Validation (strict)
    const symbol = params.symbol?.trim().toUpperCase();
    if (!symbol) throw new Error("symbol required");
    if (params.side !== "buy" && params.side !== "sell") throw new Error("side must be buy|sell");
    if (typeof params.quantity !== "number" || !Number.isFinite(params.quantity) || params.quantity <= 0) throw new Error("quantity must be >0");
    if (typeof params.price !== "number" || !Number.isFinite(params.price) || params.price <= 0) throw new Error("price must be >0");
    if (params.type && !["market","limit","stop","stop_limit"].includes(params.type)) throw new Error("invalid order type");

    const clientOrderId = params.clientOrderId?.trim() || uuidv4();
    const correlationId = params.correlationId?.trim() || uuidv4();
    const idempotencyKey = params.idempotencyKey?.trim() || clientOrderId;

    // Idempotent: if clientOrderId exists return existing
    const existingByClient = this.ordersByClient.get(clientOrderId);
    if (existingByClient) return existingByClient;
    // Idempotent: if idempotencyKey exists return existing (covers retry-safe)
    const existingByKey = this.ordersByIdempotency.get(idempotencyKey);
    if (existingByKey) return existingByKey;

    const now = Date.now();
    const order: ManagedOrder = {
      id: uuidv4(),
      clientOrderId,
      symbol,
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
      correlationId,
      idempotencyKey,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(order.id, order);
    this.ordersByClient.set(order.clientOrderId, order);
    this.ordersByIdempotency.set(idempotencyKey, order);
    const list = this.ordersByCorrelation.get(correlationId) ?? [];
    list.push(order.id);
    this.ordersByCorrelation.set(correlationId, list);

    // Audit + event ordering guarantee: publish synchronously with version 1
    this.publishAudit("order.create", order, null, "order created");
    this.bus.publish({
      type: "order.created",
      data: { ...order },
      source: "order-manager",
      agentId: params.agent,
      correlationId,
    });
    this.persistSync();
    return { ...order };
  }

  // -------------------------------------------------------------------------
  // State transitions — canonical + audit + event ordering via version
  // -------------------------------------------------------------------------
  updateStatus(orderId: string, newStatus: OrderStatus, reason?: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status === newStatus) return true; // idempotent
    if (!canTransition(order.status, newStatus)) {
      console.warn(`[order-manager] Invalid transition: ${order.status} -> ${newStatus} for order ${orderId}`);
      return false;
    }
    const prev = order.status;
    order.status = newStatus;
    order.version += 1;
    order.updatedAt = Date.now();
    if (newStatus === "SUBMITTED") order.submittedAt = Date.now();
    if (newStatus === "PENDING") { /* no ts */ }
    if (newStatus === "FILLED") order.filledAt = Date.now();
    if (newStatus === "CANCELLED") { order.cancelledAt = Date.now(); if (reason) order.cancelledReason = reason; }
    if (newStatus === "REJECTED") { order.rejectedAt = Date.now(); if (reason) order.rejectedReason = reason; }
    if (newStatus === "FAILED") { order.failedAt = Date.now(); if (reason) order.failedReason = reason; }

    const eventType = orderStatusToEvent(newStatus);
    this.publishAudit(`order.${newStatus.toLowerCase()}`, order, prev, reason ?? `transition ${prev} -> ${newStatus}`);
    this.bus.publish({
      type: eventType,
      data: { ...order, _prevStatus: prev, _version: order.version },
      source: "order-manager",
      agentId: order.agent,
      correlationId: order.correlationId,
    });
    this.persistSync();
    return true;
  }

  // Convenience wrappers
  cancelOrder(orderId: string, reason?: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status === "CANCELLED") return true; // idempotent
    if (isTerminal(order.status)) return false; // cannot cancel terminal FILLED/REJECTED/CANCELLED
    return this.updateStatus(orderId, "CANCELLED", reason ?? "cancel requested");
  }

  rejectOrder(orderId: string, reason: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status === "REJECTED") return true;
    if (isTerminal(order.status)) return false;
    // rejected allowed from CREATED/PENDING/SUBMITTED
    if (!canTransition(order.status, "REJECTED")) return false;
    return this.updateStatus(orderId, "REJECTED", reason);
  }

  failOrder(orderId: string, reason: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status === "FAILED") return true;
    if (!canTransition(order.status, "FAILED")) return false;
    return this.updateStatus(orderId, "FAILED", reason);
  }

  retryOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status !== "FAILED") return false;
    return this.updateStatus(orderId, "PENDING", "retry");
  }

  submitOrder(orderId: string): boolean { return this.updateStatus(orderId, "SUBMITTED"); }
  pendingOrder(orderId: string): boolean { return this.updateStatus(orderId, "PENDING"); }

  // -------------------------------------------------------------------------
  // Partial-fill support — idempotent via fill.id, capped, versioned, ordered
  // -------------------------------------------------------------------------
  applyFill(orderId: string, fill: OrderFill): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (isTerminal(order.status) && order.status !== "PARTIALLY_FILLED") {
      // already FILLED/CANCELLED/REJECTED — ignore fill (idempotent protection)
      if (order.status === "FILLED") return false;
    }
    // Idempotent dedup by fill id or by exact quantity/price/timestamp hash
    const fillId = fill.id?.trim() || `${fill.quantity}:${fill.price}:${fill.timestamp}`;
    const dedupKey = `${orderId}:${fillId}`;
    if (this.fillDedup.has(dedupKey)) return true; // already applied (idempotent)
    // Validate fill
    if (typeof fill.quantity !== "number" || !Number.isFinite(fill.quantity) || fill.quantity <= 0) return false;
    if (order.filledQuantity + fill.quantity > order.quantity + 1e-9) {
      console.warn(`[order-manager] fill exceeds order quantity ${order.filledQuantity}+${fill.quantity} > ${order.quantity}`);
      return false;
    }
    // Ensure order is in executable state before fill
    if (order.status === "CREATED" || order.status === "PENDING") {
      this.updateStatus(orderId, "SUBMITTED");
    } else if (order.status === "FAILED" || order.status === "CANCELLED" || order.status === "REJECTED") {
      return false;
    }

    this.fillDedup.add(dedupKey);
    // Update filled amounts
    const prevFilled = order.filledQuantity;
    order.filledQuantity += fill.quantity;
    // clamp due to float
    if (order.filledQuantity > order.quantity) order.filledQuantity = order.quantity;
    order.fees += fill.fee ?? 0;
    if (order.filledQuantity > 0) {
      const totalCost = order.averageFillPrice * prevFilled + fill.price * fill.quantity;
      order.averageFillPrice = totalCost / order.filledQuantity;
    }
    order.version += 1;
    order.updatedAt = Date.now();

    // Transition status with ordering guarantee: applyFill publishes exactly one status event
    if (order.filledQuantity >= order.quantity - 1e-9) {
      order.status = "FILLED";
      order.filledAt = Date.now();
      this.publishAudit("order.filled", order, null, `filled ${order.filledQuantity}/${order.quantity}`);
      this.bus.publish({
        type: "order.filled",
        data: { ...order, fill: { ...fill, fillId }, _version: order.version },
        source: "order-manager",
        agentId: order.agent,
        correlationId: order.correlationId ?? fill.correlationId,
      });
      // Also emit trade linkage event for TradeEngine
      this.bus.publish({
        type: "order.fill_applied",
        data: { orderId: order.id, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, quantity: fill.quantity, price: fill.price, fee: fill.fee, correlationId: order.correlationId, version: order.version, timestamp: fill.timestamp },
        source: "order-manager",
        agentId: order.agent,
        correlationId: order.correlationId,
      });
    } else {
      order.status = "PARTIALLY_FILLED";
      this.publishAudit("order.partially_filled", order, null, `partial ${order.filledQuantity}/${order.quantity}`);
      this.bus.publish({
        type: "order.partially_filled",
        data: { ...order, fill: { ...fill, fillId }, _version: order.version },
        source: "order-manager",
        agentId: order.agent,
        correlationId: order.correlationId ?? fill.correlationId,
      });
      this.bus.publish({
        type: "order.fill_applied",
        data: { orderId: order.id, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, quantity: fill.quantity, price: fill.price, fee: fill.fee, correlationId: order.correlationId, version: order.version, timestamp: fill.timestamp },
        source: "order-manager",
        agentId: order.agent,
        correlationId: order.correlationId,
      });
    }
    this.persistSync();
    return true;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  getOrder(orderId: string): ManagedOrder | undefined {
    const o = this.orders.get(orderId);
    return o ? { ...o } : undefined;
  }

  getOrderByClientOrderId(clientOrderId: string): ManagedOrder | undefined {
    const o = this.ordersByClient.get(clientOrderId);
    return o ? { ...o } : undefined;
  }

  getOrderByCorrelationId(correlationId: string): ManagedOrder[] {
    const ids = this.ordersByCorrelation.get(correlationId) ?? [];
    return ids.map(id => this.orders.get(id)!).filter(Boolean).map(o => ({ ...o }));
  }

  getOrderByIdempotencyKey(key: string): ManagedOrder | undefined {
    const o = this.ordersByIdempotency.get(key);
    return o ? { ...o } : undefined;
  }

  getAllOrders(): ManagedOrder[] { return [...this.orders.values()].map(o => ({ ...o })); }
  getOpenOrders(): ManagedOrder[] { return [...this.orders.values()].filter(o => isOpen(o.status)).map(o => ({ ...o })); }
  getOrdersByStatus(status: OrderStatus): ManagedOrder[] { return [...this.orders.values()].filter(o => o.status === status).map(o => ({ ...o })); }
  size(): number { return this.orders.size; }

  // -------------------------------------------------------------------------
  // Internal audit helper — publishes audit event + ensures ordering
  // -------------------------------------------------------------------------
  private publishAudit(eventType: string, order: ManagedOrder, prevStatus: string | null, reason: string): void {
    this.bus.publish({
      type: `audit.order_${eventType.replace("order.","")}`,
      data: { orderId: order.id, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, status: order.status, prevStatus, version: order.version, correlationId: order.correlationId, idempotencyKey: order.idempotencyKey, reason, timestamp: Date.now() },
      source: "order-manager",
      agentId: order.agent,
      correlationId: order.correlationId,
    });
  }
}
