// ============================================================================
// Finance Agent OS — Canonical Order State Machine
// Single source of truth for order lifecycle across OrderManager, TradeEngine,
// ExecutionPipeline, PaperBroker, FinanceGateway.
// ============================================================================

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

// PaperBroker maps to canonical: pending->PENDING, submitted->SUBMITTED, filled->FILLED, cancelled->CANCELLED, rejected->REJECTED
export const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["PENDING", "CANCELLED", "REJECTED", "FAILED"],
  PENDING: ["SUBMITTED", "CANCELLED", "REJECTED", "FAILED"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "FAILED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  FAILED: ["PENDING"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

export interface ManagedOrder {
  id: string; // canonical order id (uuid)
  clientOrderId: string; // external / idempotent key visible to exchange
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
  correlationId: string; // end-to-end trace id: signalId -> gateway -> pipeline -> broker
  idempotencyKey: string; // dedup key: clientOrderId or explicit key
  version: number; // monotonic per-order sequence for event ordering
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
  rejectedAt?: number;
  failedAt?: number;
  rejectedReason?: string;
  failedReason?: string;
  cancelledReason?: string;
}

export interface OrderFill {
  id?: string; // fill id for idempotency (optional)
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  timestamp: number;
  correlationId?: string;
}

export function orderStatusToEvent(status: OrderStatus): string {
  switch (status) {
    case "CREATED": return "order.created";
    case "PENDING": return "order.pending";
    case "SUBMITTED": return "order.submitted";
    case "PARTIALLY_FILLED": return "order.partially_filled";
    case "FILLED": return "order.filled";
    case "CANCELLED": return "order.cancelled";
    case "REJECTED": return "order.rejected";
    case "FAILED": return "order.failed";
    default: {
      const s: string = status as string;
      return `order.${s.toLowerCase()}`;
    }
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return status === "FILLED" || status === "CANCELLED" || status === "REJECTED";
}

export function isOpen(status: OrderStatus): boolean {
  return status === "CREATED" || status === "PENDING" || status === "SUBMITTED" || status === "PARTIALLY_FILLED";
}
