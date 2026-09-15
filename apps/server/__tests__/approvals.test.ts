// ============================================================================
// Approvals module — ApprovalService / ApprovalError / Wrapper tests
// NOTE: the parallel agent owns `apps/server/src/approvals/*`; these tests cover
// its exact contract via `../src/approvals/...` imports only.
// ChatCore + Storage are imported read-only for ONE integration test.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { ApprovalService } from "../src/approvals/approval-service.js";
import { ApprovalError } from "../src/approvals/types.js";
import { ApprovalServiceWrapper } from "../src/approvals/service.js";
import { ChatCore } from "../src/chat/chat-service.js";
import { Storage } from "../src/core/storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bus: TypedEventBus;

beforeEach(() => {
  bus = new TypedEventBus();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll instead of fixed-sleep assertions (flaky under full-suite load).
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) break;
    await sleep(10);
  }
}

async function makeStorage(): Promise<Storage> {
  const dir = await mkdtemp(join(tmpdir(), "approvals-test-"));
  return new Storage(dir);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return {};
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

// ---------------------------------------------------------------------------
// 1. isGating
// ---------------------------------------------------------------------------

describe("ApprovalService isGating", () => {
  it("paper → false", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper" });
    expect(await svc.isGating()).toBe(false);
  });

  it("auto-paper + paper → false", async () => {
    const svc = new ApprovalService({ bus, mode: "auto-paper", executionMode: "paper" });
    expect(await svc.isGating()).toBe(false);
  });

  it("live → true", async () => {
    const svc = new ApprovalService({ bus, executionMode: "live" });
    expect(await svc.isGating()).toBe(true);
  });

  it("always + paper → true", async () => {
    const svc = new ApprovalService({ bus, mode: "always", executionMode: "paper" });
    expect(await svc.isGating()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. quant.signal auto-proposal (gating OFF vs ON)
// ---------------------------------------------------------------------------

describe("ApprovalService quant.signal gating", () => {
  const signalData = {
    id: "sig-1",
    symbol: "BTCUSDT",
    action: "buy",
    side: "buy",
    price: 50000,
    confidence: 0.85,
    quantity: 0.05,
    qty: 0.05,
    reason: "breakout",
    strategy: "momentum",
  };

  function publishSignal(correlationId = "corr-1"): void {
    bus.publish({
      type: "quant.signal",
      data: { ...signalData },
      source: "quant",
      correlationId,
    });
  }

  it("gating OFF creates NO proposal and publishes nothing", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper" });
    await svc.start();
    try {
      const seen: FinanceEvent[] = [];
      bus.subscribeTo("trade.proposal_created", (e) => {
        seen.push(e);
      });

      publishSignal();
      await sleep(40);

      expect(await svc.list()).toHaveLength(0);
      expect(seen).toHaveLength(0);
    } finally {
      await svc.stop();
    }
  });

  it("gating ON creates a pending proposal mapped from signal fields + publishes trade.proposal_created", async () => {
    const svc = new ApprovalService({ bus, executionMode: "live" });
    await svc.start();
    try {
      const seen: FinanceEvent[] = [];
      bus.subscribeTo("trade.proposal_created", (e) => {
        seen.push(e);
      });

      publishSignal();
      await waitFor(async () => (await svc.list()).length === 1 && seen.length >= 1);

      const proposals = await svc.list();
      expect(proposals).toHaveLength(1);
      const proposal = asRecord(proposals[0]);
      expect(proposal["symbol"]).toBe("BTCUSDT");
      expect(proposal["side"]).toBe("buy");
      expect(proposal["quantity"]).toBe(0.05);
      expect(proposal["price"]).toBe(50000);
      expect(proposal["status"]).toBe("pending");
      expect(typeof proposal["id"]).toBe("string");
      expect(typeof proposal["expiresAt"]).toBe("number");

      expect(seen.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.stringify(seen.map((e) => e.data));
      expect(payload).toContain("BTCUSDT");
      expect(payload).toContain(String(proposal["id"]));
    } finally {
      await svc.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Manual propose / list / get / approve / reject + error codes
// ---------------------------------------------------------------------------

describe("ApprovalService manual lifecycle", () => {
  it("propose/list/get round-trip", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper" });
    await svc.start();
    try {
      const proposal = asRecord(
        await svc.propose({
          symbol: "ETHUSDT",
          side: "sell",
          quantity: 1,
          price: 3000,
          confidence: 0.7,
          reason: "take profit",
          strategy: "momentum",
        }),
      );
      expect(proposal["symbol"]).toBe("ETHUSDT");
      expect(proposal["side"]).toBe("sell");
      expect(proposal["quantity"]).toBe(1);
      expect(proposal["price"]).toBe(3000);
      expect(proposal["status"]).toBe("pending");
      expect(typeof proposal["id"]).toBe("string");
      expect(typeof proposal["expiresAt"]).toBe("number");

      const id = String(proposal["id"]);
      const all = await svc.list();
      expect(all.map((p) => asRecord(p)["id"])).toContain(id);
      const pending = await svc.list("pending");
      expect(pending.map((p) => asRecord(p)["id"])).toContain(id);

      const fetched = asRecord(await svc.get(id));
      expect(fetched["id"]).toBe(id);
      expect(fetched["symbol"]).toBe("ETHUSDT");
    } finally {
      await svc.stop();
    }
  });

  it("approve with fake pipeline → approved, result stored, trade.proposal_approved published", async () => {
    const svc = new ApprovalService({
      bus,
      executionMode: "paper",
      getPipeline: () => ({ execute: async (signal: unknown) => ({ success: true, stage: "completed", signal }) }),
    });
    await svc.start();
    try {
      const seen: FinanceEvent[] = [];
      bus.subscribeTo("trade.proposal_approved", (e) => {
        seen.push(e);
      });

      const created = asRecord(
        await svc.propose({ symbol: "BTCUSDT", side: "buy", quantity: 0.1, price: 50000 }),
      );
      const id = String(created["id"]);

      const outcome = asRecord(await svc.approve(id, { agentId: "tester" }));
      const approved = asRecord(outcome["proposal"]);
      const result = asRecord(outcome["result"]);
      expect(approved["status"]).toBe("approved");
      expect(result["success"]).toBe(true);
      expect(result["stage"]).toBe("completed");

      const stored = asRecord(await svc.get(id));
      expect(stored["status"]).toBe("approved");
      expect(asRecord(stored["result"])["success"]).toBe(true);

      await waitFor(async () => seen.length >= 1);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(seen.map((e) => e.data))).toContain(id);
    } finally {
      await svc.stop();
    }
  });

  it("approve unknown → ApprovalError NOT_FOUND", async () => {
    const svc = new ApprovalService({
      bus,
      executionMode: "paper",
      getPipeline: () => ({ execute: async (signal: unknown) => ({ success: true, stage: "completed", signal }) }),
    });
    await svc.start();
    try {
      let err: unknown = null;
      try {
        await svc.approve("does-not-exist", { agentId: "tester" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalError);
      expect(codeOf(err)).toBe("NOT_FOUND");
    } finally {
      await svc.stop();
    }
  });

  it("second approve → NOT_PENDING", async () => {
    const svc = new ApprovalService({
      bus,
      executionMode: "paper",
      getPipeline: () => ({ execute: async (signal: unknown) => ({ success: true, stage: "completed", signal }) }),
    });
    await svc.start();
    try {
      const created = asRecord(
        await svc.propose({ symbol: "BTCUSDT", side: "buy", quantity: 0.1, price: 50000 }),
      );
      const id = String(created["id"]);
      await svc.approve(id, { agentId: "tester" });

      let err: unknown = null;
      try {
        await svc.approve(id, { agentId: "tester" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalError);
      expect(codeOf(err)).toBe("NOT_PENDING");
    } finally {
      await svc.stop();
    }
  });

  it("reject → rejected + event", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper" });
    await svc.start();
    try {
      const seen: FinanceEvent[] = [];
      bus.subscribeTo("trade.proposal_rejected", (e) => {
        seen.push(e);
      });

      const created = asRecord(
        await svc.propose({ symbol: "BTCUSDT", side: "buy", quantity: 0.1, price: 50000 }),
      );
      const id = String(created["id"]);
      await svc.reject(id, "no longer valid");

      const stored = asRecord(await svc.get(id));
      expect(stored["status"]).toBe("rejected");

      await waitFor(async () => seen.length >= 1);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(seen.map((e) => e.data))).toContain(id);
    } finally {
      await svc.stop();
    }
  });

  it("approve with NO_PIPELINE (no getPipeline) → NO_PIPELINE error", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper" });
    await svc.start();
    try {
      const created = asRecord(
        await svc.propose({ symbol: "BTCUSDT", side: "buy", quantity: 0.1, price: 50000 }),
      );
      const id = String(created["id"]);

      let err: unknown = null;
      try {
        await svc.approve(id, { agentId: "tester" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalError);
      expect(codeOf(err)).toBe("NO_PIPELINE");
    } finally {
      await svc.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Expiry
// ---------------------------------------------------------------------------

describe("ApprovalService expiry", () => {
  it("ttlMs 30 → wait → expired; approve → EXPIRED", async () => {
    const svc = new ApprovalService({ bus, executionMode: "paper", ttlMs: 30 });
    await svc.start();
    try {
      const created = asRecord(
        await svc.propose({
          symbol: "BTCUSDT",
          side: "buy",
          quantity: 0.1,
          price: 50000,
          ttlMs: 30,
        }),
      );
      const id = String(created["id"]);

      await sleep(60);
      await svc.sweep();

      let expiredSeen = false;
      try {
        const got = asRecord(await svc.get(id));
        expiredSeen = got["status"] === "expired";
      } catch (e) {
        // Some implementations throw EXPIRED on get after expiry — also acceptable.
        expiredSeen = codeOf(e) === "EXPIRED";
      }
      const pending = await svc.list("pending");
      const stillPending = pending.some((p) => asRecord(p)["id"] === id);
      expect(expiredSeen || !stillPending).toBe(true);

      // EXPIRED is checked before NO_PIPELINE, so the pipeline-less service
      // throws EXPIRED here as well.
      let err: unknown = null;
      try {
        await svc.approve(id, { agentId: "tester" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalError);
      expect(codeOf(err)).toBe("EXPIRED");
    } finally {
      await svc.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. stop() unsubscribes + Wrapper lifecycle
// ---------------------------------------------------------------------------

describe("ApprovalService stop + wrapper", () => {
  it("stop() unsubscribes (signal after stop → no proposal)", async () => {
    const svc = new ApprovalService({ bus, executionMode: "live" });
    await svc.start();
    await svc.stop();

    bus.publish({
      type: "quant.signal",
      data: {
        id: "sig-late",
        symbol: "BTCUSDT",
        action: "buy",
        side: "buy",
        price: 50000,
        confidence: 0.9,
        quantity: 0.05,
        qty: 0.05,
        reason: "late",
        strategy: "momentum",
      },
      source: "quant",
      correlationId: "corr-late",
    });
    await sleep(40);
    expect(await svc.list()).toHaveLength(0);
  });

  it("Wrapper lifecycle returns an ApprovalService", async () => {
    const wrapper = new ApprovalServiceWrapper({ bus });
    const instance = await wrapper.getInstance();
    expect(instance).toBeInstanceOf(ApprovalService);

    await wrapper.initialize();
    await wrapper.start();
    expect(await wrapper.getHealth()).toBeDefined();
    await wrapper.stop();
  });
});

// ---------------------------------------------------------------------------
// 6. Integration: trade.proposal_created → chat "Approval needed"
// ---------------------------------------------------------------------------

describe("Approvals × chat integration", () => {
  it("assistant posts 'Approval needed' + symbol for the plan thread", async () => {
    const storage = await makeStorage();
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async () => ({ planId: "plan-9" }),
    });
    await core.start();
    try {
      const thread = await core.createThread({ title: "approval flow" });
      const { planId } = await core.sendUserMessage(thread.id, "Buy BTC on breakout");
      expect(planId).toBe("plan-9");

      const symbol = "BTCUSDT";
      bus.publish({
        type: "trade.proposal_created",
        data: {
          proposal: {
            id: "prop-1",
            symbol,
            side: "buy",
            quantity: 0.05,
            price: 50000,
            reason: "breakout",
          },
        },
        source: "approvals",
        correlationId: "plan-9",
      });

      await waitFor(async () =>
        (await core.getMessages(thread.id)).some(
          (m) =>
            m.role === "assistant" &&
            m.content.includes("Approval needed") &&
            m.content.includes(symbol),
        ),
      );

      const messages = await core.getMessages(thread.id);
      expect(
        messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.includes("Approval needed") &&
            m.content.includes(symbol),
        ),
      ).toBe(true);
    } finally {
      await core.stop();
    }
  });
});
