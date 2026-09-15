// ============================================================================
// Finance Agent OS — Production Live Trading Safety: Emergency Kill Switch
// Phase 8: Hard circuit breaker, emergency halt, in-flight order cancellation,
// state persistence, and credential-authenticated re-arming.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { OrderManager } from "../order-manager/order-manager.js";
import type { PaperBroker } from "../broker/paper-broker.js";

export type KillSwitchState = "ARMED" | "TRIGGERED" | "DISARMED";

export interface KillSwitchConfig {
  /** Master override secret required to reset/disarm the kill switch */
  overrideKey?: string;
  /** Optional custom actor name for automated safety routines */
  defaultActor?: string;
}

export interface TriggerResult {
  state: KillSwitchState;
  reason: string;
  actor: string;
  triggeredAt: number;
  cancelledOrdersCount: number;
  cancelledOrderIds: string[];
}

export interface ResetCredentials {
  overrideKey: string;
  reason: string;
  actor?: string;
}

export interface ResetResult {
  success: boolean;
  state: KillSwitchState;
  message: string;
  resetAt: number;
}

export class KillSwitchTriggeredError extends Error {
  readonly state: KillSwitchState;
  readonly reason: string;
  readonly triggeredAt: number;

  constructor(reason: string, triggeredAt: number) {
    super(`Trading blocked: Emergency Kill Switch is TRIGGERED. Reason: "${reason}" (at ${new Date(triggeredAt).toISOString()})`);
    this.name = "KillSwitchTriggeredError";
    this.state = "TRIGGERED";
    this.reason = reason;
    this.triggeredAt = triggeredAt;
  }
}

export class KillSwitch {
  private state: KillSwitchState = "ARMED";
  private triggeredAt: number | null = null;
  private triggeredReason: string | null = null;
  private triggeredBy: string | null = null;
  private overrideKey: string;
  private bus?: TypedEventBus;
  private orderManager?: OrderManager;
  private broker?: PaperBroker;

  constructor(deps?: {
    bus?: TypedEventBus;
    orderManager?: OrderManager;
    broker?: PaperBroker;
    config?: KillSwitchConfig;
  }) {
    this.bus = deps?.bus;
    this.orderManager = deps?.orderManager;
    this.broker = deps?.broker;
    this.overrideKey =
      deps?.config?.overrideKey ??
      process.env.KILL_SWITCH_OVERRIDE_KEY ??
      "EMERGENCY_OVERRIDE_SECRET_DEFAULT";
  }

  setBus(bus: TypedEventBus): void {
    this.bus = bus;
  }

  setOrderManager(om: OrderManager): void {
    this.orderManager = om;
  }

  setBroker(broker: PaperBroker): void {
    this.broker = broker;
  }

  getState(): KillSwitchState {
    return this.state;
  }

  isHalted(): boolean {
    return this.state === "TRIGGERED";
  }

  getTriggerDetails(): {
    triggeredAt: number | null;
    triggeredReason: string | null;
    triggeredBy: string | null;
  } {
    return {
      triggeredAt: this.triggeredAt,
      triggeredReason: this.triggeredReason,
      triggeredBy: this.triggeredBy,
    };
  }

  /**
   * Asserts that trading is not halted. Throws KillSwitchTriggeredError if triggered.
   */
  assertNotHalted(): void {
    if (this.state === "TRIGGERED") {
      throw new KillSwitchTriggeredError(
        this.triggeredReason ?? "Emergency halt activated",
        this.triggeredAt ?? Date.now()
      );
    }
  }

  /**
   * Activates the emergency kill switch:
   * 1. Transitions state to TRIGGERED
   * 2. Cancels all pending/open orders in OrderManager and Broker
   * 3. Emits audit.kill_switch_activated event
   */
  async trigger(reason: string, actor = "system"): Promise<TriggerResult> {
    this.state = "TRIGGERED";
    this.triggeredAt = Date.now();
    this.triggeredReason = reason;
    this.triggeredBy = actor;

    const cancelledOrderIds: string[] = [];

    // 1. Cancel all open orders in OrderManager
    if (this.orderManager) {
      try {
        const openOrders = this.orderManager.getOpenOrders();
        for (const order of openOrders) {
          const success = this.orderManager.cancelOrder(order.id, `KILL_SWITCH: ${reason}`);
          if (success) {
            cancelledOrderIds.push(order.id);
          }
        }
      } catch (err) {
        console.error("[kill-switch] Error cancelling OrderManager orders:", err);
      }
    }

    // 2. Also cancel any open orders in PaperBroker if applicable
    if (this.broker && typeof (this.broker as unknown as { getOpenOrders?: () => Array<{ id: string }> }).getOpenOrders === "function") {
      try {
        const openBrokerOrders = (this.broker as unknown as { getOpenOrders: () => Array<{ id: string }> }).getOpenOrders();
        for (const bo of openBrokerOrders) {
          if (!cancelledOrderIds.includes(bo.id)) {
            const cancelled = this.broker.cancelOrder(bo.id, `KILL_SWITCH: ${reason}`);
            if (cancelled) {
              cancelledOrderIds.push(bo.id);
            }
          }
        }
      } catch (err) {
        console.error("[kill-switch] Error cancelling Broker orders:", err);
      }
    }

    // 3. Emit audit event
    if (this.bus) {
      this.bus.publish({
        type: "audit.kill_switch_activated",
        source: "kill-switch",
        data: {
          state: this.state,
          reason,
          actor,
          triggeredAt: this.triggeredAt,
          cancelledOrdersCount: cancelledOrderIds.length,
          cancelledOrderIds,
        },
      });
    }

    console.warn(
      `[kill-switch] EMERGENCY HALT ACTIVATED by ${actor}: "${reason}". Cancelled ${cancelledOrderIds.length} open orders.`
    );

    return {
      state: this.state,
      reason,
      actor,
      triggeredAt: this.triggeredAt,
      cancelledOrdersCount: cancelledOrderIds.length,
      cancelledOrderIds,
    };
  }

  /**
   * Re-arms the kill switch. Requires valid override key credentials.
   */
  reset(credentials: ResetCredentials): ResetResult {
    if (!credentials.overrideKey || credentials.overrideKey !== this.overrideKey) {
      throw new Error("Unauthorized: Invalid override key for KillSwitch reset");
    }

    if (!credentials.reason || credentials.reason.trim().length === 0) {
      throw new Error("Invalid reset: A clear justification reason is required to re-arm KillSwitch");
    }

    const previousState = this.state;
    this.state = "ARMED";
    const resetAt = Date.now();
    const actor = credentials.actor ?? "operator";

    this.triggeredAt = null;
    this.triggeredReason = null;
    this.triggeredBy = null;

    if (this.bus) {
      this.bus.publish({
        type: "audit.kill_switch_reset",
        source: "kill-switch",
        data: {
          previousState,
          newState: this.state,
          reason: credentials.reason,
          actor,
          resetAt,
        },
      });
    }

    console.log(
      `[kill-switch] RESET to ARMED by ${actor}. Justification: "${credentials.reason}"`
    );

    return {
      success: true,
      state: this.state,
      message: "KillSwitch successfully reset and re-armed for trading",
      resetAt,
    };
  }

  /**
   * Disarms the kill switch (e.g. for maintenance or testing). Requires override credentials.
   */
  disarm(credentials: { overrideKey: string; reason: string; actor?: string }): void {
    if (!credentials.overrideKey || credentials.overrideKey !== this.overrideKey) {
      throw new Error("Unauthorized: Invalid override key to disarm KillSwitch");
    }

    this.state = "DISARMED";
    if (this.bus) {
      this.bus.publish({
        type: "audit.kill_switch_disarmed",
        source: "kill-switch",
        data: {
          state: this.state,
          reason: credentials.reason,
          actor: credentials.actor ?? "operator",
          timestamp: Date.now(),
        },
      });
    }
  }
}
