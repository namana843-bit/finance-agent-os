// ============================================================================
// Finance Agent OS — Production Live Trading Safety: Lifecycle Manager
// Phase 8: Safe startup, graceful shutdown, order draining, and cleanup hooks.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { OrderManager } from "../order-manager/order-manager.js";
import type { PaperBroker } from "../broker/paper-broker.js";
import type { KillSwitch } from "./kill-switch.js";

export type LifecycleState = "INITIALIZED" | "RUNNING" | "DRAINING" | "STOPPED";

export interface LifecycleConfig {
  drainTimeoutMs: number;
  autoCancelOpenOrdersOnShutdown: boolean;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  drainTimeoutMs: 5000,
  autoCancelOpenOrdersOnShutdown: true,
};

export class LifecycleManager {
  private state: LifecycleState = "INITIALIZED";
  private config: LifecycleConfig;
  private bus?: TypedEventBus;
  private orderManager?: OrderManager;
  private broker?: PaperBroker;
  private killSwitch?: KillSwitch;
  private inflightPromises = new Set<Promise<unknown>>();
  private cleanupHandlers: Array<() => Promise<void> | void> = [];

  constructor(deps?: {
    bus?: TypedEventBus;
    orderManager?: OrderManager;
    broker?: PaperBroker;
    killSwitch?: KillSwitch;
    config?: Partial<LifecycleConfig>;
  }) {
    this.bus = deps?.bus;
    this.orderManager = deps?.orderManager;
    this.broker = deps?.broker;
    this.killSwitch = deps?.killSwitch;
    this.config = { ...DEFAULT_LIFECYCLE_CONFIG, ...deps?.config };
  }

  getState(): LifecycleState {
    return this.state;
  }

  isAcceptingOrders(): boolean {
    return this.state === "RUNNING" && (!this.killSwitch || !this.killSwitch.isHalted());
  }

  getInflightCount(): number {
    return this.inflightPromises.size;
  }

  registerCleanupHandler(handler: () => Promise<void> | void): void {
    this.cleanupHandlers.push(handler);
  }

  /**
   * Tracks an in-flight operation so that shutdown can safely drain before exit.
   */
  trackInflight<T>(promise: Promise<T>): Promise<T> {
    this.inflightPromises.add(promise);
    promise.finally(() => {
      this.inflightPromises.delete(promise);
    });
    return promise;
  }

  start(): void {
    this.state = "RUNNING";
    if (this.bus) {
      this.bus.publish({
        type: "system.lifecycle_started",
        source: "lifecycle-manager",
        data: { state: this.state, timestamp: Date.now() },
      });
    }
  }

  /**
   * Initiates graceful shutdown:
   * 1. Stops accepting new orders
   * 2. Cancels pending open orders
   * 3. Drains in-flight operations with timeout
   * 4. Runs registered cleanup hooks
   * 5. Emits shutdown complete
   */
  async gracefulShutdown(reason = "GRACEFUL_SHUTDOWN"): Promise<{
    cancelledOrders: number;
    drainedInflight: number;
    durationMs: number;
  }> {
    const started = Date.now();
    this.state = "DRAINING";

    let cancelledOrders = 0;

    // 1. Cancel open orders
    if (this.config.autoCancelOpenOrdersOnShutdown) {
      if (this.orderManager) {
        try {
          const openOrders = this.orderManager.getOpenOrders();
          for (const o of openOrders) {
            if (this.orderManager.cancelOrder(o.id, reason)) {
              cancelledOrders++;
            }
          }
        } catch (err) {
          console.error("[lifecycle] Error cancelling order-manager orders:", err);
        }
      }

      if (this.broker && typeof (this.broker as unknown as { getOpenOrders?: () => Array<{ id: string }> }).getOpenOrders === "function") {
        try {
          const brokerOrders = (this.broker as unknown as { getOpenOrders: () => Array<{ id: string }> }).getOpenOrders();
          for (const bo of brokerOrders) {
            if (this.broker.cancelOrder(bo.id, reason)) {
              cancelledOrders++;
            }
          }
        } catch (err) {
          console.error("[lifecycle] Error cancelling broker orders:", err);
        }
      }
    }

    // 2. Drain in-flight promises with timeout
    const initialInflight = this.inflightPromises.size;
    if (initialInflight > 0) {
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, this.config.drainTimeoutMs);
      });
      const allInflightPromise = Promise.allSettled([...this.inflightPromises]);
      await Promise.race([allInflightPromise, timeoutPromise]);
    }

    // 3. Execute registered cleanup handlers
    for (const handler of this.cleanupHandlers) {
      try {
        await handler();
      } catch (err) {
        console.error("[lifecycle] Error during cleanup handler:", err);
      }
    }

    this.state = "STOPPED";
    const durationMs = Date.now() - started;

    if (this.bus) {
      this.bus.publish({
        type: "system.shutdown_complete",
        source: "lifecycle-manager",
        data: {
          reason,
          cancelledOrders,
          drainedInflight: initialInflight - this.inflightPromises.size,
          durationMs,
          timestamp: Date.now(),
        },
      });
    }

    return {
      cancelledOrders,
      drainedInflight: initialInflight - this.inflightPromises.size,
      durationMs,
    };
  }
}
