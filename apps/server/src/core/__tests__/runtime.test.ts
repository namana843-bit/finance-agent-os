import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FinanceRuntime } from "../runtime.js";
import { EventBus } from "../eventBus.js";

describe("FinanceRuntime — foundation + multi-loop", () => {
  it("reuses 5 existing agents via legacy adapter + 3 tools", async () => {
    const bus = new EventBus();
    const runtime = new FinanceRuntime({ bus });
    const { MarketAgent } = await import("../../agents/market/index.js");
    const { QuantAgent } = await import("../../agents/quant/index.js");
    const { RiskAgent } = await import("../../agents/risk/index.js");
    const { PortfolioAgent } = await import("../../agents/portfolio/index.js");
    const { ExecutionAgent } = await import("../../agents/execution/index.js");
    const { ValidateSymbolTool } = await import("../../tools/validateSymbol.js");
    const { FormatMoneyTool } = await import("../../tools/formatMoney.js");
    const { EventLogTool } = await import("../../tools/eventLog.js");

    // ExecutionAgent latency would slow tests — set 0 via config
    const execution = new ExecutionAgent(bus, { latency: 0 });

    runtime.registerLegacyAgent("market", new MarketAgent(bus));
    runtime.registerLegacyAgent("quant", new QuantAgent(bus));
    runtime.registerLegacyAgent("risk", new RiskAgent(bus));
    runtime.registerLegacyAgent("portfolio", new PortfolioAgent(bus));
    runtime.registerLegacyAgent("execution", execution);
    runtime.registerTool(new ValidateSymbolTool());
    runtime.registerTool(new FormatMoneyTool());
    runtime.registerTool(new EventLogTool());

    await runtime.start();
    assert.equal(runtime.health().agents.running, 5);
    assert.deepEqual(runtime.health().tools.sort(), ["event-log", "format-money", "validate-symbol"]);

    // Multi-loop: drive 3 synthetic ticks through the real pipeline
    // market:tick -> quant signal -> risk -> portfolio order -> execution fill
    const loopResults = await runtime.runLoops(3, async (i) => {
      const correlationId = `test-loop-${i}`;
      bus.publish({
        type: "market:tick",
        data: { symbol: "AAPL", price: 220 + i, volume: 100, timestamp: Date.now(), source: "synthetic" },
        correlationId,
        source: "test",
      });
      await new Promise((r) => setTimeout(r, 350)); // allow async execution fill
      return correlationId;
    });
    assert.equal(loopResults.length, 3);

    const signals = bus.getHistory({ type: "signal:buy" }).length + bus.getHistory({ type: "signal:sell" }).length + bus.getHistory({ type: "signal:hold" }).length;
    assert.ok(signals >= 3, `expected >=3 signals, got ${signals}`);

    // tools callable via registry in loop
    const res = await runtime.tools.execute("format-money", { amount: 1000, currency: "USDT" }, { agentId: "test" });
    assert.equal(res.ok, true);

    await runtime.stop();
    assert.equal(runtime.health().agents.running, 0);
  });
});
