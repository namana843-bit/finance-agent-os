// ============================================================================
// Chat module — BotRegistry, ChatCore, ChatService tests
// NOTE: the parallel agent owns `apps/server/src/chat/*`; these tests cover
// its exact contract via `../src/chat/...` imports only.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { BotRegistry, DEFAULT_BOTS } from "../src/chat/bots.js";
import { ChatCore } from "../src/chat/chat-service.js";
import { ChatService } from "../src/chat/service.js";
import { Storage } from "../src/core/storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bus: TypedEventBus;

beforeEach(() => {
  bus = new TypedEventBus();
});

async function makeStorage(): Promise<Storage> {
  const dir = await mkdtemp(join(tmpdir(), "chat-test-"));
  return new Storage(dir);
}

async function botListLength(core: ChatCore): Promise<number> {
  const maybe = (core as unknown as { bots: unknown }).bots;
  const registry =
    typeof maybe === "function"
      ? await (maybe as () => unknown).call(core)
      : maybe;
  return (registry as { list(): Array<unknown> }).list().length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The mirror handler does async file I/O; poll until the condition holds
// instead of relying on a fixed sleep (flaky under full-suite load).
async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) break;
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// 1. BotRegistry defaults
// ---------------------------------------------------------------------------

describe("BotRegistry defaults", () => {
  it("lists 6 default bots with the expected ids", () => {
    const registry = new BotRegistry();
    const bots = registry.list();
    expect(bots).toHaveLength(6);
    expect(bots.map((b) => b.id).sort()).toEqual(
      ["chief", "execution", "market", "portfolio", "quant", "risk"].sort(),
    );
  });

  it("every default bot carries the full BotConfig shape on a paper account", () => {
    const registry = new BotRegistry();
    for (const b of registry.list()) {
      expect(typeof b.id).toBe("string");
      expect(typeof b.name).toBe("string");
      expect(typeof b.avatar).toBe("string");
      expect(typeof b.personality).toBe("string");
      expect(typeof b.agentId).toBe("string");
      expect(b.account).toBe("paper");
    }
  });

  it("DEFAULT_BOTS matches the registry defaults", () => {
    expect(DEFAULT_BOTS).toHaveLength(6);
    expect(DEFAULT_BOTS.map((b) => b.id).sort()).toEqual(
      new BotRegistry().list().map((b) => b.id).sort(),
    );
  });

  it("get() resolves known ids and undefined for unknown ids", () => {
    const registry = new BotRegistry();
    expect(registry.get("quant")?.id).toBe("quant");
    expect(registry.get("chief")?.id).toBe("chief");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("chief binds to the supervisor agent; getByAgentId() round-trips", () => {
    const registry = new BotRegistry();
    expect(registry.get("chief")?.agentId).toBe("supervisor");
    expect(registry.getByAgentId("supervisor")?.id).toBe("chief");
    expect(registry.getByAgentId("quant")?.id).toBe("quant");
    expect(registry.getByAgentId("unknown-agent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Thread / message round-trip via temp-dir Storage
// ---------------------------------------------------------------------------

describe("ChatCore threads", () => {
  it("createThread/getThreads/getMessages round-trip", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({ bus, storage });

    const thread = await core.createThread({
      title: "BTC research",
      channelId: "general",
      botId: "quant",
    });
    expect(thread.id).toBeDefined();
    expect(thread.title).toBe("BTC research");

    const threads = await core.getThreads();
    expect(threads.map((t) => t.id)).toContain(thread.id);

    const byChannel = await core.getThreads("general");
    expect(byChannel.map((t) => t.id)).toContain(thread.id);

    const otherChannel = await core.getThreads("market");
    expect(otherChannel.map((t) => t.id)).not.toContain(thread.id);

    expect(await core.getMessages(thread.id)).toEqual([]);
  });

  it("exposes its bot registry", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({ bus, storage });
    expect(await botListLength(core)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. sendUserMessage happy path
// ---------------------------------------------------------------------------

describe("ChatCore sendUserMessage", () => {
  it("saves the user msg, publishes supervisor.task, calls submitTask(content, threadId), maps {planId}", async () => {
    const storage = await makeStorage();
    const calls: Array<{ task: unknown; correlationId: unknown }> = [];
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async (task: string, correlationId?: string) => {
        calls.push({ task, correlationId });
        return { planId: "plan-xyz" };
      },
    });

    const seen: FinanceEvent[] = [];
    bus.subscribeTo("supervisor.task", (e) => {
      seen.push(e);
    });

    const thread = await core.createThread({ title: "t" });
    const content = "Analyze BTC";
    const { message, planId } = await core.sendUserMessage(thread.id, content, {
      agentId: "supervisor",
    });

    // Return value maps the submitTask result
    expect(planId).toBe("plan-xyz");
    expect(message.content).toBe(content);
    expect(message.threadId).toBe(thread.id);
    expect(message.role).toBe("user");

    // submitTask invoked with (content, threadId)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ task: content, correlationId: thread.id });

    // supervisor.task bus event carries the thread reference
    expect(seen).toHaveLength(1);
    const evt = seen[0]! as FinanceEvent & { threadId?: string };
    const data = (evt.data ?? {}) as Record<string, unknown>;
    expect([data.threadId, data.thread, evt.threadId, evt.correlationId]).toContain(
      thread.id,
    );
    expect(JSON.stringify(data)).toContain(content);

    // User message persisted and readable back
    const messages = await core.getMessages(thread.id);
    expect(messages.some((m) => m.role === "user" && m.content === content)).toBe(
      true,
    );
  });

  it("throws on unknown thread", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({ bus, storage });
    await expect(core.sendUserMessage("no-such-thread", "hello")).rejects.toThrow(
      "thread not found",
    );
  });

  it("submitTask rejection still returns the message with planId null", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async () => {
        throw new Error("downstream down");
      },
    });

    const thread = await core.createThread({ title: "t" });
    const { message, planId } = await core.sendUserMessage(thread.id, "Analyze ETH");

    expect(planId).toBeNull();
    expect(message.content).toBe("Analyze ETH");
    expect(message.threadId).toBe(thread.id);

    const messages = await core.getMessages(thread.id);
    expect(
      messages.some((m) => m.role === "user" && m.content === "Analyze ETH"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. start() mirroring of whitelisted events
// ---------------------------------------------------------------------------

describe("ChatCore event mirroring", () => {
  it("mirrors whitelisted events, ignores others, and stop() unsubscribes", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async () => ({ planId: "plan-1" }),
    });
    await core.start();

    const thread = await core.createThread({ title: "signals" });
    const seeded = await core.sendUserMessage(thread.id, "Watch BTC");
    expect(seeded.planId).toBe("plan-1");

    bus.publish({
      type: "quant.signal",
      data: {
        id: "s1",
        symbol: "BTCUSDT",
        action: "buy",
        confidence: 0.8,
        price: 70000,
        reason: "test",
      },
      source: "t",
      correlationId: "plan-1",
    });
    await waitFor(async () =>
      (await core.getMessages(thread.id)).some(
        (m) => m.role === "assistant" && m.content.includes("BTCUSDT"),
      ),
    );

    const afterSignal = await core.getMessages(thread.id);
    expect(
      afterSignal.some(
        (m) => m.role === "assistant" && m.content.includes("BTCUSDT"),
      ),
    ).toBe(true);

    // Non-whitelisted type with the same correlationId is NOT mirrored
    const count = afterSignal.length;
    bus.publish({
      type: "market.tick",
      data: { symbol: "BTCUSDT", price: 70000 },
      source: "t",
      correlationId: "plan-1",
    });
    await sleep(20);
    expect((await core.getMessages(thread.id)).length).toBe(count);

    // stop() unsubscribes: further whitelisted events are ignored
    await core.stop();
    bus.publish({
      type: "quant.signal",
      data: {
        id: "s2",
        symbol: "BTCUSDT",
        action: "sell",
        confidence: 0.9,
        price: 71000,
        reason: "later",
      },
      source: "t",
      correlationId: "plan-1",
    });
    await sleep(20);
    expect((await core.getMessages(thread.id)).length).toBe(count);
  });
});

// ---------------------------------------------------------------------------
// 6. ChatService lifecycle
// ---------------------------------------------------------------------------

describe("ChatService lifecycle", () => {
  it("returns a ChatCore instance and starts/stops cleanly", async () => {
    const service = new ChatService({ bus });
    const instance = service.getInstance();
    expect(instance).toBeInstanceOf(ChatCore);
    expect(service.getInstance()).toBe(instance);

    await service.initialize();
    await service.start();
    expect(await service.getHealth()).toBeDefined();
    await service.stop();
  });
});
