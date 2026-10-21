import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { PaperBroker } from "../src/broker/paper-broker.js";

const FEE = 0.001;

function setup() {
  const bus = new TypedEventBus();
  const broker = new PaperBroker(bus, { initialCash: 100_000, fee: FEE, slippage: 0, latencyMs: 0 });
  broker.priceCache.set("BTCUSDT", 100);
  const events: string[] = [];
  bus.subscribeTo("order.filled", () => events.push("filled"));
  bus.subscribeTo("order.partially_filled", () => events.push("partial"));
  return { bus, broker, events };
}

describe("PaperBroker partial fills", () => {
  let bus: TypedEventBus;
  let broker: PaperBroker;
  let events: string[];

  beforeEach(() => {
    ({ bus, broker, events } = setup());
  });

  it("accumulates filled quantity, fees and weighted average price across partials", async () => {
    const order = await broker.createOrder("BTCUSDT", "buy", 10, "limit", 100);
    const r1 = await broker.partialFill(order.id, 4, 100, { fillId: "f1" });
    expect(r1!.filledQuantity).toBe(4);
    expect(r1!.fee).toBeCloseTo(400 * FEE, 8);
    expect(r1!.averageFillPrice).toBeCloseTo(100, 8);
    expect(r1!.status).toBe("partially_filled");

    const r2 = await broker.partialFill(order.id, 3, 110, { fillId: "f2" });
    expect(r2).not.toBeNull();
    expect(r2!.filledQuantity).toBe(7);
    expect(r2!.fee).toBeCloseTo(400 * FEE + 330 * FEE, 8);
    expect(r2!.averageFillPrice).toBeCloseTo((4 * 100 + 3 * 110) / 7, 8);
    expect(r2!.status).toBe("partially_filled");
  });

  it("emits order.partially_filled for partials and order.filled only on completion", async () => {
    const order = await broker.createOrder("BTCUSDT", "buy", 10, "limit", 100);
    await broker.partialFill(order.id, 4, 100, { fillId: "f1" });
    expect(events).toEqual(["partial"]);

    await broker.partialFill(order.id, 6, 100, { fillId: "f2" });
    expect(events).toEqual(["partial", "filled"]);

    const final = broker.getOrder(order.id)!;
    expect(final.status).toBe("filled");
    expect(final.filledQuantity).toBe(10);
  });

  it("is idempotent per fillId and rejects over-fills", async () => {
    const order = await broker.createOrder("BTCUSDT", "buy", 10, "limit", 100);
    await broker.partialFill(order.id, 4, 100, { fillId: "f1" });
    const dup = await broker.partialFill(order.id, 4, 100, { fillId: "f1" });
    expect(dup!.filledQuantity).toBe(4);

    const over = await broker.partialFill(order.id, 7, 100, { fillId: "f2" });
    expect(over).toBeNull();
    expect(broker.getOrder(order.id)!.filledQuantity).toBe(4);
  });

  it("keeps portfolio cash and position in sync with partial fills", async () => {
    const order = await broker.createOrder("BTCUSDT", "buy", 10, "limit", 100);
    await broker.partialFill(order.id, 4, 100, { fillId: "f1" });
    await broker.partialFill(order.id, 3, 100, { fillId: "f2" });

    const p = broker.getPortfolio();
    expect(p.cash).toBeCloseTo(100_000 - 700 - 700 * FEE, 6);
    expect(p.positions.length).toBe(1);
    expect(p.positions[0].quantity).toBe(7);
    expect(p.positions[0].entryPrice).toBeCloseTo(100, 8);
  });
});
