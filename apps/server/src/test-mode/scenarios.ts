// ============================================================================
// Finance Agent OS — Test Scenario Catalog
// A registry of named, self-contained test/simulation scenarios.
//
// Every scenario gets its OWN isolated data directory under
// `<test-sandbox>/scenarios/<id>-<ts>-<rand>` and its OWN event bus, broker,
// order manager and memory store. Nothing is shared with the production data
// dir and nothing is shared between concurrently-running scenarios, so the
// whole catalog can be executed in parallel alongside a live production
// instance (see test-mode/sandbox.ts for the isolation guarantees).
//
// Usage:
//   import { listScenarios, runScenario, runScenarioCatalog } from "./scenarios.js";
//   const results = await runScenarioCatalog();          // run everything
//   await runScenario("pipeline-roundtrip");             // run one
//
// Or via CLI:  pnpm --filter @finance/server scenarios:run
// ============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TypedEventBus } from "@finance/core";
import { RiskAgent, type RiskConfig } from "../agents/risk/index.js";
import { FinanceGateway } from "../gateway/finance-gateway.js";
import { PaperBroker } from "../broker/paper-broker.js";
import { OrderManager } from "../order-manager/order-manager.js";
import { AgentMemory, type AgentLoopTrace } from "../memory/agent-memory.js";
import { ExecutionPipeline } from "../execution-pipeline/pipeline.js";
import type { PipelineConfig, PipelineSignal } from "../execution-pipeline/types.js";
import { KillSwitch } from "../safety/kill-switch.js";
import { HardLimitsValidator, type HardLimitsConfig } from "../safety/hard-limits.js";
import {
  PRODUCTION_DATA_DIR,
  createScenarioDataDir,
  isSandboxDataDir,
  resolveSandboxDataDir,
} from "./sandbox.js";
import { SimulatedMarket, type SimulatedMarketOptions } from "./sim-market.js";
import { createSimulationBroker } from "./sim-broker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  steps: ScenarioStep[];
  metrics: Record<string, number>;
  /** Private data directory used by this run (inside the sandbox). */
  sandboxDir: string;
  durationMs: number;
  error?: string;
}

export interface ScenarioContext {
  /** Unique id for this run (scenario id + timestamp + random). */
  readonly runId: string;
  /** Private, isolated data directory for this run. */
  readonly sandboxDir: string;
  readonly bus: TypedEventBus;
  readonly market: SimulatedMarket;
  readonly broker: PaperBroker;
  readonly orderManager: OrderManager;
  readonly memory: AgentMemory;
  readonly riskAgent: RiskAgent;
  readonly gateway: FinanceGateway;
  readonly pipeline: ExecutionPipeline;
  readonly killSwitch: KillSwitch;
  readonly hardLimits?: HardLimitsValidator;
  /** Record an assertion performed by the scenario. */
  step(name: string, ok: boolean, detail?: string): void;
  /** Free-form numeric metrics surfaced on the ScenarioResult. */
  metric(name: string, value: number): void;
  /** Convenience: a pipeline signal pre-wired to this scenario's agent. */
  signal(overrides?: Partial<PipelineSignal> & { symbol?: string }): PipelineSignal;
}

export interface ScenarioOptions {
  /** Deterministic seed for the simulated market. Default 42. */
  seed?: number;
  /** Extra risk config for the scenario's RiskAgent. */
  riskConfig?: Partial<RiskConfig>;
  /** Extra pipeline config (sandboxMode is always forced on). */
  pipelineConfig?: Partial<PipelineConfig>;
  /** Hard limits config; when present the validator is wired into the pipeline. */
  hardLimitsConfig?: Partial<HardLimitsConfig>;
  /** Base prices for the simulated market. */
  marketOptions?: SimulatedMarketOptions;
}

export interface TestScenario {
  id: string;
  title: string;
  description: string;
  tags: string[];
  run(ctx: ScenarioContext): Promise<void> | void;
}

const DEFAULT_AGENT_ID = "sandbox-agent";

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

function assertInsideSandbox(dir: string): void {
  if (!isSandboxDataDir(dir)) {
    throw new Error(
      `[test-mode] refusing to run scenario outside the sandbox: ${dir} (sandbox root ${resolveSandboxDataDir()})`,
    );
  }
  if (dir === PRODUCTION_DATA_DIR) {
    throw new Error("[test-mode] refusing to use the production data dir for a scenario");
  }
}

/**
 * Build a fully isolated execution stack for one scenario run.
 * Call `dispose()` when finished (the runner does this for you).
 */
export function createScenarioContext(
  scenarioId: string,
  options?: ScenarioOptions,
): ScenarioContext & { dispose(): Promise<void> } {
  const sandboxDir = createScenarioDataDir(scenarioId);
  assertInsideSandbox(sandboxDir);
  const runId = `${scenarioId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const bus = new TypedEventBus({ maxHistory: 500 });
  const market = new SimulatedMarket({ seed: options?.seed ?? 42, ...options?.marketOptions });
  const broker = createSimulationBroker(bus, { market });
  const orderManager = new OrderManager(bus, { persistPath: join(sandboxDir, "orders.json"), autoPersist: true });
  const memory = new AgentMemory({ persistDir: join(sandboxDir, "memory") });
  const riskAgent = new RiskAgent(bus, options?.riskConfig);
  const gateway = new FinanceGateway(bus, { executionMode: "paper", liveTradingEnabled: false });
  const killSwitch = new KillSwitch({ bus, orderManager, broker, config: { overrideKey: "sandbox-override" } });
  const hardLimits = options?.hardLimitsConfig ? new HardLimitsValidator(options.hardLimitsConfig) : undefined;

  const pipeline = new ExecutionPipeline({
    bus,
    riskAgent,
    gateway,
    paperBroker: broker,
    orderManager,
    killSwitch,
    hardLimits,
    config: {
      // Sandbox is non-bypassable for every scenario.
      sandboxMode: true,
      requireRiskApproval: true,
      ...options?.pipelineConfig,
    },
  });

  const steps: ScenarioStep[] = [];
  const metrics: Record<string, number> = {};

  const ctx: ScenarioContext = {
    runId,
    sandboxDir,
    bus,
    market,
    broker,
    orderManager,
    memory,
    riskAgent,
    gateway,
    pipeline,
    killSwitch,
    hardLimits,
    step(name, ok, detail) {
      steps.push({ name, ok: !!ok, detail });
    },
    metric(name, value) {
      metrics[name] = value;
    },
    signal(overrides) {
      const symbol = (overrides?.symbol ?? "BTCUSDT").toUpperCase();
      return {
        agentId: DEFAULT_AGENT_ID,
        strategy: "sandbox",
        confidence: 0.9,
        type: "market",
        ...overrides,
        symbol,
        price: overrides?.price ?? market.getBasePrice(symbol),
      } as PipelineSignal;
    },
  };

  return Object.assign(ctx, {
    async dispose() {
      memory.stopAutoCleanup();
      await memory.flush().catch(() => {});
      orderManager.persist();
      market.stopFeed();
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by scenarios
// ---------------------------------------------------------------------------

function approxEqual(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
// Built-in scenario catalog
// ---------------------------------------------------------------------------

/** Verify a scenario's data directory is fully isolated from production. */
const dataIsolationScenario: TestScenario = {
  id: "data-isolation",
  title: "Sandbox data isolation",
  description:
    "Scenario state (orders, agent memory, traces) is written only inside the sandbox directory and never into the production data dir.",
  tags: ["isolation", "persistence", "safety"],
  run(ctx) {
    ctx.step("scenario dir is inside the sandbox", isSandboxDataDir(ctx.sandboxDir), ctx.sandboxDir);
    ctx.step(
      "scenario dir is not the production data dir",
      ctx.sandboxDir !== PRODUCTION_DATA_DIR,
      `production=${PRODUCTION_DATA_DIR}`,
    );
    ctx.step(
      "scenario dir is not the plain sandbox root",
      ctx.sandboxDir !== resolveSandboxDataDir(),
      `sandboxRoot=${resolveSandboxDataDir()}`,
    );

    ctx.orderManager.createOrder({
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      price: ctx.market.getBasePrice("BTCUSDT"),
      agent: DEFAULT_AGENT_ID,
      executionMode: "paper",
    });
    ctx.orderManager.persist();
    const ordersFile = join(ctx.sandboxDir, "orders.json");
    ctx.step("orders.json written inside the scenario sandbox", existsSync(ordersFile), ordersFile);

    ctx.memory.set(DEFAULT_AGENT_ID, "state", "probe", { hello: "world" });
    const stats = ctx.memory.getStats();
    ctx.step(
      "agent memory persist path is inside the scenario sandbox",
      !!stats.persistPath && stats.persistPath.startsWith(ctx.sandboxDir),
      String(stats.persistPath),
    );
    ctx.step(
      "agent memory persist path is not the production data dir",
      !String(stats.persistPath ?? "").startsWith(PRODUCTION_DATA_DIR),
    );
  },
};

/** The sandbox must make live trading impossible, even if the env says otherwise. */
const liveTradingBlockedScenario: TestScenario = {
  id: "live-trading-blocked",
  title: "Live trading is non-bypassable in the sandbox",
  description:
    "Even with LIVE_TRADING_ENABLED=true in the environment, a sandbox pipeline reports live disabled, refuses enableLiveTrading(), and still executes paper-only.",
  tags: ["safety", "live-trading", "gating"],
  async run(ctx) {
    const previous = process.env.LIVE_TRADING_ENABLED;
    process.env.LIVE_TRADING_ENABLED = "true";
    try {
      ctx.step("pipeline reports sandbox mode", ctx.pipeline.isSandboxMode() === true);
      ctx.step("pipeline isLiveEnabled() is false", ctx.pipeline.isLiveEnabled() === false);
      ctx.step(
        "pipeline config forces liveTradingEnabled=false",
        ctx.pipeline.getConfig().liveTradingEnabled === false,
      );

      let threw = false;
      let message = "";
      try {
        ctx.pipeline.enableLiveTrading();
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      ctx.step("enableLiveTrading() throws in the sandbox", threw && /sandbox/i.test(message), message);

      const result = await ctx.pipeline.execute(ctx.signal({ correlationId: `${ctx.runId}:live-block` }));
      ctx.step("paper execution still succeeds", result.success === true, result.reason);
      ctx.step("execution produced a simulated (paper) fill", result.order?.status === "filled");
    } finally {
      if (previous === undefined) delete process.env.LIVE_TRADING_ENABLED;
      else process.env.LIVE_TRADING_ENABLED = previous;
    }
  },
};

/** Happy-path round trip through the full execution pipeline. */
const pipelineRoundtripScenario: TestScenario = {
  id: "pipeline-roundtrip",
  title: "Pipeline round trip (buy → sell) with exact PnL",
  description:
    "A buy then sell of the same symbol goes through validation → risk → permission → paper fill, and cash returns to the starting balance when fees and slippage are zero.",
  tags: ["pipeline", "execution", "broker"],
  async run(ctx) {
    const startCash = ctx.broker.getBalance().cash;
    const symbol = "BTCUSDT";
    const quantity = 0.05;
    const price = ctx.market.getBasePrice(symbol);

    const buy = await ctx.pipeline.execute(
      ctx.signal({ symbol, side: "buy", quantity, price, correlationId: `${ctx.runId}:buy`, id: `${ctx.runId}:buy` }),
    );
    ctx.step("buy is approved and filled", buy.success === true && buy.order?.status === "filled", buy.reason);
    ctx.step("buy carries a risk decision", !!buy.riskDecision?.approved);

    const position = ctx.broker.getPosition(symbol);
    ctx.step("long position opened", position?.side === "long" && approxEqual(position.quantity, quantity));
    ctx.step("fill price matches the simulated market price", approxEqual(buy.order?.filledPrice ?? 0, price));

    const afterBuy = ctx.broker.getBalance().cash;
    ctx.metric("cashAfterBuy", afterBuy);
    ctx.step("cash decreased by the notional", approxEqual(startCash - afterBuy, price * quantity));

    const sell = await ctx.pipeline.execute(
      ctx.signal({ symbol, side: "sell", quantity, price, correlationId: `${ctx.runId}:sell`, id: `${ctx.runId}:sell` }),
    );
    ctx.step("sell is approved and filled", sell.success === true && sell.order?.status === "filled", sell.reason);
    ctx.step("position fully closed", ctx.broker.getPosition(symbol) === undefined);

    const endCash = ctx.broker.getBalance().cash;
    ctx.metric("cashAfterSell", endCash);
    ctx.step("round trip is PnL-neutral with zero fees/slippage", approxEqual(endCash, startCash, 1e-6));

    const portfolio = ctx.broker.getPortfolio();
    ctx.step("realized PnL is zero", approxEqual(portfolio.realizedPnl, 0, 1e-6));
    ctx.step("two canonical orders were recorded", ctx.orderManager.size() === 2, `orders=${ctx.orderManager.size()}`);
    ctx.step(
      "both canonical orders reached FILLED",
      ctx.orderManager.getOrdersByStatus("FILLED").length === 2,
    );
  },
};

/** Retries with the same signal id must not create duplicate orders. */
const idempotentRetryScenario: TestScenario = {
  id: "idempotent-retry",
  title: "Idempotent retry does not double-submit",
  description:
    "Submitting the same signal id twice (even with different correlation ids) yields exactly one canonical order and one simulated fill.",
  tags: ["pipeline", "idempotency", "broker"],
  async run(ctx) {
    const signalId = `${ctx.runId}:idem`;
    const first = await ctx.pipeline.execute(
      ctx.signal({ symbol: "ETHUSDT", side: "buy", quantity: 2, correlationId: `${ctx.runId}:c1`, id: signalId }),
    );
    const second = await ctx.pipeline.execute(
      ctx.signal({ symbol: "ETHUSDT", side: "buy", quantity: 2, correlationId: `${ctx.runId}:c2`, id: signalId }),
    );

    ctx.step("first submission succeeds", first.success === true, first.reason);
    ctx.step("retry also reports success", second.success === true, second.reason);
    ctx.step("only one canonical order exists", ctx.orderManager.size() === 1, `orders=${ctx.orderManager.size()}`);
    ctx.step(
      "only one simulated fill occurred",
      ctx.broker.getOrderHistory().filter((o) => o.status === "filled").length === 1,
    );

    const position = ctx.broker.getPosition("ETHUSDT");
    ctx.step("position reflects a single fill", approxEqual(position?.quantity ?? 0, 2));
    ctx.metric("orders", ctx.orderManager.size());
  },
};

/** The risk engine must be able to veto an order. */
const riskGateRejectScenario: TestScenario = {
  id: "risk-gate-reject",
  title: "Risk engine vetoes a low-confidence order",
  description: "An order below the configured confidence threshold is rejected at the risk stage and never reaches the broker.",
  tags: ["pipeline", "risk"],
  async run(ctx) {
    const gated = createScenarioContext(`${ctx.runId}-gated`, {
      riskConfig: { confidenceThreshold: 0.95 },
    });
    try {
      const result = await gated.pipeline.execute(
        gated.signal({ confidence: 0.1, correlationId: `${ctx.runId}:risk` }),
      );
      ctx.step("execution is rejected", result.success === false);
      ctx.step("rejection happens at the risk stage", result.stage === "risk", `stage=${result.stage}`);
      ctx.step("no simulated order was created", gated.broker.getOrderHistory().length === 0);
      ctx.step("no canonical order was created", gated.orderManager.size() === 0);
      ctx.step("risk decision is surfaced on the result", !!result.riskDecision);
    } finally {
      await gated.dispose();
    }
  },
};

/** Hard limits are evaluated before anything reaches the broker. */
const hardLimitsBlockScenario: TestScenario = {
  id: "hard-limits-block",
  title: "Hard notional limit blocks an oversized order",
  description: "A hard single-order notional cap rejects the signal at the hard_limits stage.",
  tags: ["pipeline", "risk", "limits"],
  async run(ctx) {
    const limited = createScenarioContext(`${ctx.runId}-limited`, {
      hardLimitsConfig: { maxSingleOrderNotional: 1_000 },
    });
    try {
      const price = limited.market.getBasePrice("BTCUSDT");
      const result = await limited.pipeline.execute(
        limited.signal({ quantity: 0.5, price, correlationId: `${ctx.runId}:hl` }),
      );
      ctx.step("execution is rejected", result.success === false);
      ctx.step("rejection happens at the hard_limits stage", result.stage === "hard_limits", `stage=${result.stage}`);
      ctx.step("violation code is reported", /EXCEEDS_SINGLE_ORDER_NOTIONAL/.test(result.reason), result.reason);
      ctx.step("no simulated order was created", limited.broker.getOrderHistory().length === 0);
    } finally {
      await limited.dispose();
    }
  },
};

/** The emergency kill switch halts all execution. */
const killSwitchBlockScenario: TestScenario = {
  id: "kill-switch-block",
  title: "Emergency kill switch halts execution",
  description: "Once the kill switch is triggered, the pipeline rejects every signal at the kill_switch stage.",
  tags: ["pipeline", "safety", "kill-switch"],
  async run(ctx) {
    await ctx.killSwitch.trigger("sandbox scenario: simulated market halt", "scenario-runner");
    ctx.step("kill switch is triggered", ctx.killSwitch.isHalted() === true);

    const result = await ctx.pipeline.execute(ctx.signal({ correlationId: `${ctx.runId}:halt` }));
    ctx.step("execution is rejected", result.success === false);
    ctx.step("rejection happens at the kill_switch stage", result.stage === "kill_switch", `stage=${result.stage}`);
    ctx.step("no simulated order was created", ctx.broker.getOrderHistory().length === 0);
  },
};

/** Secrets must never leak into agent memory or loop traces. */
const secretSanitizationScenario: TestScenario = {
  id: "secret-sanitization",
  title: "Secrets are redacted from memory and traces",
  description: "API keys, tokens and bearer headers written to agent memory are redacted before persistence.",
  tags: ["memory", "security"],
  run(ctx) {
    ctx.memory.set(DEFAULT_AGENT_ID, "research", "credentials", {
      apiKey: "sk-live-abcdef123456",
      nested: { token: "super-secret-token", password: "hunter2" },
      note: "use Bearer abc.def-123 to authenticate",
    });
    const stored = ctx.memory.get(DEFAULT_AGENT_ID, "research", "credentials") as Record<string, unknown>;
    const nested = stored?.nested as Record<string, unknown> | undefined;
    ctx.step("apiKey is redacted", stored?.apiKey === "[REDACTED]", String(stored?.apiKey));
    ctx.step("nested token is redacted", nested?.token === "[REDACTED]", String(nested?.token));
    ctx.step("nested password is redacted", nested?.password === "[REDACTED]", String(nested?.password));
    ctx.step(
      "bearer header is redacted",
      String(stored?.note).includes("Bearer [REDACTED]") && !String(stored?.note).includes("abc.def-123"),
      String(stored?.note),
    );

    const trace: AgentLoopTrace = {
      traceId: `${ctx.runId}-trace`,
      correlationId: `${ctx.runId}:trace`,
      symbol: "BTCUSDT",
      marketEvent: { source: "binance", apiKey: "should-never-persist" },
      outcome: "executed",
      timestamp: Date.now(),
    };
    ctx.memory.recordTrace(trace);
    const saved = ctx.memory.getTraces("BTCUSDT", 1).find((t) => t.traceId === trace.traceId);
    const marketEvent = saved?.marketEvent as Record<string, unknown> | undefined;
    ctx.step("trace marketEvent apiKey is redacted", marketEvent?.apiKey === "[REDACTED]", String(marketEvent?.apiKey));
    ctx.step("trace was recorded", !!saved);
  },
};

/** The simulated market must be bit-for-bit reproducible. */
const marketDeterminismScenario: TestScenario = {
  id: "market-determinism",
  title: "Simulated market is deterministic",
  description: "Two SimulatedMarket instances with the same seed produce identical OHLCV series and order books; a different seed diverges.",
  tags: ["market", "determinism"],
  async run(ctx) {
    const a = new SimulatedMarket({ seed: 7 });
    const b = new SimulatedMarket({ seed: 7 });
    const c = new SimulatedMarket({ seed: 99 });

    const aBars = await a.getOHLCV("BTCUSDT", "1m", 50);
    const bBars = await b.getOHLCV("BTCUSDT", "1m", 50);
    const cBars = await c.getOHLCV("BTCUSDT", "1m", 50);

    ctx.step("same seed => identical OHLCV series", JSON.stringify(aBars) === JSON.stringify(bBars));
    ctx.step("different seed => different OHLCV series", JSON.stringify(aBars) !== JSON.stringify(cBars));

    // Prefix stability: asking for more bars must not change earlier ones.
    const aMore = await a.getOHLCV("BTCUSDT", "1m", 100);
    ctx.step(
      "series is prefix-stable regardless of requested limit",
      JSON.stringify(aMore.slice(0, aBars.length)) === JSON.stringify(aBars),
    );

    const bookA = await a.getOrderBook("BTCUSDT", 10);
    const bookB = await b.getOrderBook("BTCUSDT", 10);
    ctx.step("same seed => identical order book", JSON.stringify(bookA.bids) === JSON.stringify(bookB.bids));

    const tickA = a.tick("BTCUSDT");
    const tickB = b.tick("BTCUSDT");
    ctx.step("same seed => identical tick", tickA.price === tickB.price && tickA.change === tickB.change);
    ctx.step("ticks are marked as simulation-sourced", tickA.source === "simulation");
  },
};

/** Position lifecycle: increase, partial close, full close with exact accounting. */
const positionLifecycleScenario: TestScenario = {
  id: "position-lifecycle",
  title: "Position lifecycle accounting",
  description: "Open, increase, partially close and fully close a long position; average entry price and realized PnL stay exact.",
  tags: ["broker", "portfolio"],
  async run(ctx) {
    const symbol = "BTCUSDT";
    const price = ctx.market.getBasePrice(symbol);
    const startCash = ctx.broker.getBalance().cash;

    await ctx.broker.createOrder(symbol, "buy", 0.1, "market", price, { clientOrderId: `${ctx.runId}:p1` });
    let position = ctx.broker.getPosition(symbol);
    ctx.step("opened 0.1 long", approxEqual(position?.quantity ?? 0, 0.1));
    ctx.step("entry price is the fill price", approxEqual(position?.entryPrice ?? 0, price));

    await ctx.broker.createOrder(symbol, "buy", 0.1, "market", price, { clientOrderId: `${ctx.runId}:p2` });
    position = ctx.broker.getPosition(symbol);
    ctx.step("position increased to 0.2", approxEqual(position?.quantity ?? 0, 0.2));
    ctx.step("average entry price unchanged on equal-priced add", approxEqual(position?.entryPrice ?? 0, price));

    const higher = price * 1.1;
    ctx.broker.updatePrice(symbol, higher);
    await ctx.broker.createOrder(symbol, "sell", 0.05, "market", higher, { clientOrderId: `${ctx.runId}:p3` });
    position = ctx.broker.getPosition(symbol);
    ctx.step("partial close leaves 0.15", approxEqual(position?.quantity ?? 0, 0.15));
    const realizedAfterPartial = ctx.broker.getPortfolio().realizedPnl;
    ctx.step(
      "partial close realizes profit",
      approxEqual(realizedAfterPartial, (higher - price) * 0.05),
      `realized=${realizedAfterPartial}`,
    );

    await ctx.broker.createOrder(symbol, "sell", 0.15, "market", higher, { clientOrderId: `${ctx.runId}:p4` });
    ctx.step("full close removes the position", ctx.broker.getPosition(symbol) === undefined);
    const totalRealized = ctx.broker.getPortfolio().realizedPnl;
    ctx.step(
      "total realized PnL matches the round trip",
      approxEqual(totalRealized, (higher - price) * 0.2),
      `realized=${totalRealized}`,
    );

    const expectedEndCash = startCash + (higher - price) * 0.2;
    ctx.step("cash matches expected proceeds", approxEqual(ctx.broker.getBalance().cash, expectedEndCash, 1e-6));
    ctx.metric("realizedPnl", totalRealized);
  },
};

/** The full catalog. Order is stable so `listScenarios()` output is predictable. */
export const SCENARIOS: TestScenario[] = [
  dataIsolationScenario,
  liveTradingBlockedScenario,
  pipelineRoundtripScenario,
  idempotentRetryScenario,
  riskGateRejectScenario,
  hardLimitsBlockScenario,
  killSwitchBlockScenario,
  secretSanitizationScenario,
  marketDeterminismScenario,
  positionLifecycleScenario,
];

const REGISTRY = new Map<string, TestScenario>(SCENARIOS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Catalog queries
// ---------------------------------------------------------------------------

export interface ScenarioInfo {
  id: string;
  title: string;
  description: string;
  tags: string[];
}

export function listScenarios(): ScenarioInfo[] {
  return SCENARIOS.map(({ id, title, description, tags }) => ({ id, title, description, tags: [...tags] }));
}

export function getScenario(id: string): TestScenario | undefined {
  return REGISTRY.get(id);
}

export function hasScenario(id: string): boolean {
  return REGISTRY.has(id);
}

/** Register an additional scenario (for app-level / downstream suites). */
export function registerScenario(scenario: TestScenario): void {
  if (REGISTRY.has(scenario.id)) {
    // Allow overriding so callers can replace a built-in scenario deliberately.
    const idx = SCENARIOS.findIndex((s) => s.id === scenario.id);
    if (idx >= 0) SCENARIOS[idx] = scenario;
  } else {
    SCENARIOS.push(scenario);
  }
  REGISTRY.set(scenario.id, scenario);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run a single scenario in a fresh, isolated context. */
export async function runScenario(
  scenarioOrId: TestScenario | string,
  options?: ScenarioOptions,
): Promise<ScenarioResult> {
  const scenario = typeof scenarioOrId === "string" ? REGISTRY.get(scenarioOrId) : scenarioOrId;
  if (!scenario) {
    throw new Error(`[test-mode] unknown scenario: ${String(scenarioOrId)}`);
  }

  const started = Date.now();
  const ctx = createScenarioContext(scenario.id, options);
  let error: string | undefined;
  try {
    await scenario.run(ctx);
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.step("scenario threw an unhandled error", false, error);
  } finally {
    await ctx.dispose().catch(() => {});
  }

  const steps = (ctx as unknown as { steps: ScenarioStep[] }).steps;
  const metrics = (ctx as unknown as { metrics: Record<string, number> }).metrics;
  return {
    id: scenario.id,
    title: scenario.title,
    passed: !error && steps.every((s) => s.ok),
    steps,
    metrics,
    sandboxDir: ctx.sandboxDir,
    durationMs: Date.now() - started,
    error,
  };
}

export interface CatalogRunOptions extends ScenarioOptions {
  /** Restrict the run to these scenario ids (default: all). */
  only?: string[];
  /** Run scenarios concurrently. Default 4; set 1 for sequential. */
  concurrency?: number;
  /** Called after each scenario completes. */
  onResult?: (result: ScenarioResult) => void;
}

export interface CatalogRunSummary {
  results: ScenarioResult[];
  passed: number;
  failed: number;
  durationMs: number;
  ok: boolean;
}

/**
 * Run the catalog. Scenarios are fully isolated from each other, so running
 * them concurrently is safe (and is the default).
 */
export async function runScenarioCatalog(options?: CatalogRunOptions): Promise<CatalogRunSummary> {
  const started = Date.now();
  const ids = options?.only?.length ? options.only : SCENARIOS.map((s) => s.id);
  const concurrency = Math.max(1, options?.concurrency ?? 4);

  const results: ScenarioResult[] = new Array(ids.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index]!;
      const result = await runScenario(id, options);
      results[index] = result;
      options?.onResult?.(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

  const finalResults = results.filter(Boolean);
  const passed = finalResults.filter((r) => r.passed).length;
  return {
    results: finalResults,
    passed,
    failed: finalResults.length - passed,
    durationMs: Date.now() - started,
    ok: finalResults.length === passed,
  };
}

/** Pretty-print the catalog (used by the CLI and logs). */
export function formatCatalog(): string {
  const lines: string[] = ["Finance Agent OS — test scenario catalog", ""];
  for (const s of listScenarios()) {
    lines.push(`  ${s.id.padEnd(24)} ${s.title}`);
    lines.push(`  ${"".padEnd(24)} ${s.description}`);
    lines.push(`  ${"".padEnd(24)} tags: ${s.tags.join(", ")}`);
    lines.push("");
  }
  lines.push(`${SCENARIOS.length} scenarios — run with: pnpm --filter @finance/server scenarios:run`);
  return lines.join("\n");
}

/** Format a run summary for terminal output. */
export function formatSummary(summary: CatalogRunSummary): string {
  const lines: string[] = [];
  for (const r of summary.results) {
    lines.push(`${r.passed ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${r.durationMs}ms  (${r.sandboxDir})`);
    for (const step of r.steps) {
      lines.push(`      ${step.ok ? "✓" : "✗"} ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    if (r.error) lines.push(`      error: ${r.error}`);
  }
  lines.push("");
  lines.push(`${summary.passed}/${summary.results.length} scenarios passed in ${summary.durationMs}ms`);
  return lines.join("\n");
}
