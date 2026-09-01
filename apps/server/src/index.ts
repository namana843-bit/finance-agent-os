import { startServer } from "./core/server.js";
import { MarketAgent } from "./agents/market/index.js";
import { QuantAgent } from "./agents/quant/index.js";
import { RiskAgent } from "./agents/risk/index.js";
import { PortfolioAgent } from "./agents/portfolio/index.js";
import { ExecutionAgent } from "./agents/execution/index.js";
import { eventBus } from "./core/eventBus.js";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4132;
const host = process.env.HOST ?? "0.0.0.0";

let server: Awaited<ReturnType<typeof startServer>> | null = null;

const marketAgent = new MarketAgent(eventBus);
const quantAgent = new QuantAgent(eventBus);
const riskAgent = new RiskAgent(eventBus);
const portfolioAgent = new PortfolioAgent(eventBus);
const executionAgent = new ExecutionAgent(eventBus);

async function main() {
  try {
    server = await startServer({ port, host, bus: eventBus });
    console.log(`[finance-os] server started on http://${host}:${port}`);

    marketAgent.start();
    quantAgent.start();
    riskAgent.start();
    portfolioAgent.start();
    executionAgent.start();
    console.log(`[finance-os] agents started: market=${marketAgent.isRunning()} quant=${quantAgent.isRunning()} risk=${riskAgent.isRunning()} portfolio=${portfolioAgent.isRunning()} execution=${executionAgent.isRunning()}`);
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
      marketAgent.stop();
      quantAgent.stop();
      riskAgent.stop();
      portfolioAgent.stop();
      executionAgent.stop();
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
    // Keep running for transient errors; don't exit immediately
  });
}

setupGracefulShutdown();
void main();
