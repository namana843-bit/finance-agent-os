// ============================================================================
// Finance Agent OS — Server Runtime
// Wires up the Finance Runtime with all components
// ============================================================================

import { FinanceRuntime } from "@finance/core";
import { MarketAgent } from "../agents/market/index.js";
import { QuantAgent } from "../agents/quant/index.js";
import { RiskAgent } from "../agents/risk/index.js";
import { PortfolioAgent } from "../agents/portfolio/index.js";
import { ExecutionAgent } from "../agents/execution/index.js";
import { registerAllTools } from "../tools/finance-tools.js";
import { BinanceMarketPlugin } from "../plugins/binance-plugin.js";
import { FinanceGateway } from "../gateway/finance-gateway.js";
import { StateRecovery } from "../state/state-recovery.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { MarketStateService } from "../market/market-state.js";
import {
  StrategyRegistry,
  registerDefaultStrategies,
} from "../strategies/strategy-registry.js";
import { PaperBroker } from "../broker/paper-broker.js";

let runtime: FinanceRuntime | null = null;
let gateway: FinanceGateway | null = null;
let stateRecovery: StateRecovery | null = null;
let auditLogger: AuditLogger | null = null;
let marketState: MarketStateService | null = null;
let strategyRegistry: StrategyRegistry | null = null;
let paperBroker: PaperBroker | null = null;

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

  // --- Agents ---
  runtime.registerAgent(new MarketAgent(bus));
  runtime.registerAgent(new QuantAgent(bus));
  runtime.registerAgent(new RiskAgent(bus));
  runtime.registerAgent(new PortfolioAgent(bus));
  runtime.registerAgent(new ExecutionAgent(bus));

  // --- Tools ---
  registerAllTools(runtime);

  // --- Plugin ---
  const binancePlugin = new BinanceMarketPlugin();
  runtime.registerPlugin(
    { id: "binance-market", name: "Binance Market Data", version: "0.1.0", description: "Binance market data plugin", status: "registered" },
    binancePlugin,
  );

  // --- Strategy Registry ---
  strategyRegistry = new StrategyRegistry();
  registerDefaultStrategies(strategyRegistry);

  // Wire strategy registry into runtime — register each strategy
  for (const strategy of strategyRegistry.list()) {
    const instance = strategyRegistry.get(strategy.id);
    if (instance) {
      runtime.registerStrategy(strategy, {
        calculate: (prices: number[], _params: Record<string, unknown>) => instance.calculate(prices) as unknown as Record<string, unknown>,
        generateSignal: (data: Record<string, unknown>) => {
          const prices = data.prices as number[];
          const result = instance.calculate(prices ?? []);
          return { side: result.side, confidence: result.confidence, reasoning: result.reasoning };
        },
      });
    }
  }

  // --- Gateway ---
  gateway = new FinanceGateway(bus, { executionMode });

  // --- Audit Logger ---
  auditLogger = new AuditLogger(bus);
  auditLogger.start();

  // --- Market State ---
  marketState = new MarketStateService(bus);
  marketState.start();

  // --- Paper Broker ---
  paperBroker = new PaperBroker(bus);

  // --- State Recovery ---
  stateRecovery = new StateRecovery(bus);
  void stateRecovery.start();

  return runtime;
}

export function getRuntime(): FinanceRuntime | null {
  return runtime;
}

export function getGateway(): FinanceGateway | null {
  return gateway;
}

export function getStateRecovery(): StateRecovery | null {
  return stateRecovery;
}

export function getAuditLogger(): AuditLogger | null {
  return auditLogger;
}

export function getMarketState(): MarketStateService | null {
  return marketState;
}

export function getStrategyRegistry(): StrategyRegistry | null {
  return strategyRegistry;
}

export function getPaperBroker(): PaperBroker | null {
  return paperBroker;
}

export async function startRuntime(): Promise<FinanceRuntime> {
  const rt = createRuntime();
  await rt.start();
  return rt;
}

export async function stopRuntime(): Promise<void> {
  if (stateRecovery) {
    await stateRecovery.stop();
    stateRecovery = null;
  }
  if (auditLogger) {
    auditLogger.stop();
    auditLogger = null;
  }
  if (marketState) {
    marketState.stop();
    marketState = null;
  }
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }
  gateway = null;
  strategyRegistry = null;
  paperBroker = null;
}
