// ============================================================================
// Finance Agent OS — Phase 8 Production Live Trading Safety Tests
// Validates:
// 1. Hard non-bypassable limits (single order notional, symbol exposure, total exposure, daily loss, open orders, shorting)
// 2. Emergency Kill Switch (halt, cancellation of open orders, audit events, authenticated reset)
// 3. Exchange State Reconciliation (drift detection: position mismatch, phantom orders, stale orders, auto-mitigation)
// 4. Lifecycle & Graceful Shutdown (draining, cancelling orders, state transitions)
// 5. Execution Pipeline Safety Gate Integration
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import {
  HardLimitsValidator,
  DEFAULT_HARD_LIMITS,
  HardLimitViolationError,
} from "../src/safety/hard-limits.js";
import {
  KillSwitch,
  KillSwitchTriggeredError,
} from "../src/safety/kill-switch.js";
import {
  ExchangeReconciliation,
  type ReconciliationInput,
} from "../src/safety/exchange-reconciliation.js";
import {
  LifecycleManager,
} from "../src/safety/lifecycle-manager.js";
import { OrderManager } from "../src/order-manager/order-manager.js";
import { PaperBroker } from "../src/broker/paper-broker.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import type { RiskAgent } from "../src/agents/risk/index.js";

describe("Phase 8: Production Live Trading Safety", () => {
  let bus: TypedEventBus;
  let orderManager: OrderManager;
  let paperBroker: PaperBroker;

  beforeEach(() => {
    bus = new TypedEventBus({ maxHistory: 500 });
    orderManager = new OrderManager(bus, { persistPath: ":memory:", autoPersist: false });
    paperBroker = new PaperBroker(bus, {
      initialCash: 100_000,
      latencyMs: 0,
      slippage: 0,
      fee: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Hard Non-Bypassable Limits
  // ---------------------------------------------------------------------------

  describe("Hard Limits Validator", () => {
    const validator = new HardLimitsValidator({
      maxSingleOrderNotional: 10_000,
      maxPositionNotionalPerSymbol: 20_000,
      maxTotalPortfolioExposure: 50_000,
      maxDailyLoss: 1_000,
      maxOpenOrders: 5,
      maxDailyOrders: 50,
      allowShorting: false,
      maxLeverage: 1.0,
    });

    it("allows valid orders within all bounds", () => {
      const res = validator.evaluate({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        price: 50_000, // notional = 5,000 <= 10,000
        currentPositions: [],
        currentOpenOrdersCount: 1,
        currentDailyLoss: 100,
        currentDailyOrdersCount: 5,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it("blocks order exceeding maxSingleOrderNotional", () => {
      const res = validator.evaluate({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.5,
        price: 50_000, // notional = 25,000 > 10,000 limit
        currentPositions: [],
        currentOpenOrdersCount: 0,
        currentDailyLoss: 0,
        currentDailyOrdersCount: 0,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(false);
      expect(res.violations.some((v) => v.code === "EXCEEDS_SINGLE_ORDER_NOTIONAL")).toBe(true);
    });

    it("blocks order exceeding maxPositionNotionalPerSymbol", () => {
      const res = validator.evaluate({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.15,
        price: 50_000, // order notional = 7,500 <= 10,000
        currentPositions: [
          { symbol: "BTCUSDT", quantity: 0.3, currentPrice: 50_000 }, // existing 15,000 + 7,500 = 22,500 > 20,000
        ],
        currentOpenOrdersCount: 0,
        currentDailyLoss: 0,
        currentDailyOrdersCount: 0,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(false);
      expect(res.violations.some((v) => v.code === "EXCEEDS_SYMBOL_POSITION_LIMIT")).toBe(true);
    });

    it("blocks order when daily loss limit is breached", () => {
      const res = validator.evaluate({
        symbol: "ETHUSDT",
        side: "buy",
        quantity: 1,
        price: 2_000,
        currentPositions: [],
        currentOpenOrdersCount: 0,
        currentDailyLoss: 1_200, // > 1,000 limit
        currentDailyOrdersCount: 1,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(false);
      expect(res.violations.some((v) => v.code === "EXCEEDS_DAILY_LOSS_LIMIT")).toBe(true);
    });

    it("blocks order when max open orders count is reached", () => {
      const res = validator.evaluate({
        symbol: "SOLUSDT",
        side: "buy",
        quantity: 5,
        price: 100,
        currentPositions: [],
        currentOpenOrdersCount: 5, // reached maxOpenOrders
        currentDailyLoss: 0,
        currentDailyOrdersCount: 2,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(false);
      expect(res.violations.some((v) => v.code === "EXCEEDS_MAX_OPEN_ORDERS")).toBe(true);
    });

    it("blocks sell order that results in an unhedged short position", () => {
      const res = validator.evaluate({
        symbol: "BTCUSDT",
        side: "sell",
        quantity: 1.0,
        price: 50_000,
        currentPositions: [], // 0 position, selling 1.0 = -1.0 short
        currentOpenOrdersCount: 0,
        currentDailyLoss: 0,
        currentDailyOrdersCount: 0,
        accountEquity: 100_000,
      });

      expect(res.allowed).toBe(false);
      expect(res.violations.some((v) => v.code === "UNAUTHORIZED_SHORTING")).toBe(true);
    });

    it("throws HardLimitViolationError when assertAllowed=true", () => {
      expect(() => {
        validator.evaluate(
          {
            symbol: "BTCUSDT",
            side: "buy",
            quantity: 1.0,
            price: 50_000,
            currentPositions: [],
            currentOpenOrdersCount: 0,
            currentDailyLoss: 0,
            currentDailyOrdersCount: 0,
            accountEquity: 100_000,
          },
          true
        );
      }).toThrow(HardLimitViolationError);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Emergency Kill Switch
  // ---------------------------------------------------------------------------

  describe("Emergency Kill Switch", () => {
    const OVERRIDE_KEY = "SECRET_SUPERADMIN_KEY_12345";
    let killSwitch: KillSwitch;

    beforeEach(() => {
      killSwitch = new KillSwitch({
        bus,
        orderManager,
        broker: paperBroker,
        config: { overrideKey: OVERRIDE_KEY },
      });
    });

    it("initial state is ARMED and isHalted returns false", () => {
      expect(killSwitch.getState()).toBe("ARMED");
      expect(killSwitch.isHalted()).toBe(false);
      expect(() => killSwitch.assertNotHalted()).not.toThrow();
    });

    it("trigger halts trading, cancels active open orders, and publishes audit event", async () => {
      // Create some active orders in OrderManager
      const o1 = orderManager.createOrder({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        type: "limit",
        price: 50_000,
      });
      const o2 = orderManager.createOrder({
        symbol: "ETHUSDT",
        side: "buy",
        quantity: 1.0,
        type: "limit",
        price: 3_000,
      });
      orderManager.updateStatus(o1.id, "PENDING");
      orderManager.updateStatus(o1.id, "SUBMITTED");
      orderManager.updateStatus(o2.id, "PENDING");
      orderManager.updateStatus(o2.id, "SUBMITTED");

      expect(orderManager.getOpenOrders()).toHaveLength(2);

      const events: unknown[] = [];
      bus.subscribeTo("audit.kill_switch_activated", (event) => events.push(event));

      const result = await killSwitch.trigger("Critical volatility circuit breaker tripped", "risk-monitor");

      expect(killSwitch.getState()).toBe("TRIGGERED");
      expect(killSwitch.isHalted()).toBe(true);
      expect(result.cancelledOrdersCount).toBe(2);
      expect(events).toHaveLength(1);

      // Verify all orders are now CANCELLED in OrderManager
      const remainingOpen = orderManager.getOpenOrders();
      expect(remainingOpen).toHaveLength(0);

      const updatedO1 = orderManager.getOrder(o1.id);
      expect(updatedO1?.status).toBe("CANCELLED");
      expect(updatedO1?.cancelledReason).toContain("KILL_SWITCH");

      // Assert throws error
      expect(() => killSwitch.assertNotHalted()).toThrow(KillSwitchTriggeredError);
    });

    it("reset fails without valid override key credentials", async () => {
      await killSwitch.trigger("Test halt");

      expect(() => {
        killSwitch.reset({
          overrideKey: "WRONG_KEY",
          reason: "Manual inspection clear",
        });
      }).toThrow(/Unauthorized/);

      expect(killSwitch.isHalted()).toBe(true);
    });

    it("reset succeeds with valid override key and re-arms trading", async () => {
      await killSwitch.trigger("Test halt");
      expect(killSwitch.isHalted()).toBe(true);

      const resetRes = killSwitch.reset({
        overrideKey: OVERRIDE_KEY,
        reason: "All systems inspected, spreads normalized, safe to resume",
        actor: "chief-risk-officer",
      });

      expect(resetRes.success).toBe(true);
      expect(killSwitch.getState()).toBe("ARMED");
      expect(killSwitch.isHalted()).toBe(false);
      expect(() => killSwitch.assertNotHalted()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Exchange State Reconciliation
  // ---------------------------------------------------------------------------

  describe("Exchange State Reconciliation", () => {
    let reconciliation: ExchangeReconciliation;
    let killSwitch: KillSwitch;

    beforeEach(() => {
      reconciliation = new ExchangeReconciliation({ bus });
      killSwitch = new KillSwitch({ bus, orderManager, broker: paperBroker });
    });

    it("detects clean synchronized state with zero drift", () => {
      const input: ReconciliationInput = {
        internalPositions: [{ symbol: "BTCUSDT", quantity: 0.5 }],
        exchangePositions: [{ symbol: "BTCUSDT", quantity: 0.5 }],
        internalOrders: [{ id: "ord-1", symbol: "BTCUSDT", side: "buy", quantity: 0.1, status: "SUBMITTED" }],
        exchangeOrders: [{ orderId: "ord-1", symbol: "BTCUSDT", side: "buy", quantity: 0.1, status: "NEW" }],
      };

      const report = reconciliation.reconcile(input);
      expect(report.synchronized).toBe(true);
      expect(report.driftCount).toBe(0);
      expect(report.recommendedAction).toBe("NONE");
    });

    it("detects position mismatch drift and classifies severity", () => {
      const input: ReconciliationInput = {
        internalPositions: [{ symbol: "BTCUSDT", quantity: 1.0 }],
        exchangePositions: [{ symbol: "BTCUSDT", quantity: 0.5 }], // delta 0.5 > critical threshold
        internalOrders: [],
        exchangeOrders: [],
      };

      const report = reconciliation.reconcile(input);
      expect(report.synchronized).toBe(false);
      expect(report.driftCount).toBe(1);
      expect(report.discrepancies[0]?.type).toBe("POSITION_MISMATCH");
      expect(report.discrepancies[0]?.severity).toBe("CRITICAL");
      expect(report.recommendedAction).toBe("TRIGGER_KILL_SWITCH");
    });

    it("detects phantom exchange orders not recorded internally", () => {
      const input: ReconciliationInput = {
        internalPositions: [],
        exchangePositions: [],
        internalOrders: [],
        exchangeOrders: [
          { orderId: "phantom-ex-99", symbol: "ETHUSDT", side: "sell", quantity: 2.0, status: "NEW" },
        ],
      };

      const report = reconciliation.reconcile(input);
      expect(report.synchronized).toBe(false);
      expect(report.discrepancies[0]?.type).toBe("PHANTOM_EXCHANGE_ORDER");
      expect(report.recommendedAction).toBe("CANCEL_PHANTOM_ORDERS");
    });

    it("detects stale internal orders marked pending but missing on exchange", () => {
      const input: ReconciliationInput = {
        internalPositions: [],
        exchangePositions: [],
        internalOrders: [
          { id: "stale-1", symbol: "SOLUSDT", side: "buy", quantity: 10, status: "PENDING" },
        ],
        exchangeOrders: [],
      };

      const report = reconciliation.reconcile(input);
      expect(report.synchronized).toBe(false);
      expect(report.discrepancies[0]?.type).toBe("STALE_INTERNAL_ORDER");
      expect(report.recommendedAction).toBe("UPDATE_INTERNAL_STATE");
    });

    it("autoMitigate triggers KillSwitch when critical position drift is found", async () => {
      const input: ReconciliationInput = {
        internalPositions: [{ symbol: "BTCUSDT", quantity: 2.0 }],
        exchangePositions: [{ symbol: "BTCUSDT", quantity: -1.0 }], // opposite direction!
        internalOrders: [],
        exchangeOrders: [],
      };

      const report = reconciliation.reconcile(input);
      expect(report.recommendedAction).toBe("TRIGGER_KILL_SWITCH");

      const mitigation = await reconciliation.autoMitigate(report, {
        killSwitch,
        broker: paperBroker,
        orderManager,
      });

      expect(mitigation.mitigated).toBe(true);
      expect(killSwitch.isHalted()).toBe(true);
      expect(mitigation.actionsTaken.some((a) => a.includes("kill switch"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Lifecycle & Graceful Shutdown
  // ---------------------------------------------------------------------------

  describe("Lifecycle Manager", () => {
    let lifecycle: LifecycleManager;
    let killSwitch: KillSwitch;

    beforeEach(() => {
      killSwitch = new KillSwitch({ bus });
      lifecycle = new LifecycleManager({
        bus,
        orderManager,
        broker: paperBroker,
        killSwitch,
      });
    });

    it("transitions state from INITIALIZED to RUNNING and accepts orders", () => {
      expect(lifecycle.getState()).toBe("INITIALIZED");
      lifecycle.start();
      expect(lifecycle.getState()).toBe("RUNNING");
      expect(lifecycle.isAcceptingOrders()).toBe(true);
    });

    it("gracefulShutdown drains in-flight requests, cancels open orders, and stops", async () => {
      lifecycle.start();

      // Create active order
      const o = orderManager.createOrder({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.5,
        type: "limit",
        price: 45_000,
      });
      orderManager.updateStatus(o.id, "PENDING");
      orderManager.updateStatus(o.id, "SUBMITTED");

      // Track a pending promise
      let resolved = false;
      const longPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 50);
      });
      lifecycle.trackInflight(longPromise);
      expect(lifecycle.getInflightCount()).toBe(1);

      let cleanupRan = false;
      lifecycle.registerCleanupHandler(() => {
        cleanupRan = true;
      });

      const res = await lifecycle.gracefulShutdown("TEST_SHUTDOWN");

      expect(lifecycle.getState()).toBe("STOPPED");
      expect(lifecycle.isAcceptingOrders()).toBe(false);
      expect(res.cancelledOrders).toBe(1);
      expect(cleanupRan).toBe(true);
      expect(resolved).toBe(true);

      const updated = orderManager.getOrder(o.id);
      expect(updated?.status).toBe("CANCELLED");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Execution Pipeline Safety Gate Integration
  // ---------------------------------------------------------------------------

  describe("Execution Pipeline Safety Integration", () => {
    const dummyRiskAgent = {
      evaluate: () => ({
        approved: true,
        reason: "approved",
        ticket: { id: "ticket-1", hmac: "sig" },
      }),
    } as unknown as RiskAgent;

    it("blocks execution pipeline when Emergency Kill Switch is triggered", async () => {
      const killSwitch = new KillSwitch({ bus });
      await killSwitch.trigger("Black swan market event");

      const pipeline = new ExecutionPipeline({
        bus,
        riskAgent: dummyRiskAgent,
        paperBroker,
        orderManager,
        killSwitch,
      });

      const result = await pipeline.execute({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        price: 50_000,
        agentId: "test-agent",
      });

      expect(result.success).toBe(false);
      expect(result.stage).toBe("kill_switch");
      expect(result.reason).toContain("Emergency Kill Switch is TRIGGERED");
    });

    it("blocks execution pipeline when hard limits are breached", async () => {
      const hardLimits = new HardLimitsValidator({
        maxSingleOrderNotional: 5_000,
      });

      const pipeline = new ExecutionPipeline({
        bus,
        riskAgent: dummyRiskAgent,
        paperBroker,
        orderManager,
        hardLimits,
      });

      const result = await pipeline.execute({
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.5,
        price: 50_000, // notional 25,000 > 5,000 hard limit
        agentId: "test-agent",
      });

      expect(result.success).toBe(false);
      expect(result.stage).toBe("hard_limits");
      expect(result.reason).toContain("EXCEEDS_SINGLE_ORDER_NOTIONAL");
    });
  });
});
