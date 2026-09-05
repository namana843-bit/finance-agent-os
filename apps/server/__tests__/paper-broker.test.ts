// ============================================================================
// Finance Agent OS — Paper Broker Tests
// Comprehensive verification of realistic paper trading simulation:
// market/limit execution, pending orders, lifecycle events, slippage, fees,
// cancellation, position management, and PnL consistency.
// ============================================================================

import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@finance/core";
import { PaperBroker } from "../src/broker/paper-broker.js";

describe("PaperBroker", () => {
  describe("initialization & portfolio defaults", () => {
    it("should have correct initial cash and empty positions", () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 50_000 });
      const portfolio = broker.getPortfolio();
      expect(portfolio.cash).toBe(50_000);
      expect(portfolio.equity).toBe(50_000);
      expect(portfolio.positions).toHaveLength(0);
      expect(portfolio.realizedPnl).toBe(0);
      expect(portfolio.unrealizedPnl).toBe(0);
      expect(portfolio.totalPnl).toBe(0);
    });
  });

  describe("market buy", () => {
    it("should fill market buy using market price + slippage and emit lifecycle events", async () => {
      const bus = new TypedEventBus();
      const events: string[] = [];
      bus.subscribeTo("order.created", () => events.push("order.created"));
      bus.subscribeTo("order.submitted", () => events.push("order.submitted"));
      bus.subscribeTo("order.filled", () => events.push("order.filled"));

      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0.001, // 0.1%
        fee: 0.0005, // 0.05%
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const order = await broker.createOrder("BTCUSDT", "buy", 1, "market");

      expect(order.status).toBe("filled");
      expect(order.side).toBe("buy");
      expect(order.type).toBe("market");
      expect(order.quantity).toBe(1);

      // Expected fill price = 50,000 * 1.001 = 50,050
      const expectedFillPrice = 50_000 * 1.001;
      expect(order.filledPrice).toBeCloseTo(expectedFillPrice, 5);

      // Fee = 50,050 * 1 * 0.0005 = 25.025
      const expectedFee = expectedFillPrice * 1 * 0.0005;
      expect(order.fee).toBeCloseTo(expectedFee, 5);

      // Cash deducted = 50,050 + 25.025 = 50,075.025
      const expectedCash = 100_000 - (expectedFillPrice + expectedFee);
      const portfolio = broker.getPortfolio();
      expect(portfolio.cash).toBeCloseTo(expectedCash, 5);

      // Position created
      expect(portfolio.positions).toHaveLength(1);
      const pos = portfolio.positions[0]!;
      expect(pos.symbol).toBe("BTCUSDT");
      expect(pos.quantity).toBe(1);
      expect(pos.entryPrice).toBeCloseTo(expectedFillPrice, 5);

      // Lifecycle events in order: created -> submitted -> filled
      expect(events).toEqual(["order.created", "order.submitted", "order.filled"]);
    });
  });

  describe("market sell", () => {
    it("should fill market sell using market price - slippage, deduct fee, and calculate realized PnL", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0,
      });

      bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 3_000 }, source: "test" });

      // Buy 2 ETH at 3,000 -> cash = 94,000
      await broker.createOrder("ETHUSDT", "buy", 2, "market");
      expect(broker.getPortfolio().cash).toBe(94_000);

      // Price rises to 3,500
      bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 3_500 }, source: "test" });

      // Sell 2 ETH at 3,500
      const sellOrder = await broker.createOrder("ETHUSDT", "sell", 2, "market");
      expect(sellOrder.status).toBe("filled");
      expect(sellOrder.filledPrice).toBe(3_500);

      const portfolio = broker.getPortfolio();
      expect(portfolio.positions).toHaveLength(0);
      expect(portfolio.cash).toBe(101_000); // 94,000 + 7,000
      expect(portfolio.realizedPnl).toBe(1_000); // (3,500 - 3,000) * 2
      expect(portfolio.unrealizedPnl).toBe(0);
      expect(portfolio.totalPnl).toBe(1_000);
      expect(portfolio.equity).toBe(101_000);
    });
  });

  describe("limit buy", () => {
    it("limit BUY must NOT fill immediately and should fill only when market price <= limit price", async () => {
      const bus = new TypedEventBus();
      let filledEventReceived = false;
      bus.subscribeTo("order.filled", (e) => {
        if ((e.data as { orderId: string }).orderId === limitOrder.id) {
          filledEventReceived = true;
        }
      });

      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0.01,
        fee: 0.001,
      });

      // Market price is 50,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Create Limit BUY at 48,000 (below market)
      const limitOrder = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 48_000);

      // 1. Must NOT fill immediately
      expect(limitOrder.status).toBe("submitted");
      expect(limitOrder.filledPrice).toBeUndefined();
      expect(broker.getOpenOrders()).toHaveLength(1);
      expect(broker.getPortfolio().positions).toHaveLength(0);
      expect(broker.getPortfolio().cash).toBe(100_000); // Cash unspent while pending
      expect(filledEventReceived).toBe(false);

      // 2. Price drops to 49,000 (still > 48,000 limit) -> still NOT filled
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 49_000 }, source: "test" });
      expect(limitOrder.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);
      expect(filledEventReceived).toBe(false);

      // 3. Price drops to 48,000 (market price <= limit price) -> SHOULD FILL at limit price
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 48_000 }, source: "test" });
      expect(limitOrder.status).toBe("filled");
      expect(limitOrder.filledPrice).toBe(48_000);
      expect(limitOrder.fee).toBeCloseTo(48_000 * 1 * 0.001, 5);
      expect(filledEventReceived).toBe(true);
      expect(broker.getOpenOrders()).toHaveLength(0);

      const portfolio = broker.getPortfolio();
      expect(portfolio.positions).toHaveLength(1);
      expect(portfolio.positions[0]!.entryPrice).toBe(48_000);
      expect(portfolio.cash).toBeCloseTo(100_000 - (48_000 + 48), 5);
    });
  });

  describe("limit sell", () => {
    it("limit SELL must NOT fill immediately and should fill only when market price >= limit price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0,
      });

      // Buy 1 BTC at 50,000 to have a position
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });
      await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(broker.getPortfolio().positions).toHaveLength(1);

      // Create Limit SELL at 55,000 (above current market price 50,000)
      const limitSell = await broker.createOrder("BTCUSDT", "sell", 1, "limit", 55_000);

      // Must remain open / submitted
      expect(limitSell.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);

      // Price moves to 53,000 -> remains open
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 53_000 }, source: "test" });
      expect(limitSell.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);

      // Price moves to 56,000 (>= 55,000) -> fills
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 56_000 }, source: "test" });
      expect(limitSell.status).toBe("filled");
      expect(limitSell.filledPrice).toBe(55_000);
      expect(broker.getOpenOrders()).toHaveLength(0);

      const portfolio = broker.getPortfolio();
      expect(portfolio.positions).toHaveLength(0);
      expect(portfolio.realizedPnl).toBe(5_000); // 55,000 - 50,000
    });
  });

  describe("limit order remains pending", () => {
    it("keeps pending limit orders open until filled or cancelled", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 50_000, latencyMs: 0 });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });

      const order = await broker.createOrder("BTCUSDT", "buy", 0.5, "limit", 50_000);
      expect(order.status).toBe("submitted");

      // Multiple non-matching ticks
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 58_000 }, source: "test" });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 55_000 }, source: "test" });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 52_000 }, source: "test" });

      const openOrders = broker.getOpenOrders();
      expect(openOrders).toHaveLength(1);
      expect(openOrders[0]!.id).toBe(order.id);
      expect(openOrders[0]!.status).toBe("submitted");
    });
  });

  describe("cancellation", () => {
    it("should cancel open order, update status, emit order.cancelled, and remove from open orders", async () => {
      const bus = new TypedEventBus();
      let cancelledEventData: unknown = null;
      bus.subscribeTo("order.cancelled", (e) => {
        cancelledEventData = e.data;
      });

      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const order = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 45_000);
      expect(broker.getOpenOrders()).toHaveLength(1);

      const cancelled = broker.cancelOrder(order.id);
      expect(cancelled).not.toBeNull();
      expect(cancelled!.status).toBe("cancelled");
      expect(broker.getOpenOrders()).toHaveLength(0);

      expect(cancelledEventData).toMatchObject({
        orderId: order.id,
        symbol: "BTCUSDT",
        side: "buy",
      });

      // Price drops to 44,000 — cancelled order must NOT fill
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 44_000 }, source: "test" });
      expect(cancelled!.status).toBe("cancelled");
      expect(broker.getPortfolio().positions).toHaveLength(0);
    });

    it("should return null when cancelling unknown or already filled order", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      expect(broker.cancelOrder("non-existent-id")).toBeNull();

      const filled = await broker.createOrder("BTCUSDT", "buy", 0.1, "market");
      expect(filled.status).toBe("filled");
      expect(broker.cancelOrder(filled.id)).toBeNull();
    });
  });

  describe("insufficient cash & position prevention", () => {
    it("should reject buy when insufficient cash and emit order.rejected", async () => {
      const bus = new TypedEventBus();
      let rejectedEvent: unknown = null;
      bus.subscribeTo("order.rejected", (e) => { rejectedEvent = e.data; });

      const broker = new PaperBroker(bus, { initialCash: 500, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const marketOrder = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(marketOrder.status).toBe("rejected");
      expect(broker.getPortfolio().cash).toBe(500); // untouched
      expect(rejectedEvent).toMatchObject({ orderId: marketOrder.id, symbol: "BTCUSDT", side: "buy" });

      const limitOrder = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 40_000);
      expect(limitOrder.status).toBe("rejected");
      expect(broker.getOpenOrders()).toHaveLength(0);
    });

    it("should reject sell when insufficient position and emit order.rejected", async () => {
      const bus = new TypedEventBus();
      let rejectedEvent: unknown = null;
      bus.subscribeTo("order.rejected", (e) => { rejectedEvent = e.data; });

      const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const sellOrder = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sellOrder.status).toBe("rejected");
      expect(rejectedEvent).toMatchObject({ orderId: sellOrder.id, symbol: "BTCUSDT", side: "sell" });
    });

    it("should reject limit buy at fill time if cash was spent after order creation", async () => {
      const bus = new TypedEventBus();
      let fillTimeReject: unknown = null;
      bus.subscribeTo("order.rejected", (e) => { fillTimeReject = e.data; });

      const broker = new PaperBroker(bus, { initialCash: 50_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });

      // 1. Limit order requiring 40,000 (allowed since cash = 50,000)
      const limitOrder = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 40_000);
      expect(limitOrder.status).toBe("submitted");

      // 2. Market order spending 45,000 cash
      bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 3_000 }, source: "test" });
      await broker.createOrder("ETHUSDT", "buy", 15, "market"); // 15 * 3000 = 45,000
      expect(broker.getPortfolio().cash).toBe(5_000);

      // 3. Price drops to trigger limit order (needs 40,000, but only 5,000 cash remains)
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 40_000 }, source: "test" });
      expect(limitOrder.status).toBe("rejected");
      expect(broker.getPortfolio().cash).toBe(5_000); // Negative cash prevented
      expect(fillTimeReject).toMatchObject({ orderId: limitOrder.id, symbol: "BTCUSDT" });
    });

    it("prevents invalid quantities, prices, symbols, and sides", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 10_000, latencyMs: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Invalid quantity
      expect((await broker.createOrder("BTCUSDT", "buy", 0, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", -5, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", NaN, "market")).status).toBe("rejected");

      // Invalid price for limit order
      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", 0)).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", -100)).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", undefined)).status).toBe("rejected");

      // Invalid symbol & side
      expect((await broker.createOrder("", "buy", 1, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "invalid" as never, 1, "market")).status).toBe("rejected");
    });
  });

  describe("fees & slippage", () => {
    it("should calculate exact fees on buy and sell", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0.002, // 0.2% fee
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Buy 1 BTC: fee = 50,000 * 0.002 = 100
      const buy = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(buy.fee).toBe(100);
      expect(broker.getPortfolio().cash).toBe(49_900); // 100,000 - (50,000 + 100)

      // Sell 1 BTC: fee = 50,000 * 0.002 = 100
      const sell = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sell.fee).toBe(100);
      expect(broker.getPortfolio().cash).toBe(99_800); // 49,900 + (50,000 - 100)
    });

    it("should calculate exact slippage for buy (+) and sell (-)", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0.005, // 0.5%
        fee: 0,
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Buy with 0.5% slippage -> 50,000 * 1.005 = 50,250
      const buy = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(buy.filledPrice).toBe(50_250);

      // Sell with 0.5% slippage -> 50,000 * 0.995 = 49,750
      const sell = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sell.filledPrice).toBe(49_750);
    });
  });

  describe("PnL tracking", () => {
    it("accurately maintains unrealized, realized, and total PnL across market price changes", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0,
      });

      // Buy 2 BTC at 50,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });
      await broker.createOrder("BTCUSDT", "buy", 2, "market");

      let p = broker.getPortfolio();
      expect(p.cash).toBe(0);
      expect(p.equity).toBe(100_000);
      expect(p.realizedPnl).toBe(0);
      expect(p.unrealizedPnl).toBe(0);
      expect(p.totalPnl).toBe(0);

      // Price rises to 60,000 (+20,000 unrealized)
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });
      p = broker.getPortfolio();
      expect(p.equity).toBe(120_000);
      expect(p.unrealizedPnl).toBe(20_000);
      expect(p.realizedPnl).toBe(0);
      expect(p.totalPnl).toBe(20_000);

      // Sell 1 BTC at 60,000 (realize +10,000)
      await broker.createOrder("BTCUSDT", "sell", 1, "market");
      p = broker.getPortfolio();
      expect(p.cash).toBe(60_000);
      expect(p.equity).toBe(120_000);
      expect(p.realizedPnl).toBe(10_000);
      expect(p.unrealizedPnl).toBe(10_000);
      expect(p.totalPnl).toBe(20_000);

      // Price drops to 40,000 (-10,000 unrealized on remaining 1 BTC)
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 40_000 }, source: "test" });
      p = broker.getPortfolio();
      expect(p.equity).toBe(100_000); // 60,000 cash + 40,000 BTC
      expect(p.realizedPnl).toBe(10_000);
      expect(p.unrealizedPnl).toBe(-10_000);
      expect(p.totalPnl).toBe(0);

      // Sell remaining 1 BTC at 40,000 (-10,000 realized)
      await broker.createOrder("BTCUSDT", "sell", 1, "market");
      p = broker.getPortfolio();
      expect(p.cash).toBe(100_000);
      expect(p.equity).toBe(100_000);
      expect(p.realizedPnl).toBe(0); // +10,000 + (-10,000)
      expect(p.unrealizedPnl).toBe(0);
      expect(p.totalPnl).toBe(0);
      expect(p.positions).toHaveLength(0);
    });
  });

  describe("multiple orders", () => {
    it("handles multiple concurrent limit orders for multiple symbols accurately", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 150_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0,
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });
      bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 3_000 }, source: "test" });

      // Create limit orders
      const btcLimit1 = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 48_000);
      const btcLimit2 = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 45_000);
      const ethLimit = await broker.createOrder("ETHUSDT", "buy", 10, "limit", 2_800);

      expect(broker.getOpenOrders()).toHaveLength(3);

      // BTC tick at 47,000 triggers btcLimit1 only
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 47_000 }, source: "test" });
      expect(btcLimit1.status).toBe("filled");
      expect(btcLimit2.status).toBe("submitted");
      expect(ethLimit.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(2);

      // ETH tick at 2,750 triggers ethLimit only
      bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 2_750 }, source: "test" });
      expect(ethLimit.status).toBe("filled");
      expect(btcLimit2.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);

      // Cancel remaining btcLimit2
      broker.cancelOrder(btcLimit2.id);
      expect(btcLimit2.status).toBe("cancelled");
      expect(broker.getOpenOrders()).toHaveLength(0);

      // Verify order history contains all 3 orders
      const history = broker.getOrderHistory();
      expect(history).toHaveLength(3);
    });
  });
});

