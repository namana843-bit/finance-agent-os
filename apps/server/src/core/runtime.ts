// ============================================================================
// Finance Agent OS — Server Runtime
// Wires up the Finance Runtime with server-specific configuration
// ============================================================================

import { FinanceRuntime } from "@finance/core";
import { MarketAgent } from "../agents/market/index.js";
import { QuantAgent } from "../agents/quant/index.js";
import { RiskAgent } from "../agents/risk/index.js";
import { PortfolioAgent } from "../agents/portfolio/index.js";
import { ExecutionAgent } from "../agents/execution/index.js";

let runtime: FinanceRuntime | null = null;

export function createRuntime(): FinanceRuntime {
  if (runtime) return runtime;

  const executionMode = (process.env.EXECUTION_MODE as "paper" | "live") ?? "paper";

  runtime = new FinanceRuntime({
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 4132,
    host: process.env.HOST ?? "0.0.0.0",
    executionMode,
    logLevel: "info",
  });

  const bus = runtime.getEventBus();

  // Register agents
  runtime.registerAgent(new MarketAgent(bus));
  runtime.registerAgent(new QuantAgent(bus));
  runtime.registerAgent(new RiskAgent(bus));
  runtime.registerAgent(new PortfolioAgent(bus));
  runtime.registerAgent(new ExecutionAgent(bus));

  return runtime;
}

export function getRuntime(): FinanceRuntime | null {
  return runtime;
}

export async function startRuntime(): Promise<FinanceRuntime> {
  const rt = createRuntime();
  await rt.start();
  return rt;
}

export async function stopRuntime(): Promise<void> {
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }
}
