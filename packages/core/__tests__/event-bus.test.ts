// ============================================================================
// Finance Agent OS — EventBus Tests
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "../src/event-bus.js";

describe("TypedEventBus", () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = new TypedEventBus({ maxHistory: 100 });
  });

  it("should publish an event with auto-generated id and timestamp", () => {
    const event = bus.publish({ type: "test.event", data: { value: 42 } });
    expect(event.id).toBeDefined();
    expect(event.type).toBe("test.event");
    expect(event.data).toEqual({ value: 42 });
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("should reject events without type", () => {
    expect(() => bus.publish({ type: "", data: null })).toThrow("Event type is required");
  });

  it("should subscribe to all events", () => {
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.type));

    bus.publish({ type: "a" });
    bus.publish({ type: "b" });

    expect(received).toEqual(["a", "b"]);
  });

  it("should subscribe to specific event type", () => {
    const received: string[] = [];
    bus.subscribeTo("market.tick", (event) => received.push(event.type));

    bus.publish({ type: "market.tick" });
    bus.publish({ type: "other.event" });

    expect(received).toEqual(["market.tick"]);
  });

  it("should support multiple subscribers", () => {
    const received1: string[] = [];
    const received2: string[] = [];
    bus.subscribe((event) => received1.push(event.type));
    bus.subscribe((event) => received2.push(event.type));

    bus.publish({ type: "test" });

    expect(received1).toEqual(["test"]);
    expect(received2).toEqual(["test"]);
  });

  it("should unsubscribe correctly", () => {
    const received: string[] = [];
    const unsub = bus.subscribe((event) => received.push(event.type));

    bus.publish({ type: "a" });
    unsub();
    bus.publish({ type: "b" });

    expect(received).toEqual(["a"]);
  });

  it("should maintain event ordering", () => {
    const received: number[] = [];
    bus.subscribe((event) => received.push((event.data as any).i));

    for (let i = 0; i < 10; i++) {
      bus.publish({ type: "test", data: { i } });
    }

    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should enforce max history", () => {
    const smallBus = new TypedEventBus({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      smallBus.publish({ type: "test", data: { i } });
    }
    expect(smallBus.size()).toBe(5);
    const history = smallBus.getHistory();
    expect(history[0].data).toEqual({ i: 5 });
  });

  it("should filter history by type", () => {
    bus.publish({ type: "a" });
    bus.publish({ type: "b" });
    bus.publish({ type: "a" });

    const filtered = bus.getHistory({ type: "a" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.type === "a")).toBe(true);
  });

  it("should filter history by since timestamp", () => {
    const t1 = bus.publish({ type: "a" });
    const t2 = bus.publish({ type: "b" });
    const t3 = bus.publish({ type: "c" });

    const filtered = bus.getHistory({ since: t2.timestamp });
    expect(filtered.length).toBeGreaterThanOrEqual(2);
  });

  it("should limit history results", () => {
    for (let i = 0; i < 10; i++) {
      bus.publish({ type: "test" });
    }
    const limited = bus.getHistory(undefined, 3);
    expect(limited).toHaveLength(3);
  });

  it("should replay history to handler", async () => {
    bus.publish({ type: "a" });
    bus.publish({ type: "b" });

    const received: string[] = [];
    const count = await bus.replay((event) => {
      received.push(event.type);
    });

    expect(count).toBe(2);
    expect(received).toEqual(["a", "b"]);
  });

  it("should track subscriber count", () => {
    expect(bus.subscriberCount()).toBe(0);
    const unsub1 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(1);
    const unsub2 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(2);
    unsub1();
    expect(bus.subscriberCount()).toBe(1);
    unsub2();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("should handle async subscribers", async () => {
    const received: string[] = [];
    bus.subscribe(async (event) => {
      await new Promise((r) => setTimeout(r, 10));
      received.push(event.type);
    });

    bus.publish({ type: "async-test" });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["async-test"]);
  });

  it("should handle subscriber errors gracefully", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error("handler error");
    });

    // Should not throw
    bus.publish({ type: "error-test" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
