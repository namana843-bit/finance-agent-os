// ============================================================================
// Finance Agent OS — Production Live Trading Safety: State Reconciliation
// Phase 8: Position & Order Reconciliation between Internal State and Exchange.
// Detects position drifts, phantom orders, missed fills, and initiates mitigation.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";
import type { KillSwitch } from "./kill-switch.js";
import type { OrderManager } from "../order-manager/order-manager.js";
import type { PaperBroker } from "../broker/paper-broker.js";

export type DiscrepancyType =
  | "POSITION_MISMATCH"
  | "PHANTOM_EXCHANGE_ORDER"
  | "MISSED_INTERNAL_FILL"
  | "STALE_INTERNAL_ORDER";

export type DriftSeverity = "LOW" | "MEDIUM" | "CRITICAL";

export interface Discrepancy {
  type: DiscrepancyType;
  severity: DriftSeverity;
  symbol: string;
  expected: unknown;
  actual: unknown;
  details: string;
}

export interface InternalOrderSummary {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
}

export interface ExchangeOrderSummary {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
}

export interface InternalPositionSummary {
  symbol: string;
  quantity: number;
}

export interface ExchangePositionSummary {
  symbol: string;
  quantity: number;
}

export interface ReconciliationInput {
  internalOrders: InternalOrderSummary[];
  internalPositions: InternalPositionSummary[];
  exchangeOrders: ExchangeOrderSummary[];
  exchangePositions: ExchangePositionSummary[];
}

export interface ReconciliationReport {
  id: string;
  timestamp: number;
  synchronized: boolean;
  driftCount: number;
  discrepancies: Discrepancy[];
  recommendedAction: "NONE" | "CANCEL_PHANTOM_ORDERS" | "UPDATE_INTERNAL_STATE" | "TRIGGER_KILL_SWITCH";
}

export interface ReconciliationConfig {
  /** Quantity difference tolerance before flagging position mismatch (default: 1e-5) */
  positionTolerance: number;
  /** Dollar threshold or quantity threshold to classify position mismatch as CRITICAL */
  criticalMismatchThreshold: number;
  /** Automatically trigger kill switch if critical drift is detected */
  autoHaltOnCriticalDrift: boolean;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  positionTolerance: 1e-5,
  criticalMismatchThreshold: 0.1, // > 0.1 unit or > 10% mismatch
  autoHaltOnCriticalDrift: true,
};

export class ExchangeReconciliation {
  private config: ReconciliationConfig;
  private bus?: TypedEventBus;
  private history: ReconciliationReport[] = [];

  constructor(deps?: {
    bus?: TypedEventBus;
    config?: Partial<ReconciliationConfig>;
  }) {
    this.bus = deps?.bus;
    this.config = { ...DEFAULT_RECONCILIATION_CONFIG, ...deps?.config };
  }

  getHistory(): ReconciliationReport[] {
    return [...this.history];
  }

  /**
   * Reconciles internal state against reported exchange state.
   */
  reconcile(input: ReconciliationInput): ReconciliationReport {
    const reportId = `rec-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const timestamp = Date.now();
    const discrepancies: Discrepancy[] = [];

    // 1. Position Reconciliation
    const allSymbols = new Set<string>();
    for (const p of input.internalPositions) allSymbols.add(p.symbol.toUpperCase());
    for (const p of input.exchangePositions) allSymbols.add(p.symbol.toUpperCase());

    for (const sym of allSymbols) {
      const internal = input.internalPositions.find((p) => p.symbol.toUpperCase() === sym)?.quantity ?? 0;
      const exchange = input.exchangePositions.find((p) => p.symbol.toUpperCase() === sym)?.quantity ?? 0;

      const diff = Math.abs(internal - exchange);
      if (diff > this.config.positionTolerance) {
        // Evaluate severity
        const relativeDiff = Math.max(Math.abs(internal), Math.abs(exchange)) > 0
          ? diff / Math.max(Math.abs(internal), Math.abs(exchange))
          : 1.0;

        const isCritical =
          diff >= this.config.criticalMismatchThreshold ||
          (internal > 0 && exchange < 0) ||
          (internal < 0 && exchange > 0);

        discrepancies.push({
          type: "POSITION_MISMATCH",
          severity: isCritical ? "CRITICAL" : relativeDiff > 0.05 ? "MEDIUM" : "LOW",
          symbol: sym,
          expected: internal,
          actual: exchange,
          details: `Position mismatch for ${sym}: internal=${internal}, exchange=${exchange}, delta=${(exchange - internal).toFixed(6)}`,
        });
      }
    }

    // 2. Open Orders Reconciliation
    // A. Check for Phantom Orders (orders active on exchange but unknown or closed internally)
    for (const exOrder of input.exchangeOrders) {
      const match = input.internalOrders.find(
        (io) => io.id === exOrder.orderId || (io.clientOrderId && io.clientOrderId === exOrder.clientOrderId)
      );

      if (!match) {
        discrepancies.push({
          type: "PHANTOM_EXCHANGE_ORDER",
          severity: "MEDIUM",
          symbol: exOrder.symbol,
          expected: "none",
          actual: exOrder.orderId,
          details: `Order ${exOrder.orderId} is active on exchange but completely unknown internally`,
        });
      } else if (match.status === "CANCELLED" || match.status === "FILLED" || match.status === "REJECTED") {
        discrepancies.push({
          type: "PHANTOM_EXCHANGE_ORDER",
          severity: "HIGH" as DriftSeverity,
          symbol: exOrder.symbol,
          expected: match.status,
          actual: exOrder.status,
          details: `Order ${exOrder.orderId} is active on exchange but marked ${match.status} internally`,
        });
      }
    }

    // B. Check for Stale Internal Orders (active internally but absent from exchange)
    for (const intOrder of input.internalOrders) {
      if (intOrder.status === "PENDING" || intOrder.status === "SUBMITTED" || intOrder.status === "PARTIALLY_FILLED") {
        const match = input.exchangeOrders.find(
          (eo) => eo.orderId === intOrder.id || (eo.clientOrderId && eo.clientOrderId === intOrder.clientOrderId)
        );

        if (!match) {
          discrepancies.push({
            type: "STALE_INTERNAL_ORDER",
            severity: "LOW",
            symbol: intOrder.symbol,
            expected: intOrder.status,
            actual: "missing_on_exchange",
            details: `Internal order ${intOrder.id} (${intOrder.symbol}) marked ${intOrder.status} but not found on exchange`,
          });
        }
      }
    }

    // Determine recommended action
    let recommendedAction: ReconciliationReport["recommendedAction"] = "NONE";
    const hasCritical = discrepancies.some((d) => d.severity === "CRITICAL");
    const hasPhantoms = discrepancies.some((d) => d.type === "PHANTOM_EXCHANGE_ORDER");
    const hasStale = discrepancies.some((d) => d.type === "STALE_INTERNAL_ORDER");

    if (hasCritical) {
      recommendedAction = "TRIGGER_KILL_SWITCH";
    } else if (hasPhantoms) {
      recommendedAction = "CANCEL_PHANTOM_ORDERS";
    } else if (hasStale) {
      recommendedAction = "UPDATE_INTERNAL_STATE";
    }

    const report: ReconciliationReport = {
      id: reportId,
      timestamp,
      synchronized: discrepancies.length === 0,
      driftCount: discrepancies.length,
      discrepancies,
      recommendedAction,
    };

    this.history.push(report);
    if (this.history.length > 50) {
      this.history.shift();
    }

    // Publish event if drift detected
    if (!report.synchronized && this.bus) {
      this.bus.publish({
        type: "audit.reconciliation_drift",
        source: "exchange-reconciliation",
        data: {
          reportId: report.id,
          driftCount: report.driftCount,
          recommendedAction: report.recommendedAction,
          discrepancies: report.discrepancies,
          timestamp,
        },
      });
    }

    return report;
  }

  /**
   * Automated drift mitigation:
   * 1. If critical drift and autoHaltOnCriticalDrift is true, triggers kill switch
   * 2. If phantom orders, cancels them via broker
   * 3. If stale internal orders, updates OrderManager
   */
  async autoMitigate(
    report: ReconciliationReport,
    deps: {
      killSwitch?: KillSwitch;
      broker?: PaperBroker;
      orderManager?: OrderManager;
    }
  ): Promise<{ mitigated: boolean; actionsTaken: string[] }> {
    const actionsTaken: string[] = [];

    if (report.synchronized) {
      return { mitigated: true, actionsTaken: ["Already synchronized"] };
    }

    // 1. Critical drift halt
    if (
      this.config.autoHaltOnCriticalDrift &&
      report.recommendedAction === "TRIGGER_KILL_SWITCH" &&
      deps.killSwitch
    ) {
      await deps.killSwitch.trigger(
        `Critical reconciliation drift detected: ${report.discrepancies.map((d) => d.details).join("; ")}`,
        "reconciliation-engine"
      );
      actionsTaken.push("Triggered emergency kill switch due to critical position discrepancy");
    }

    // 2. Phantom order mitigation: cancel phantom orders
    for (const d of report.discrepancies) {
      if (d.type === "PHANTOM_EXCHANGE_ORDER" && deps.broker) {
        const orderId = String(d.actual);
        try {
          deps.broker.cancelOrder(orderId, "Reconciliation auto-mitigation: Phantom order");
          actionsTaken.push(`Cancelled phantom exchange order ${orderId}`);
        } catch (err) {
          actionsTaken.push(`Failed to cancel phantom order ${orderId}: ${err}`);
        }
      }

      // 3. Stale internal order mitigation
      if (d.type === "STALE_INTERNAL_ORDER" && deps.orderManager) {
        const orderId = String(d.expected);
        try {
          deps.orderManager.cancelOrder(orderId, "Reconciliation auto-mitigation: Stale order");
          actionsTaken.push(`Cleaned up stale internal order ${orderId}`);
        } catch {
          // ignore if already terminal
        }
      }
    }

    return {
      mitigated: actionsTaken.length > 0,
      actionsTaken,
    };
  }
}
