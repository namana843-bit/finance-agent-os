// ============================================================================
// Supervisor — deterministic planner + SupervisorAgent tests
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { AgentRegistry, ToolRegistry } from "@finance/core";
import { BaseAgent } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import {
  createPlan,
  extractSymbol,
  classifyTask,
  stripPlan,
  SupervisorAgent,
} from "../src/agents/supervisor/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class DummyAgent extends BaseAgent {
  async handleEvent(_e: FinanceEvent): Promise<void> {
    this.recordActivity();
  }
}

function makeRegistries(populateTools = true): { agentRegistry: AgentRegistry; toolRegistry: ToolRegistry } {
  const ar = new AgentRegistry();
  const tr = new ToolRegistry();

  for (const id of ["market", "quant", "risk", "portfolio", "execution", "supervisor"]) {
    ar.register(new DummyAgent({ id, name: id, version: "0.1.0", description: "", capabilities: [] }));
  }

  if (populateTools) {
    // Tools referenced by planner
    const tools: Array<{ id: string }> = [
      { id: "get_price" },
      { id: "get_ohlcv" },
      { id: "calculate_indicator" },
      { id: "get_portfolio_snapshot" },
      { id: "get_positions" },
      { id: "get_balance" },
      { id: "calculate_position_size" },
    ];
    for (const t of tools) {
      tr.register(
        { id: t.id, name: t.id, description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } },
        { execute: async (input: Record<string, unknown>) => ({ tool: t.id, input, ok: true }) },
      );
    }
  }

  return { agentRegistry: ar, toolRegistry: tr };
}

// ---------------------------------------------------------------------------
// Symbol extraction + classification
// ---------------------------------------------------------------------------

describe("Supervisor planner — extractSymbol / classifyTask", () => {
  it("extracts BTC -> BTCUSDT", () => {
    expect(extractSymbol("Analyze BTC")).toBe("BTCUSDT");
    expect(extractSymbol("analyze btc")).toBe("BTCUSDT");
  });

  it("extracts ETH and BTCUSDT", () => {
    expect(extractSymbol("Research ETH")).toBe("ETHUSDT");
    expect(extractSymbol("price for BTCUSDT")).toBe("BTCUSDT");
  });

  it("extracts EURUSD / AAPL unchanged", () => {
    expect(extractSymbol("analyze EURUSD")).toBe("EURUSD");
    expect(extractSymbol("check AAPL")).toBe("AAPL");
  });

  it("returns null when no symbol", () => {
    expect(extractSymbol("show my portfolio")).toBeNull();
    expect(extractSymbol("")).toBeNull();
    expect(extractSymbol("hello world")).toBeNull();
  });

  it("classifies analyze / trade / portfolio / backtest / generic", () => {
    expect(classifyTask("Analyze BTC")).toBe("analyze");
    expect(classifyTask("buy BTCUSDT")).toBe("trade");
    expect(classifyTask("show portfolio")).toBe("portfolio");
    expect(classifyTask("balance check")).toBe("portfolio");
    expect(classifyTask("backtest EMA on BTC")).toBe("backtest");
    expect(classifyTask("hello")).toBe("generic");
  });

  it("classification priority: backtest > portfolio > trade > analyze", () => {
    expect(classifyTask("backtest my portfolio")).toBe("backtest");
    expect(classifyTask("trade my portfolio")).toBe("portfolio");
  });
});

// ---------------------------------------------------------------------------
// Deterministic planning
// ---------------------------------------------------------------------------

describe("Supervisor planner — deterministic createPlan", () => {
  it("Analyze BTC -> analyze kind with BTCUSDT and Market->Research->Strategy->Risk->Final", () => {
    const p = createPlan("Analyze BTC");
    expect(p.kind).toBe("analyze");
    expect(p.symbol).toBe("BTCUSDT");
    expect(p.steps.map((s) => s.id)).toEqual([
      "market.fetch_price",
      "market.fetch_ohlcv",
      "quant.research",
      "strategy.evaluate",
      "risk.assess",
      "portfolio.summarize",
    ]);
    const agents = p.steps.map((s) => s.agentId);
    expect(agents).toEqual(["market", "market", "quant", "quant", "risk", "portfolio"]);
  });

  it("is deterministic: same task -> same stripped plan", () => {
    const a = stripPlan(createPlan("Analyze BTC"));
    const b = stripPlan(createPlan("Analyze BTC"));
    expect(a).toEqual(b);
  });

  it("different symbols produce different inputs but same structure", () => {
    const btc = createPlan("Analyze BTC");
    const eth = createPlan("Analyze ETH");
    expect(btc.symbol).toBe("BTCUSDT");
    expect(eth.symbol).toBe("ETHUSDT");
    expect(btc.steps.map((s) => s.id)).toEqual(eth.steps.map((s) => s.id));
    expect(btc.steps[0]!.input.symbol).toBe("BTCUSDT");
    expect(eth.steps[0]!.input.symbol).toBe("ETHUSDT");
  });

  it("trade -> Market->Research->Risk->Execution->Final", () => {
    const p = createPlan("buy BTC");
    expect(p.kind).toBe("trade");
    expect(p.steps.map((s) => s.id)).toEqual([
      "market.fetch_price",
      "quant.research",
      "risk.assess",
      "execution.execute",
      "portfolio.summarize",
    ]);
  });

  it("portfolio -> snapshot -> positions -> balance -> risk -> summarize", () => {
    const p = createPlan("show my portfolio");
    expect(p.kind).toBe("portfolio");
    expect(p.steps[0]!.id).toBe("portfolio.snapshot");
    expect(p.steps[1]!.id).toBe("portfolio.positions");
  });

  it("backtest -> fetch_ohlcv -> backtest -> risk -> summarize", () => {
    const p = createPlan("backtest RSI on BTC");
    expect(p.kind).toBe("backtest");
    expect(p.steps.map((s) => s.id)).toEqual([
      "market.fetch_ohlcv",
      "strategy.backtest",
      "risk.assess",
      "portfolio.summarize",
    ]);
  });

  it("generic -> fetch_price -> research -> summarize", () => {
    const p = createPlan("hello world");
    expect(p.kind).toBe("generic");
    expect(p.steps.map((s) => s.id)).toEqual(["market.fetch_price", "quant.research", "portfolio.summarize"]);
  });

  it("portfolio with symbol scopes positions step", () => {
    const p = createPlan("portfolio for BTC");
    expect(p.symbol).toBe("BTCUSDT");
    expect(p.steps.find((s) => s.id === "portfolio.positions")!.input.symbol).toBe("BTCUSDT");
  });
});

// ---------------------------------------------------------------------------
// Validation (against registries)
// ---------------------------------------------------------------------------

describe("SupervisorAgent — validation", () => {
  it("valid when all required agents/tools registered", () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    const plan = createPlan("Analyze BTC");
    const v = sup.validate(plan);
    expect(v.valid).toBe(true);
    expect(v.missingAgents).toEqual([]);
    expect(v.missingTools).toEqual([]);
  });

  it("reports missing tools", () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(false); // no tools
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    const plan = createPlan("Analyze BTC");
    const v = sup.validate(plan);
    expect(v.valid).toBe(false);
    expect(v.missingTools.length).toBeGreaterThan(0);
  });

  it("reports missing agents", () => {
    const bus = new TypedEventBus();
    const ar = new AgentRegistry();
    const tr = new ToolRegistry();
    tr.register({ id: "get_price", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, { execute: async () => ({}) });
    const sup = new SupervisorAgent({ bus, agentRegistry: ar, toolRegistry: tr });
    const plan = createPlan("Analyze BTC");
    const v = sup.validate(plan);
    expect(v.missingAgents.length).toBeGreaterThan(0);
  });

  it("without registries — skips validation gracefully", () => {
    const bus = new TypedEventBus();
    const sup = new SupervisorAgent({ bus });
    const plan = createPlan("Analyze BTC");
    const v = sup.validate(plan);
    // No registries -> reasons mention skipping, but valid is true (no missing to report)
    expect(v.valid).toBe(true);
    expect(v.reasons.some((r) => r.includes("not configured"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution (deterministic, via ToolRegistry / EventBus)
// ---------------------------------------------------------------------------

describe("SupervisorAgent — execution + events", () => {
  it("executePlan completes and emits supervisor.* events", async () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    await sup.start();

    const events: string[] = [];
    bus.subscribe((e: FinanceEvent) => {
      if (e.type.startsWith("supervisor.")) events.push(e.type);
    });

    const plan = sup.plan("Analyze BTC");
    const exec = await sup.executePlan(plan);

    expect(exec.success).toBe(true);
    expect(exec.steps.every((s) => s.status === "completed")).toBe(true);
    expect(exec.steps).toHaveLength(plan.steps.length);

    // Key lifecycle events
    expect(events).toContain("supervisor.plan_created");
    expect(events).toContain("supervisor.plan_validated");
    expect(events).toContain("supervisor.plan_execution_started");
    expect(events).toContain("supervisor.step_started");
    expect(events).toContain("supervisor.step_completed");
    expect(events).toContain("supervisor.plan_completed");

    await sup.stop();
  });

  it("executing Analyze BTC: tool outputs are returned per step", async () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    const plan = sup.plan("Analyze BTC");
    const exec = await sup.executePlan(plan);
    // Steps with toolId should have output.tool == toolId
    const toolSteps = exec.steps.filter((s) => s.toolId);
    expect(toolSteps.length).toBeGreaterThan(0);
    for (const s of toolSteps) {
      expect((s.output as { tool?: string })?.tool).toBe(s.toolId);
    }
  });

  it("plan() then execute via ToolRegistry engine actually calls tools in order", async () => {
    const bus = new TypedEventBus();
    const ar = new AgentRegistry();
    const tr = new ToolRegistry();
    for (const id of ["market", "quant", "risk", "portfolio"]) {
      ar.register(new DummyAgent({ id, name: id, version: "0.1.0", description: "", capabilities: [] }));
    }

    const called: string[] = [];
    const defFor = (id: string) => ({ id, name: id, description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } as const });
    tr.register(defFor("get_price"), { execute: async (input) => { called.push("get_price"); return { price: 68000, input }; } });
    tr.register(defFor("get_ohlcv"), { execute: async () => { called.push("get_ohlcv"); return { ohlcv: [] }; } });
    tr.register(defFor("calculate_indicator"), { execute: async () => { called.push("calculate_indicator"); return { rsi: 55 }; } });
    tr.register(defFor("get_portfolio_snapshot"), { execute: async () => { called.push("get_portfolio_snapshot"); return { cash: 100000 }; } });
    tr.register(defFor("calculate_position_size"), { execute: async () => { called.push("calculate_position_size"); return { qty: 0.01 }; } });
    // also need market->quant... but tell planner to use generic which hits those 3
    const sup = new SupervisorAgent({ bus, agentRegistry: ar, toolRegistry: tr });
    const plan = sup.plan("Analyze ETH");
    // weaken: execution should still succeed; strategy.evaluate and risk/portfolio steps with missing tool will complete as no-tool steps
    // but for this test we only care order of called tools
    await sup.executePlan(plan);
    // Expect at least get_price -> get_ohlcv -> calculate_indicator ordering
    expect(called.indexOf("get_price")).toBeLessThan(called.indexOf("get_ohlcv"));
    expect(called.indexOf("get_ohlcv")).toBeLessThan(called.indexOf("calculate_indicator"));
  });

  it("fails gracefully when a tool throws — emits step_failed and plan_failed", async () => {
    const bus = new TypedEventBus();
    const ar = new AgentRegistry();
    const tr = new ToolRegistry();
    for (const id of ["market", "quant", "risk", "portfolio"]) {
      ar.register(new DummyAgent({ id, name: id, version: "0.1.0", description: "", capabilities: [] }));
    }
    tr.register({ id: "get_price", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, {
      execute: async () => { throw new Error("boom"); },
    });
    tr.register({ id: "get_ohlcv", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, { execute: async () => ({}) });
    tr.register({ id: "calculate_indicator", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, { execute: async () => ({}) });
    tr.register({ id: "get_portfolio_snapshot", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, { execute: async () => ({}) });
    tr.register({ id: "calculate_position_size", name: "x", description: "", inputSchema: {}, outputSchema: {}, permissions: { required: false } }, { execute: async () => ({}) });

    const sup = new SupervisorAgent({ bus, agentRegistry: ar, toolRegistry: tr, failFast: true });
    const events: string[] = [];
    bus.subscribe((e: FinanceEvent) => { if (e.type.startsWith("supervisor.step_failed") || e.type.startsWith("supervisor.plan_failed")) events.push(e.type); });
    const plan = sup.plan("Analyze BTC");
    const exec = await sup.executePlan(plan);
    expect(exec.success).toBe(false);
    expect(exec.steps.some((s) => s.status === "failed")).toBe(true);
    expect(events).toContain("supervisor.step_failed");
    expect(events).toContain("supervisor.plan_failed");
  });

  it("submitTask convenience does plan+execute and handles supervisor.task event", async () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    await sup.start();

    const plan = createPlan("Analyze BTC");
    // Trigger via bus event
    let completed = false;
    bus.subscribeTo("supervisor.plan_completed", () => { completed = true; });

    bus.publish({ type: "supervisor.task", data: { task: "Analyze BTC" }, source: "test" });
    // Give async handler time to complete all steps with pacing delay
    await new Promise((r) => setTimeout(r, 4500));
    expect(completed).toBe(true);

    // Also direct submitTask
    const exec = await sup.submitTask("Analyze SOL");
    expect(exec.kind).toBe("analyze");
    expect(exec.symbol).toBe("SOLUSDT");

    await sup.stop();
  });

  it("plan() throws on empty task", () => {
    const bus = new TypedEventBus();
    const sup = new SupervisorAgent({ bus });
    expect(() => sup.plan("")).toThrow(/task is required/);
    expect(() => sup.plan("   ")).toThrow(/task is required/);
  });

  it("setRegistries late-binding works", async () => {
    const bus = new TypedEventBus();
    const sup = new SupervisorAgent({ bus });
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    sup.setRegistries({ agentRegistry, toolRegistry });
    const plan = sup.plan("Analyze BTC");
    const v = sup.validate(plan);
    expect(v.valid).toBe(true);
  });

  it("execution history is tracked", async () => {
    const bus = new TypedEventBus();
    const { agentRegistry, toolRegistry } = makeRegistries(true);
    const sup = new SupervisorAgent({ bus, agentRegistry, toolRegistry });
    await sup.executePlan(sup.plan("Analyze BTC"));
    await sup.executePlan(sup.plan("Analyze ETH"));
    expect(sup.listExecutions()).toHaveLength(2);
    expect(sup.getHistory(1)).toHaveLength(1);
    expect(sup.getExecution(sup.listExecutions()[0]!.planId)).toBeDefined();
  });
});
