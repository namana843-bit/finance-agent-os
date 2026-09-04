// ============================================================================
// Execution Pipeline Tests — Signal -> Risk -> Permission -> Paper -> Result
// Live disabled by default, audit logging, validation.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { RiskAgent } from "../src/agents/risk/index.js";
import { FinanceGateway } from "../src/gateway/finance-gateway.js";
import { PaperBroker } from "../src/broker/paper-broker.js";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import { validateSignal } from "../src/execution-pipeline/validation.js";
import { checkPermission } from "../src/execution-pipeline/permission.js";
import { PIPELINE_EVENTS } from "../src/execution-pipeline/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(opts: Partial<{
  bus: TypedEventBus;
  riskConfig: Record<string, unknown>;
  gatewayConfig: Record<string, unknown>;
  pipelineConfig: Record<string, unknown>;
}> = {}) {
  const bus = opts.bus ?? new TypedEventBus();
  const riskAgent = new RiskAgent(bus, opts.riskConfig as never);
  const gateway = new FinanceGateway(bus, { executionMode: "paper", liveTradingEnabled: false, ...opts.gatewayConfig } as never);
  const paperBroker = new PaperBroker(bus, { latencyMs: 0 } as never);
  const auditLogger = new AuditLogger(bus);
  // seed price for paper broker
  (paperBroker as unknown as { priceCache: Map<string, number> }).priceCache.set("BTCUSDT", 50000);
  (paperBroker as unknown as { priceCache: Map<string, number> }).priceCache.set("ETHUSDT", 3000);
  const pipeline = new ExecutionPipeline({ bus, riskAgent, gateway, paperBroker, auditLogger, config: opts.pipelineConfig as never });
  return { bus, riskAgent, gateway, paperBroker, auditLogger, pipeline };
}

const baseSignal = {
  symbol: "BTCUSDT",
  side: "buy" as const,
  quantity: 0.05,
  price: 50000,
  agentId: "test-agent",
  strategy: "momentum",
  confidence: 0.9,
};

// ===========================================================================
// Validation
// ===========================================================================

describe("Execution Pipeline — Validation", () => {
  it("validates correct signal", () => {
    const r = validateSignal({ ...baseSignal });
    expect(r.valid).toBe(true);
    expect(r.normalized?.symbol).toBe("BTCUSDT");
  });

  it("rejects missing symbol / side / quantity / price / agentId", () => {
    expect(validateSignal({ ...baseSignal, symbol: "" }).valid).toBe(false);
    expect(validateSignal({ ...baseSignal, side: "hold" as never }).valid).toBe(false);
    expect(validateSignal({ ...baseSignal, quantity: 0 }).valid).toBe(false);
    expect(validateSignal({ ...baseSignal, price: -1 }).valid).toBe(false);
    expect(validateSignal({ ...baseSignal, agentId: "" }).valid).toBe(false);
    expect(validateSignal(null).valid).toBe(false);
  });

  it("checkPermission respects allowedSymbols and limits", () => {
    const sig = { ...baseSignal, symbol: "BTCUSDT", quantity: 1, price: 50000, agentId: "a1" } as never;
    expect(checkPermission(sig, { canTrade: true, canSubmitOrders: true, maxOrderSize: 1000, maxDailyOrders: 10, allowedSymbols: [], allowedStrategies: [] }, 0).allowed).toBe(false);
    expect(checkPermission(sig, { canTrade: false, canSubmitOrders: true, maxOrderSize: 100000, maxDailyOrders: 10, allowedSymbols: [], allowedStrategies: [] }, 0).reason).toMatch(/not allowed to trade/);
    expect(checkPermission(sig, { canTrade: true, canSubmitOrders: true, maxOrderSize: 100000, maxDailyOrders: 10, allowedSymbols: ["ETHUSDT"], allowedStrategies: [] }, 0).reason).toMatch(/not in allowed list/);
    expect(checkPermission({ ...sig, strategy: "x" } as never, { canTrade: true, canSubmitOrders: true, maxOrderSize: 100000, maxDailyOrders: 10, allowedSymbols: [], allowedStrategies: ["y"] }, 0).reason).toMatch(/not allowed/);
    expect(checkPermission(sig, { canTrade: true, canSubmitOrders: true, maxOrderSize: 100000, maxDailyOrders: 1, allowedSymbols: [], allowedStrategies: [] }, 1).reason).toMatch(/Daily order limit/);
  });
});

// ===========================================================================
// Pipeline — Signal -> Risk -> Permission -> Paper -> Result
// ===========================================================================

describe("Execution Pipeline — Signal -> Risk -> Permission -> Paper -> Result", () => {
  it("happy path: validates -> risk passes -> permission ok -> paper executes -> Result", async () => {
    const { pipeline, bus } = makePipeline();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const res = await pipeline.execute({ ...baseSignal, correlationId: "c1", id: "s1" });
    expect(res.success).toBe(true);
    expect(res.stage).toBe("completed");
    expect(res.order?.status).toBe("filled");
    expect(res.riskDecision).toBeDefined();
    expect(res.auditIds.length).toBeGreaterThan(3);
    expect(res.correlationId).toBe("c1");
    expect(events).toEqual(expect.arrayContaining([PIPELINE_EVENTS.SIGNAL_RECEIVED, PIPELINE_EVENTS.VALIDATED, PIPELINE_EVENTS.RISK_CHECKED, PIPELINE_EVENTS.PERMISSION_CHECKED, PIPELINE_EVENTS.PAPER_EXECUTED, PIPELINE_EVENTS.COMPLETED]));
    // audit log persisted
    expect(pipeline.getAuditLog().size()).toBeGreaterThan(3);
    expect(pipeline.getAuditLog().getByCorrelationId("c1").length).toBeGreaterThan(0);
  });

  it("validation failure: missing symbol -> rejected at validation, audit logged, no paper order", async () => {
    const { pipeline, paperBroker } = makePipeline();
    const res = await pipeline.execute({ ...baseSignal, symbol: "" } as never);
    expect(res.success).toBe(false);
    expect(res.stage).toBe("validation");
    expect(res.order).toBeUndefined();
    expect(paperBroker.getOrderHistory().length).toBe(0);
    expect(pipeline.getAuditLog().list({ stage: "validation" }).length).toBeGreaterThan(0);
  });

  it("risk rejection: low confidence -> rejected at risk stage", async () => {
    const { pipeline } = makePipeline({ riskConfig: { confidenceThreshold: 0.95 } });
    const res = await pipeline.execute({ ...baseSignal, confidence: 0.1, correlationId: "c-risk" });
    expect(res.success).toBe(false);
    expect(res.stage).toBe("risk");
    expect(res.reason).toMatch(/confidence|Rejected/i);
    expect(res.riskDecision).toBeDefined();
  });

  it("permission denied: agent not allowed to trade -> rejected at permission stage (after risk)", async () => {
    const { pipeline, gateway } = makePipeline();
    gateway.setAgentPermissions("test-agent", { canTrade: false } as never);
    const res = await pipeline.execute({ ...baseSignal, correlationId: "c-perm" });
    expect(res.success).toBe(false);
    expect(res.stage).toBe("permission");
    expect(res.reason).toMatch(/not allowed to trade/);
    // ensure risk was checked before permission (audit order: validation -> risk -> permission)
    const audits = pipeline.getAuditLog().getByCorrelationId("c-perm");
    const stages = audits.map((a) => a.stage);
    expect(stages.indexOf("validation") < stages.indexOf("risk")).toBe(true);
    expect(stages.indexOf("risk") < stages.indexOf("permission")).toBe(true);
  });

  it("permission denied: daily limit", async () => {
    const { pipeline, gateway } = makePipeline();
    gateway.setAgentPermissions("test-agent", { maxDailyOrders: 1 } as never);
    const r1 = await pipeline.execute({ ...baseSignal, correlationId: "c-daily-1" });
    expect(r1.success).toBe(true);
    const r2 = await pipeline.execute({ ...baseSignal, correlationId: "c-daily-2" });
    expect(r2.success).toBe(false);
    expect(r2.stage).toBe("permission");
    expect(r2.reason).toMatch(/Daily order limit/);
  });

  it("paper failure: insufficient position on sell -> rejected at paper stage", async () => {
    const { pipeline } = makePipeline();
    // no prior buy, so sell should be rejected by PaperBroker
    const res = await pipeline.execute({ ...baseSignal, side: "sell", correlationId: "c-paper-fail" });
    expect(res.success).toBe(false);
    expect(res.stage).toBe("paper");
  });

  it("live trading disabled by default", async () => {
    const { pipeline } = makePipeline();
    expect(pipeline.isLiveEnabled()).toBe(false);
    expect(pipeline.getConfig().liveTradingEnabled).toBe(false);
  });

  it("enableLiveTrading requires LIVE_TRADING_ENABLED=true", async () => {
    const { pipeline } = makePipeline();
    const prev = process.env.LIVE_TRADING_ENABLED;
    delete process.env.LIVE_TRADING_ENABLED;
    expect(() => pipeline.enableLiveTrading()).toThrow(/LIVE_TRADING_ENABLED/);
    // now allow
    process.env.LIVE_TRADING_ENABLED = "true";
    pipeline.enableLiveTrading();
    expect(pipeline.isLiveEnabled()).toBe(true);
    pipeline.disableLiveTrading();
    expect(pipeline.isLiveEnabled()).toBe(false);
    // restore
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  });

  it("audit logging: every execution produces audit entries with correlationId", async () => {
    const { pipeline } = makePipeline();
    const res = await pipeline.execute({ ...baseSignal, correlationId: "c-audit" });
    const entries = pipeline.getAuditLog().getByCorrelationId("c-audit");
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const e of entries) {
      expect(e.correlationId).toBe("c-audit");
      expect(e.signalId).toBe(res.signalId);
    }
  });

  it("runtime integration: execution-pipeline service registered", async () => {
    const { createRuntime, getExecutionPipeline } = await import("../src/core/runtime.js");
    const rt = createRuntime();
    const svc = rt.getService("execution-pipeline" as unknown as string) as unknown as { getInstance: () => ExecutionPipeline } | undefined;
    expect(svc).toBeDefined();
    const pipe = getExecutionPipeline();
    expect(pipe?.id).toBe("execution-pipeline");
    expect(pipe?.isLiveEnabled()).toBe(false);
  });

  it("resetDailyCounts allows new orders", async () => {
    const { pipeline, gateway } = makePipeline();
    gateway.setAgentPermissions("test-agent", { maxDailyOrders: 1 } as never);
    await pipeline.execute({ ...baseSignal, correlationId: "c-reset-1" });
    const blocked = await pipeline.execute({ ...baseSignal, correlationId: "c-reset-2" });
    expect(blocked.success).toBe(false);
    pipeline.resetDailyCounts();
    const ok = await pipeline.execute({ ...baseSignal, correlationId: "c-reset-3" });
    expect(ok.success).toBe(true);
  });
});
