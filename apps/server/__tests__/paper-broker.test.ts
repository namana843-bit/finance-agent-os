// ============================================================================
// Finance Agent OS — Paper Broker Tests
// Comprehensive verification of realistic paper trading simulation:
// Long/Short entries, increase, partial/full close, reversals, average entry price,
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

  describe("Long positions (entry, increase, partial close, full close)", () => {
    it("1. Long entry: creates long position with entry price and deducts cash", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const order = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(order.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(50_000);
      expect(pf.positions).toHaveLength(1);
      expect(pf.positions[0]!.side).toBe("long");
      expect(pf.positions[0]!.quantity).toBe(1);
      expect(pf.positions[0]!.entryPrice).toBe(50_000);
      expect(pf.equity).toBe(100_000);
    });

    it("2. Long increase: updates position quantity and weighted average entry price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 200_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Buy 1 BTC @ 50,000
      await broker.createOrder("BTCUSDT", "buy", 1, "market");

      // Price moves to 60,000, Buy another 2 BTC @ 60,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });
      await broker.createOrder("BTCUSDT", "buy", 2, "market");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(30_000); // 200,000 - 50,000 - 120,000
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.quantity).toBe(3);
      // Average entry price = (50,000 * 1 + 60,000 * 2) / 3 = 170,000 / 3 = 56,666.6667
      expect(pos.entryPrice).toBeCloseTo(56_666.6667, 4);
      // Unrealized PnL = (60,000 - 56,666.6667) * 3 = 10,000
      expect(pos.unrealizedPnl).toBeCloseTo(10_000, 4);
      expect(pf.equity).toBeCloseTo(210_000, 4);
    });

    it("3. Long partial close: reduces quantity, realizes PnL, preserves entry price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      await broker.createOrder("BTCUSDT", "buy", 2, "market"); // 2 BTC @ 50,000

      // Price rises to 55,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 55_000 }, source: "test" });

      // Sell 1 BTC (partial close)
      const sell = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sell.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(55_000); // 0 + 55,000
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.quantity).toBe(1);
      expect(pos.entryPrice).toBe(50_000); // Entry price unchanged on partial close
      expect(pos.unrealizedPnl).toBe(5_000); // (55,000 - 50,000) * 1
      expect(pf.realizedPnl).toBe(5_000); // (55,000 - 50,000) * 1
      expect(pf.totalPnl).toBe(10_000); // 5,000 realized + 5,000 unrealized
      expect(pf.equity).toBe(110_000); // 55,000 cash + 55,000 BTC value
    });

    it("4. Long full close: realizes full PnL and deletes position", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      await broker.createOrder("BTCUSDT", "buy", 2, "market");
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });

      // Sell 2 BTC
      await broker.createOrder("BTCUSDT", "sell", 2, "market");

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(0);
      expect(pf.cash).toBe(120_000);
      expect(pf.realizedPnl).toBe(20_000);
      expect(pf.unrealizedPnl).toBe(0);
      expect(pf.totalPnl).toBe(20_000);
      expect(pf.equity).toBe(120_000);
    });
  });

  describe("Short positions (entry, increase, partial close, full close)", () => {
    it("5. Short entry: creates short position with initial proceeds and tracks liability", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Short 1 BTC @ 50,000
      const order = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(order.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(150_000); // 100,000 + 50,000 proceeds
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.side).toBe("short");
      expect(pos.quantity).toBe(1);
      expect(pos.entryPrice).toBe(50_000);
      expect(pos.unrealizedPnl).toBe(0);
      expect(pf.equity).toBe(100_000); // 150,000 cash - 50,000 liability
    });

    it("6. Short increase: updates short quantity and weighted average entry price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 200_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Short 1 BTC @ 50,000
      await broker.createOrder("BTCUSDT", "sell", 1, "market");

      // Price rises to 60,000, Short another 2 BTC @ 60,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });
      await broker.createOrder("BTCUSDT", "sell", 2, "market");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(370_000); // 200,000 + 50,000 + 120,000
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.side).toBe("short");
      expect(pos.quantity).toBe(3);
      // Average entry price = (50,000 * 1 + 60,000 * 2) / 3 = 56,666.6667
      expect(pos.entryPrice).toBeCloseTo(56_666.6667, 4);
      // Unrealized PnL = (56,666.6667 - 60,000) * 3 = -10,000
      expect(pos.unrealizedPnl).toBeCloseTo(-10_000, 4);
      // Equity = 370,000 - (60,000 * 3) = 190,000
      expect(pf.equity).toBeCloseTo(190_000, 4);
    });

    it("7. Short partial close: buys back portion, realizes PnL, preserves entry price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Short 2 BTC @ 50,000 -> cash = 200,000
      await broker.createOrder("BTCUSDT", "sell", 2, "market");

      // Price drops to 40,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 40_000 }, source: "test" });

      // Buy back 1 BTC (partial close) @ 40,000
      const buyBack = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(buyBack.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.cash).toBe(160_000); // 200,000 - 40,000
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.side).toBe("short");
      expect(pos.quantity).toBe(1);
      expect(pos.entryPrice).toBe(50_000); // Unchanged
      // Unrealized PnL = (50,000 - 40,000) * 1 = +10,000
      expect(pos.unrealizedPnl).toBe(10_000);
      // Realized PnL = (50,000 - 40,000) * 1 = +10,000
      expect(pf.realizedPnl).toBe(10_000);
      expect(pf.totalPnl).toBe(20_000);
      // Equity = 160,000 cash - 40,000 liability = 120,000
      expect(pf.equity).toBe(120_000);
    });

    it("8. Short full close: realizes full PnL and deletes short position", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Short 2 BTC @ 50,000
      await broker.createOrder("BTCUSDT", "sell", 2, "market");

      // Price drops to 30,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 30_000 }, source: "test" });

      // Buy back 2 BTC @ 30,000
      await broker.createOrder("BTCUSDT", "buy", 2, "market");

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(0);
      expect(pf.cash).toBe(140_000); // 200,000 - 60,000
      expect(pf.realizedPnl).toBe(40_000); // (50,000 - 30,000) * 2
      expect(pf.unrealizedPnl).toBe(0);
      expect(pf.totalPnl).toBe(40_000);
      expect(pf.equity).toBe(140_000);
    });
  });

  describe("Position reversals (Long -> Short & Short -> Long)", () => {
    it("reverses Long to Short when Sell quantity exceeds Long position", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Long 1 BTC @ 50,000
      await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(broker.getPortfolio().cash).toBe(50_000);

      // Price rises to 60,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 60_000 }, source: "test" });

      // Sell 2.5 BTC (Closes 1 BTC Long and opens 1.5 BTC Short!)
      const revOrder = await broker.createOrder("BTCUSDT", "sell", 2.5, "market");
      expect(revOrder.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.side).toBe("short");
      expect(pos.quantity).toBe(1.5);
      expect(pos.entryPrice).toBe(60_000);

      // Realized on 1 BTC Long close: (60,000 - 50,000) * 1 = +10,000
      expect(pf.realizedPnl).toBe(10_000);
      // Cash = 50,000 (remaining) + 60,000 (long sell) + 90,000 (1.5 short proceeds) = 200,000
      expect(pf.cash).toBe(200_000);
      // Equity = 200,000 cash - (60,000 * 1.5 liability) = 110,000
      expect(pf.equity).toBe(110_000);
    });

    it("reverses Short to Long when Buy quantity exceeds Short position", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Short 1 BTC @ 50,000 -> cash = 150,000
      await broker.createOrder("BTCUSDT", "sell", 1, "market");

      // Price drops to 40,000
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 40_000 }, source: "test" });

      // Buy 3 BTC (Closes 1 BTC Short and opens 2 BTC Long!)
      const revOrder = await broker.createOrder("BTCUSDT", "buy", 3, "market");
      expect(revOrder.status).toBe("filled");

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(1);
      const pos = pf.positions[0]!;
      expect(pos.side).toBe("long");
      expect(pos.quantity).toBe(2);
      expect(pos.entryPrice).toBe(40_000);

      // Realized on 1 BTC Short close: (50,000 - 40,000) * 1 = +10,000
      expect(pf.realizedPnl).toBe(10_000);
      // Cash = 150,000 - (40,000 * 1 short buyback) - (40,000 * 2 long buy) = 30,000
      expect(pf.cash).toBe(30_000);
      // Equity = 30,000 cash + (40,000 * 2 long value) = 110,000
      expect(pf.equity).toBe(110_000);
    });
  });

  describe("Limit Orders with Long and Short Positions", () => {
    it("Limit BUY closes Short position when price drops to limit price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Open Short @ 50,000
      await broker.createOrder("BTCUSDT", "sell", 1, "market");

      // Place Limit BUY (take profit) @ 42,000
      const limitBuy = await broker.createOrder("BTCUSDT", "buy", 1, "limit", 42_000);
      expect(limitBuy.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);

      // Tick at 45,000 -> remains open
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 45_000 }, source: "test" });
      expect(broker.getOrder(limitBuy.id)!.status).toBe("submitted");

      // Tick at 42,000 -> fills and closes short
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 42_000 }, source: "test" });
      const updatedBuy = broker.getOrder(limitBuy.id)!;
      expect(updatedBuy.status).toBe("filled");
      expect(updatedBuy.filledPrice).toBe(42_000);
      expect(broker.getOpenOrders()).toHaveLength(0);

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(0);
      expect(pf.cash).toBe(108_000); // 150,000 - 42,000
      expect(pf.realizedPnl).toBe(8_000); // (50,000 - 42,000) * 1
    });

    it("Limit SELL opens Short position when price rises to limit price", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 100_000, latencyMs: 0, slippage: 0, fee: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Place Limit SELL @ 55,000
      const limitSell = await broker.createOrder("BTCUSDT", "sell", 1, "limit", 55_000);
      expect(limitSell.status).toBe("submitted");
      expect(broker.getOpenOrders()).toHaveLength(1);

      // Price rises to 55,000 -> fills and enters short
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 55_000 }, source: "test" });
      const updatedSell = broker.getOrder(limitSell.id)!;
      expect(updatedSell.status).toBe("filled");
      expect(updatedSell.filledPrice).toBe(55_000);

      const pf = broker.getPortfolio();
      expect(pf.positions).toHaveLength(1);
      expect(pf.positions[0]!.side).toBe("short");
      expect(pf.positions[0]!.entryPrice).toBe(55_000);
      expect(pf.cash).toBe(155_000);
      expect(pf.equity).toBe(100_000);
    });
  });

  describe("Spot-only mode vs Futures mode", () => {
    it("rejects shorting when allowShort is false", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 50_000, latencyMs: 0, allowShort: false });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      const sellOrder = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sellOrder.status).toBe("rejected");
      expect(sellOrder.reason).toMatch(/Insufficient position/);
    });
  });

  describe("cancellation & open orders", () => {
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

  describe("fees & slippage", () => {
    it("calculates exact fees for entry and closing", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0,
        fee: 0.001, // 0.1%
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Buy 1 BTC: fee = 50,000 * 0.001 = 50
      const buy = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(buy.fee).toBe(50);
      expect(broker.getPortfolio().cash).toBe(49_950); // 100,000 - 50,050

      // Sell 1 BTC: fee = 50,000 * 0.001 = 50
      const sell = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sell.fee).toBe(50);
      expect(broker.getPortfolio().cash).toBe(99_900); // 49,950 + (50,000 - 50)
    });

    it("applies slippage accurately for buy and sell", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, {
        initialCash: 100_000,
        latencyMs: 0,
        slippage: 0.01, // 1%
        fee: 0,
      });

      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      // Market buy with 1% slippage -> 50,000 * 1.01 = 50,500
      const buy = await broker.createOrder("BTCUSDT", "buy", 1, "market");
      expect(buy.filledPrice).toBe(50_500);

      // Market sell with 1% slippage -> 50,000 * 0.99 = 49,500
      const sell = await broker.createOrder("BTCUSDT", "sell", 1, "market");
      expect(sell.filledPrice).toBe(49_500);
    });
  });

  describe("Validation & error prevention", () => {
    it("rejects invalid quantities, prices, symbols, and sides", async () => {
      const bus = new TypedEventBus();
      const broker = new PaperBroker(bus, { initialCash: 10_000, latencyMs: 0 });
      bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 50_000 }, source: "test" });

      expect((await broker.createOrder("BTCUSDT", "buy", 0, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", -5, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", NaN, "market")).status).toBe("rejected");

      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", 0)).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", -100)).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "buy", 1, "limit", undefined)).status).toBe("rejected");

      expect((await broker.createOrder("", "buy", 1, "market")).status).toBe("rejected");
      expect((await broker.createOrder("BTCUSDT", "invalid" as never, 1, "market")).status).toBe("rejected");
    });
  });
});


