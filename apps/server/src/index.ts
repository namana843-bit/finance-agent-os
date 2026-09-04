import { startServer } from "./core/server.js";
import { FinanceRuntime } from "./core/runtime.js";
import { MarketAgent } from "./agents/market/index.js";
import { QuantAgent } from "./agents/quant/index.js";
import { RiskAgent } from "./agents/risk/index.js";
import { PortfolioAgent } from "./agents/portfolio/index.js";
import { ExecutionAgent } from "./agents/execution/index.js";
import { eventBus } from "./core/eventBus.js";
import { ValidateSymbolTool } from "./tools/validateSymbol.js";
import { FormatMoneyTool } from "./tools/formatMoney.js";
import { EventLogTool } from "./tools/eventLog.js";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4132;
const host = process.env.HOST ?? "0.0.0.0";

let server: Awaited<ReturnType<typeof startServer>> | null = null;

// Finance foundation: one runtime owns bus + agent registry + tool registry.
// Existing 5 agents are reused via registerLegacyAgent (no rewrites, no duplicate bus).
const runtime = new FinanceRuntime({ bus: eventBus });

const marketAgent = new MarketAgent(eventBus);
const quantAgent = new QuantAgent(eventBus);
const riskAgent = new RiskAgent(eventBus);
const portfolioAgent = new PortfolioAgent(eventBus);
const executionAgent = new ExecutionAgent(eventBus);

runtime.registerLegacyAgent("market", marketAgent, { description: "Market data ticks (synthetic + Binance REST)" });
runtime.registerLegacyAgent("quant", quantAgent, { description: "Indicator confluence signals", dependencies: ["market"] });
runtime.registerLegacyAgent("risk", riskAgent, { description: "Deterministic risk gate", dependencies: ["quant"] });
runtime.registerLegacyAgent("portfolio", portfolioAgent, { description: "1% sizing + position tracking", dependencies: ["risk"] });
runtime.registerLegacyAgent("execution", executionAgent, { description: "Paper fills (live gated)", dependencies: ["portfolio"] });

runtime.registerTool(new ValidateSymbolTool());
runtime.registerTool(new FormatMoneyTool());
runtime.registerTool(new EventLogTool());

async function main() {
  try {
    server = await startServer({ port, host, bus: eventBus });
    console.log(`[finance-os] server started on http://${host}:${port}`);

    await runtime.start();
    const health = runtime.health();
    console.log(`[finance-os] agents started: ${health.agents.agents.map((a) => `${a.id}=${a.running}`).join(" ")}`);
    console.log(`[finance-os] tools: ${health.tools.join(",")}`);
    console.log(`[finance-os] pipeline: market:tick -> signal:* -> risk:* -> portfolio:order -> execution:filled -> portfolio:update`);
  } catch (err) {
    console.error("[finance-os] failed to start server:", err);
    process.exit(1);
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    console.log(`\n[finance-os] received ${signal}, shutting down gracefully...`);
    try {
      await runtime.stop();
      console.log("[finance-os] agents stopped");
      if (server) {
        await server.close();
        console.log("[finance-os] server closed");
      }
    } catch (err) {
      console.error("[finance-os] error during shutdown:", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    console.error("[finance-os] unhandledRejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[finance-os] uncaughtException:", err);
  });
}

setupGracefulShutdown();
void main();

export { runtime };
