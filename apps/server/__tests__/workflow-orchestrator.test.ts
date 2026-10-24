// ============================================================================
// Trade Workflow Orchestrator — deterministic integration tests
// Proves the coordinated workflow:
//   Research -> Proposal -> Risk Review -> User Approval -> Paper Execution ->
//   Portfolio Update -> Audit Record
// with stub agents (no network), the real proposal validation, approval
// matching, freshness recheck, rejection gates, and restart recovery.
// No live broker is touched — the pipeline is stubbed, asserting the exact
// signal it receives (which is what the real pipeline would re-gate).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradeWorkflowOrchestrator, type AgentRunner, type PipelineRunner } from "../src/orchestrator/orchestrator.js";
import { WorkflowStore } from "../src/orchestrator/store.js";
import { validateProposal } from "../src/orchestrator/types.js";

const PROPOSAL_JSON = JSON.stringify({
  symbol: "BTCUSDT",
  side: "buy",
  quantity: 0.5,
  price: 64000,
  type: "market",
  rationale: "Momentum setup with tight invalidation",
  assumptions: "Nilled",
});
const RISK_JSON = JSON.stringify({ verdict: "ok", concerns: [], notes: "sized reasonably" });

function fixedRunner(): AgentRunner {
  return {
    runAgent: async (agentId) => {
      if (agentId === "market-research-agent") return "Research brief (stub).";
      if (agentId === "btc-quant-agent") return PROPOSAL_JSON;
      if (agentId === "risk-guardian-agent") return RISK_JSON;
      throw new Error("unexpected agent " + agentId);
    },
  };
}

function recordingPipeline(): { runner: PipelineRunner; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    runner: {
      execute: async (signal) => {
        calls.push(signal);
        return {
          success: true,
          stage: "completed",
          reason: "paper order executed",
          correlationId: "corr-1",
          signalId: "sig-1",
          order: { status: "filled", quantity: 0.5, filledPrice: 64001, fee: 0.064001 },
          auditIds: ["a1"],
        };
      },
    },
  };
}

describe("TradeWorkflowOrchestrator", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-orch-"));
  });
  afterEach(async () => { /* temp dir cleanup by OS test harness */ });

  it("runs research -> proposal -> risk -> awaiting_approval with all structured outputs", async () => {
    const orch = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: recordingPipeline().runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "btcusdt" });
    expect(run.status).toBe("awaiting_approval");
    expect(run.stage).toBe("awaiting_approval");
    expect(run.proposal).toMatchObject({ symbol: "BTCUSDT", side: "buy", quantity: 0.5, price: 64000, type: "market" });
    expect(run.riskReview).toMatchObject({ agentId: "risk-guardian-agent", verdict: "ok" });
    expect(run.agents.map((a) => a.stage)).toEqual(["research", "proposal", "risk_review"]);
    expect(run.agents.every((a) => a.ok && a.agentId)).toBe(true);
  });

  it("fails when the quant agent returns unparseable or invalid proposals", async () => {
    const bad: AgentRunner = { ...fixedRunner(), runAgent: async (id) => (id === "btc-quant-agent" ? "I suggest buying some bitcoin." : fixedRunner().runAgent(id)) };
    const runner = recordingPipeline();
    const orch = new TradeWorkflowOrchestrator({ agentRunner: bad, pipeline: runner.runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("validation");
    expect(run.proposal).toBeUndefined();
    expect(await readFilePersistence(dir, run.id)).not.toBeNull();
    expect(runner.calls).toHaveLength(0); // nothing ever reached the pipeline
  });

  it("rejects an approval that does not echo the exact proposal params", async () => {
    const orch = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: recordingPipeline().runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    const amp = await orch.approve(run.id, { symbol: "BTCUSDT", side: "buy", quantity: 999 });
    expect(amp?.execution).toBeUndefined();
    expect(amp?.approval).toBeUndefined();
    expect(amp?.error).toContain("did not match");
  });

  it("blocks approval on stale market data before any execution", async () => {
    let freshness: Record<string, number> = { BTCUSDT: Date.now() };
    const orch = new TradeWorkflowOrchestrator({
      agentRunner: fixedRunner(),
      pipeline: recordingPipeline().runner,
      store: new WorkflowStore(dir),
      maxDataAgeMs: 10_000,
      freshness: { getLastUpdate: (s) => freshness[s] },
    });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    freshness = {}; // data vanished between proposal and approval
    const afterAwait = await orch.approve(run.id, { symbol: "BTCUSDT", side: "buy", quantity: 0.5 });
    expect(afterAwait?.status).toBe("failed");
    expect(afterAwait?.error).toContain("missing");
  });

  it("full happy path: exact approval routes the validated signal through the pipeline and records portfolio + audit", async () => {
    const { runner, calls } = recordingPipeline();
    const brokerState = { equity: 100_000, cash: 96_800, positions: [{ symbol: "BTCUSDT", quantity: 0.5 }] };
    const orch = new TradeWorkflowOrchestrator({
      agentRunner: fixedRunner(),
      pipeline: runner,
      store: new WorkflowStore(dir),
      freshness: { getLastUpdate: () => Date.now() },
      portfolio: { snapshot: () => brokerState },
    });
    const run1 = await orch.startRun({ symbol: "BTCUSDT" });
    const done = await orch.approve(run1.id, { symbol: "BTCUSDT", side: "buy", quantity: 0.5 });
    expect(done?.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ symbol: "BTCUSDT", side: "buy", quantity: 0.5, price: 64000, strategy: "orchestrator-workflow" });
    expect(done?.execution).toMatchObject({ success: true, filledPrice: 64001, fee: 0.064001 });
    expect(done?.portfolioAfter).toMatchObject({ equity: 100_000 });
    expect(done?.approval).toMatchObject({ decision: "approved", confirmed: { symbol: "BTCUSDT", side: "buy", quantity: 0.5 } });
    expect(done?.auditIds).toContain("a1");
    // second approve attempt is not possible (status no longer awaiting)
    const again = await orch.approve(run1.id, { symbol: "BTCUSDT", side: "buy", quantity: 0.5 });
    expect(again?.status).toBe("completed");
    expect(calls).toHaveLength(1); // idempotent — no second execution
  });

  it("user rejection records an auditable decision without touching the pipeline", async () => {
    const { runner, calls } = recordingPipeline();
    const orch = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    const rejected = await orch.reject(run.id, "Sizing too large for my taste");
    expect(rejected?.status).toBe("user_rejected");
    expect(rejected?.approval).toMatchObject({ decision: "rejected", reason: "Sizing too large for my taste" });
    expect(rejected?.auditIds.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it("requires a rejection reason", async () => {
    const orch = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: recordingPipeline().runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    const res = await orch.reject(run.id, "   ");
    expect(res?.status).toBe("awaiting_approval");
  });

  it("risk guardian's 'block' verdict fails the run before approval", async () => {
    const blocker: AgentRunner = {
      ...fixedRunner(),
      runAgent: async (id) => (id === "risk-guardian-agent"
        ? JSON.stringify({ verdict: "block", concerns: ["concentration too high"] })
        : fixedRunner().runAgent(id)),
    };
    const { runner, calls } = recordingPipeline();
    const orch = new TradeWorkflowOrchestrator({ agentRunner: blocker, pipeline: runner, store: new WorkflowStore(dir) });
    const run = await orch.startRun({ symbol: "BTCUSDT" });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Risk Guardian blocked");
    expect(calls).toHaveLength(0);
  });

  it("proposal validation rejects well-known bad shapes", () => {
    expect(validateProposal({ symbol: "B когда-нибудь", side: "buy", quantity: 1, price: 1, rationale: "1234567890" }).valid).toBe(false);
    expect(validateProposal({ symbol: "BTCUSDT", side: "_BSOD_fake", quantity: 1, price: 1, rationale: "1234567890" }).valid).toBe(false);
    expect(validateProposal({ symbol: "BTCUSDT", side: "buy", quantity: -1, price: 1, rationale: "1234567890" }).valid).toBe(false);
    expect(validateProposal({ symbol: "BTCUSDT", side: "buy", quantity: 1, price: 0, rationale: "1234567890" }).valid).toBe(false);
    expect(validateProposal({ symbol: "BTCUSDT", side: "buy", quantity: 1, price: 1, rationale: "too short" }).valid).toBe(false);
    const ok = validateProposal({ symbol: "BTCUSDT", side: "sell", quantity: 1.5, price: 64000.1234567891, rationale: "legit plan", type: undefined });
    expect(ok.valid).toBe(true);
    expect(ok.proposal?.type).toBe("market");
  });

  it("persists runs so a restarted orchestrator recovers finished history, never resuming an unapproved running run", async () => {
    const store = new WorkflowStore(dir);
    const { runner } = recordingPipeline();
    const orchA = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: runner, store });
    const awaiting = await orchA.startRun({ symbol: "BTCUSDT" });
    const approved = await orchA.approve(awaiting.id, { symbol: "BTCUSDT", side: "buy", quantity: 0.5 });
    expect(approved?.status).toBe("completed");

    // Fresh orchestrator (server restart) hydrates from disk.
    const stallRunner: AgentRunner = { runAgent: async () => { await new Promise(() => {}); return ""; } };
    const orchB = new TradeWorkflowOrchestrator({ agentRunner: stallRunner, pipeline: runner, store });
    await orchB.recoverAfterRestart();
    expect(orchB.get(approved!.id)?.status).toBe("completed");

    // A running (crashed pre-approval) run must be marked failed on recovery.
    const halfRun = { ...approved!, id: "wf-crashed", status: "running" as const, updatedAt: new Date().toISOString() };
    await store.saveRun(halfRun);
    const orchC = new TradeWorkflowOrchestrator({ agentRunner: fixedRunner(), pipeline: runner, store });
    await orchC.recoverAfterRestart();
    const recovered = orchC.get("wf-crashed");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toContain("restart");
  });
});

async function readFilePersistence(dir: string, id: string): Promise<string | null> {
  try {
    return await readFile(join(dir, `${id}.json`), "utf-8");
  } catch {
    return null;
  }
}
