// ============================================================================
// Finance Agent OS — Paper Broker Tests
// ============================================================================

import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@finance/core";
import { PaperBroker } from "../src/broker/paper-broker.js";

describe("PaperBroker", () => {
  it("should have correct initial cash", () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { initialCash: 50_000 });
    const portfolio = broker.getPortfolio();
    expect(portfolio.cash).toBe(50_000);
    expect(portfolio.equity).toBe(50_000);
    expect(portfolio.positions).toHaveLength(0);
  });

  it("should execute a buy order and create position", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { initialCash: 50_000, latencyMs: 0, slippage: 0, fee: 0 });

    // Seed price
    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    const order = await broker.createOrder("BTCUSDT", "buy", 0.01, "market");
    expect(order.status).toBe("filled");
    expect(order.filledPrice).toBeGreaterThan(0);

    const portfolio = broker.getPortfolio();
    expect(portfolio.cash).toBeLessThan(50_000);
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]!.symbol).toBe("BTCUSDT");
    expect(portfolio.positions[0]!.quantity).toBe(0.01);
  });

  it("should execute a sell order", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0 });

    bus.publish({ type: "market.tick", data: { symbol: "ETHUSDT", price: 3000 }, source: "test" });

    // Buy first
    await broker.createOrder("ETHUSDT", "buy", 2, "market");
    const afterBuy = broker.getPortfolio();
    expect(afterBuy.positions).toHaveLength(1);

    // Sell all
    const sellOrder = await broker.createOrder("ETHUSDT", "sell", 2, "market");
    expect(sellOrder.status).toBe("filled");

    const afterSell = broker.getPortfolio();
    expect(afterSell.positions).toHaveLength(0);
  });

  it("should reject buy when insufficient cash", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { initialCash: 100, latencyMs: 0, slippage: 0, fee: 0 });

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    const order = await broker.createOrder("BTCUSDT", "buy", 1, "market");
    expect(order.status).toBe("rejected");
  });

  it("should reject sell when insufficient position", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0 });

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    const order = await broker.createOrder("BTCUSDT", "sell", 1, "market");
    expect(order.status).toBe("rejected");
  });

  it("should track order history", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0 });

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    await broker.createOrder("BTCUSDT", "buy", 0.01, "market");
    await broker.createOrder("BTCUSDT", "buy", 0.01, "market");

    const history = broker.getOrderHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("should apply slippage to market orders", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0.01, fee: 0 }); // 1% slippage

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    const order = await broker.createOrder("BTCUSDT", "buy", 0.01, "market");
    expect(order.status).toBe("filled");
    expect(order.filledPrice!).toBeGreaterThan(68000); // buy price should be higher due to slippage
  });

  it("should charge fees", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0.001 }); // 0.1% fee

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });

    const order = await broker.createOrder("BTCUSDT", "buy", 0.01, "market");
    expect(order.fee).toBeGreaterThan(0);
  });

  it("should publish order.filled event", async () => {
    const bus = new TypedEventBus();
    const broker = new PaperBroker(bus, { latencyMs: 0, slippage: 0, fee: 0 });
    let filledEvent = false;
    bus.subscribeTo("order.filled", () => { filledEvent = true; });

    bus.publish({ type: "market.tick", data: { symbol: "BTCUSDT", price: 68000 }, source: "test" });
    await broker.createOrder("BTCUSDT", "buy", 0.01, "market");

    expect(filledEvent).toBe(true);
  });
});
