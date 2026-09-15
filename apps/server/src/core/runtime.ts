// ============================================================================
// Finance Agent OS — Server Runtime
// Central composition root: registers all agents, tools, plugins, strategies,
// and services with the FinanceRuntime.
// ============================================================================

import { FinanceRuntime } from "@finance/core";
import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import { MarketAgent } from "../agents/market/index.js";
import { QuantAgent } from "../agents/quant/index.js";
import { RiskAgent } from "../agents/risk/index.js";
import { PortfolioAgent } from "../agents/portfolio/index.js";
import { ExecutionAgent } from "../agents/execution/index.js";
import { DemoAgent } from "../agents/demo-agent/index.js";
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
import { OrderManager } from "../order-manager/order-manager.js";
import { TradeEngine } from "../trade-engine/trade-engine.js";
import { AgentMemory } from "../memory/agent-memory.js";
import { createFinanceEnvironment } from "../environment/index.js";
import { FinanceEnvironmentService } from "../environment/service.js";
import { SupervisorAgent } from "../agents/supervisor/index.js";
import { StrategyLabService } from "../strategy-lab/service.js";
import { ExecutionPipelineService } from "../execution-pipeline/service.js";
import { ChatService } from "../chat/service.js";
import { DialogueEngine } from "../chat/dialogue-engine.js";
import { ApprovalServiceWrapper } from "../approvals/service.js";
import { LlmServiceWrapper } from "../llm/service.js";
import { UsageTracker } from "../llm/usage.js";
import type { LlmService } from "../llm/llm-service.js";

import { OpencodeCliGateway } from "../gateway/opencode-cli-gateway.js";

// Service IDs — canonical identifiers for service lookup
export const SERVICE_IDS = {
  GATEWAY: "gateway",
  AUDIT_LOGGER: "audit-logger",
  MARKET_STATE: "market-state",
  PAPER_BROKER: "paper-broker",
  STATE_RECOVERY: "state-recovery",
  ORDER_MANAGER: "order-manager",
  TRADE_ENGINE: "trade-engine",
  AGENT_MEMORY: "agent-memory",
  STRATEGY_REGISTRY: "strategy-registry",
  FINANCE_ENVIRONMENT: "finance-environment",
  STRATEGY_LAB: "strategy-lab",
  EXECUTION_PIPELINE: "execution-pipeline",
  OPENCODE_GATEWAY: "opencode-gateway",
  CHAT: "chat",
  APPROVALS: "approvals",
  LLM: "llm",
  DIALOGUE_ENGINE: "dialogue-engine",
} as const;

// ---------------------------------------------------------------------------
// Service Wrappers — adapt existing services to ServiceLifecycle
// ---------------------------------------------------------------------------

class GatewayService implements ServiceLifecycle {
  private gateway: FinanceGateway;
  private info: ServiceInfo = {
    id: SERVICE_IDS.GATEWAY,
    name: "Finance Gateway",
    version: "0.1.0",
    description: "Central authority between agents and execution layer",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus, executionMode: string) {
    this.gateway = new FinanceGateway(bus, { executionMode: executionMode as "paper" | "live" });
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): FinanceGateway {
    return this.gateway;
  }
}

class AuditLoggerService implements ServiceLifecycle {
  private logger: AuditLogger;
  private info: ServiceInfo = {
    id: SERVICE_IDS.AUDIT_LOGGER,
    name: "Audit Logger",
    version: "0.1.0",
    description: "Complete financial audit logging for all events",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.logger = new AuditLogger(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.logger.start();
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.logger.stop();
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): AuditLogger {
    return this.logger;
  }
}

class MarketStateServiceWrapper implements ServiceLifecycle {
  private service: MarketStateService;
  private info: ServiceInfo = {
    id: SERVICE_IDS.MARKET_STATE,
    name: "Market State Service",
    version: "0.1.0",
    description: "Maintains real-time market state from live data",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.service = new MarketStateService(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.service.start();
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.service.stop();
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): MarketStateService {
    return this.service;
  }
}

class PaperBrokerService implements ServiceLifecycle {
  private broker: PaperBroker;
  private info: ServiceInfo = {
    id: SERVICE_IDS.PAPER_BROKER,
    name: "Paper Broker",
    version: "0.1.0",
    description: "Realistic paper trading simulation",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.broker = new PaperBroker(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): PaperBroker {
    return this.broker;
  }
}

class StateRecoveryService implements ServiceLifecycle {
  private recovery: StateRecovery;
  private info: ServiceInfo = {
    id: SERVICE_IDS.STATE_RECOVERY,
    name: "State Recovery",
    version: "0.1.0",
    description: "Application persistence and restart recovery",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.recovery = new StateRecovery(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    await this.recovery.start();
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    await this.recovery.stop();
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): StateRecovery {
    return this.recovery;
  }
}

class OrderManagerService implements ServiceLifecycle {
  private manager: OrderManager;
  private info: ServiceInfo = {
    id: SERVICE_IDS.ORDER_MANAGER,
    name: "Order Manager",
    version: "0.1.0",
    description: "Order lifecycle management with state machine",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.manager = new OrderManager(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): OrderManager {
    return this.manager;
  }
}

class TradeEngineService implements ServiceLifecycle {
  private engine: TradeEngine;
  private info: ServiceInfo = {
    id: SERVICE_IDS.TRADE_ENGINE,
    name: "Trade Engine",
    version: "0.1.0",
    description: "Trade management separate from orders",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.engine = new TradeEngine(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): TradeEngine {
    return this.engine;
  }
}

class AgentMemoryService implements ServiceLifecycle {
  private memory: AgentMemory;
  private info: ServiceInfo = {
    id: SERVICE_IDS.AGENT_MEMORY,
    name: "Agent Memory",
    version: "0.1.0",
    description: "Structured persistent memory for agents",
    status: "registered",
  };

  constructor() {
    this.memory = new AgentMemory();
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): AgentMemory {
    return this.memory;
  }
}

class OpencodeGatewayService implements ServiceLifecycle {
  private gateway: OpencodeCliGateway;
  private info: ServiceInfo = {
    id: SERVICE_IDS.OPENCODE_GATEWAY,
    name: "OpenCode CLI Gateway",
    version: "0.1.0",
    description: "Permissioned gateway for opencode CLI path + execution (path gateways)",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.gateway = new OpencodeCliGateway(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    // warm cache
    await this.gateway.getCliInfo().catch(() => {});
    this.info.status = "active";
    const cli = await this.gateway.getCliInfo().catch(() => null);
    console.log(`[service:${this.info.id}] started cli=${cli?.cliPath ?? "not found"} exists=${cli?.exists ?? false}`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): OpencodeCliGateway {
    return this.gateway;
  }
}

// ---------------------------------------------------------------------------
// Strategy Registry Service Wrapper
// ---------------------------------------------------------------------------

class StrategyRegistryService implements ServiceLifecycle {
  private registry: StrategyRegistry;
  private info: ServiceInfo = {
    id: SERVICE_IDS.STRATEGY_REGISTRY,
    name: "Strategy Registry",
    version: "0.1.0",
    description: "Pluggable strategy management and registration",
    status: "registered",
  };

  constructor() {
    this.registry = new StrategyRegistry();
    registerDefaultStrategies(this.registry);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started (${this.registry.size()} strategies)`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): StrategyRegistry {
    return this.registry;
  }
}


class DialogueEngineService implements ServiceLifecycle {
  private engine: DialogueEngine;
  private info: ServiceInfo = {
    id: SERVICE_IDS.DIALOGUE_ENGINE,
    name: "Dialogue Engine",
    version: "0.1.0",
    description: "Multi-agent conversational dialogue layer for OpenMausBot",
    status: "registered",
  };

  constructor(bus: import("@finance/core").TypedEventBus) {
    this.engine = new DialogueEngine(bus);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.engine.destroy();
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): DialogueEngine {
    return this.engine;
  }
}

// ---------------------------------------------------------------------------
// Runtime Factory
// ---------------------------------------------------------------------------

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

  // --- Agents — OpenBot-style: explicit registry (extensible via registerAgent)
  // To add a new finance agent: create apps/server/src/agents/<my-agent>/index.ts
  // and add `runtime.registerAgent(new MyAgent(bus))` here — or use the CLI scaffold:
  //   pnpm openbot add agent my-agent --template quant
const riskAgent = new RiskAgent(bus);
   runtime.registerAgent(new MarketAgent(bus));
   runtime.registerAgent(new QuantAgent(bus));
   runtime.registerAgent(riskAgent);
   runtime.registerAgent(new PortfolioAgent(bus));
   runtime.registerAgent(new ExecutionAgent(bus));
   runtime.registerAgent(new DemoAgent(bus));

   // Supervisor — deterministic planner: task -> Market -> Research -> Strategy -> Risk -> Final
  // Uses AgentRegistry/ToolRegistry/EventBus to validate and execute plans.
  const supervisor = new SupervisorAgent({ bus, agentRegistry: runtime.getAgentRegistry(), toolRegistry: runtime.getToolRegistry() });
  runtime.registerAgent(supervisor);

  // --- Tools — OpenBot-style tool registry ---
  // Add tools via `pnpm openbot add tool <name>` -> apps/server/src/tools/<name>/index.ts
  registerAllTools(runtime);

  // --- Plugin — OpenBot-style plugin registry ---
  // Add plugins via `pnpm openbot add plugin <name>` -> apps/server/src/plugins/<name>/index.ts
  const binancePlugin = new BinanceMarketPlugin();
  runtime.registerPlugin(
    { id: "binance-market", name: "Binance Market Data", version: "0.1.0", description: "Binance market data plugin (REST + WS)", status: "registered" },
    binancePlugin,
  );

  // --- Services ---
  // Strategy Registry
  const strategyRegistryService = new StrategyRegistryService();
  runtime.registerService(strategyRegistryService);

  // Wire server-level strategies into core runtime's strategy registry
  const strategyRegistry = strategyRegistryService.getInstance();
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

  // Gateway
  const gatewayService = new GatewayService(bus, executionMode);
  runtime.registerService(gatewayService);

  // Audit Logger
  const auditLoggerService = new AuditLoggerService(bus);
  runtime.registerService(auditLoggerService);

  // Market State
  const marketStateService = new MarketStateServiceWrapper(bus);
  runtime.registerService(marketStateService);

  // Paper Broker
  const paperBrokerService = new PaperBrokerService(bus);
  runtime.registerService(paperBrokerService);

  // State Recovery
  const stateRecoveryService = new StateRecoveryService(bus);
  runtime.registerService(stateRecoveryService);

  // Order Manager
  const orderManagerService = new OrderManagerService(bus);
  runtime.registerService(orderManagerService);

  // Trade Engine
  const tradeEngineService = new TradeEngineService(bus);
  runtime.registerService(tradeEngineService);

  // Agent Memory
  const agentMemoryService = new AgentMemoryService();
  runtime.registerService(agentMemoryService);

  // OpenCode CLI Path Gateway — permissioned path gateways for opencode binary
  const opencodeGatewayService = new OpencodeGatewayService(bus);
  runtime.registerService(opencodeGatewayService);

  // Dialogue Engine — OpenMausBot Conversational Dialogue Layer (from main)
  const dialogueEngineService = new DialogueEngineService(bus);
  runtime.registerService(dialogueEngineService);

  // Finance Environment — OpenMausBot-inspired abstraction for agents
  // Composes Binance market-data adapter (BinanceMarketDataAdapter) + Paper Trading adapter (PaperTradingAdapter)
  // No live orders — paper only. Agents interact exclusively via environment.
  const financeEnv = createFinanceEnvironment({
    bus,
    mode: "paper",
    strategyRegistry: strategyRegistryService.getInstance(),
  });
  runtime.registerService(new FinanceEnvironmentService(financeEnv, bus));

  // Strategy Lab — Idea -> Strategy -> Backtest -> Performance -> Risk -> Paper Candidate
  // Reuses BacktestEngine + modular StrategyRegistry + FinanceEnvironment; paper-only.
  const strategyLabService = new StrategyLabService({
    bus,
    strategyRegistry: strategyRegistryService.getInstance(),
    market: financeEnv.market,
  });
  runtime.registerService(strategyLabService);

  // Execution Pipeline — Signal -> Risk -> Permission -> Paper -> Result (live disabled by default)
  const executionPipelineService = new ExecutionPipelineService({
    bus,
    riskAgent,
    gateway: gatewayService.getInstance(),
    paperBroker: paperBrokerService.getInstance(),
    auditLogger: auditLoggerService.getInstance(),
  });
  runtime.registerService(executionPipelineService);

  const approvalService = new ApprovalServiceWrapper({
    bus,
    getPipeline: () => getExecutionPipeline() as unknown as { execute: (s: Record<string, unknown>) => Promise<unknown> } | undefined,
    mode: (process.env.APPROVAL_MODE as "auto-paper" | "always") ?? "auto-paper",
    executionMode: (process.env.EXECUTION_MODE as string) ?? "paper",
    ttlMs: process.env.PROPOSAL_TTL_MS ? parseInt(process.env.PROPOSAL_TTL_MS, 10) : undefined,
  });
  runtime.registerService(approvalService);

  const llmService = new LlmServiceWrapper({ tracker: new UsageTracker() });
  runtime.registerService(llmService);

  const riskAgentFromRegistry = runtime.getAgentRegistry().get("risk") as unknown as { setHoldCheck?: (fn: (s: Record<string, unknown>) => boolean) => void } | undefined;
  const approvals = approvalService.getInstance();
  riskAgentFromRegistry?.setHoldCheck?.(() => approvals.isGating());

  // Connect full OS: User -> Desktop (supervisor.task) -> Supervisor -> Tools/Environment -> Risk -> Paper
  // Supervisor trade steps now route through ExecutionPipeline so permissions/audit/Risk gates are enforced.
  // No live trading — paper-only, LIVE_TRADING_ENABLED guard inside pipeline.
  supervisor.setExecutionPipeline(executionPipelineService.getInstance() as unknown as import("../agents/supervisor/index.js").ExecutionPipelineLike);

  runtime.registerService(new ChatService({ bus, getLlm: () => getLlm(), submitTask: (task, correlationId) => { const sup = getSupervisor(); if (!sup) return Promise.reject(new Error("supervisor not available")); return (sup as unknown as { submitTask: (t: string, c?: string) => Promise<unknown> }).submitTask(task, correlationId); } }));

  return runtime;
}

// ---------------------------------------------------------------------------
// Service Accessors — typed helpers for accessing services via the runtime
// ---------------------------------------------------------------------------

export function getRuntime(): FinanceRuntime | null {
  return runtime;
}

function getService<T extends ServiceLifecycle>(id: string): T | undefined {
  return runtime?.getService<T>(id);
}

export function getGateway(): FinanceGateway | undefined {
  return getService<GatewayService>(SERVICE_IDS.GATEWAY)?.getInstance();
}

export function getStateRecovery(): StateRecovery | undefined {
  return getService<StateRecoveryService>(SERVICE_IDS.STATE_RECOVERY)?.getInstance();
}

export function getAuditLogger(): AuditLogger | undefined {
  return getService<AuditLoggerService>(SERVICE_IDS.AUDIT_LOGGER)?.getInstance();
}

export function getMarketState(): MarketStateService | undefined {
  return getService<MarketStateServiceWrapper>(SERVICE_IDS.MARKET_STATE)?.getInstance();
}

export function getStrategyRegistry(): StrategyRegistry | undefined {
  return getService<StrategyRegistryService>(SERVICE_IDS.STRATEGY_REGISTRY)?.getInstance();
}

export function getPaperBroker(): PaperBroker | undefined {
  return getService<PaperBrokerService>(SERVICE_IDS.PAPER_BROKER)?.getInstance();
}

export function getOrderManager(): OrderManager | undefined {
  return getService<OrderManagerService>(SERVICE_IDS.ORDER_MANAGER)?.getInstance();
}

export function getTradeEngine(): TradeEngine | undefined {
  return getService<TradeEngineService>(SERVICE_IDS.TRADE_ENGINE)?.getInstance();
}

export function getAgentMemory(): AgentMemory | undefined {
  return getService<AgentMemoryService>(SERVICE_IDS.AGENT_MEMORY)?.getInstance();
}

export function getFinanceEnvironment(): import("../environment/types.js").FinanceEnvironment | undefined {
  return getService<FinanceEnvironmentService>(SERVICE_IDS.FINANCE_ENVIRONMENT)?.getInstance();
}

export function getSupervisor(): SupervisorAgent | undefined {
  return runtime?.getAgentRegistry().get("supervisor") as SupervisorAgent | undefined;
}

export function getStrategyLab(): import("../strategy-lab/strategy-lab.js").StrategyLab | undefined {
  return getService<import("../strategy-lab/service.js").StrategyLabService>(SERVICE_IDS.STRATEGY_LAB)?.getInstance();
}

export function getExecutionPipeline(): import("../execution-pipeline/pipeline.js").ExecutionPipeline | undefined {
  return getService<import("../execution-pipeline/service.js").ExecutionPipelineService>(SERVICE_IDS.EXECUTION_PIPELINE)?.getInstance();
}

export function getApprovals(): import("../approvals/approval-service.js").ApprovalService | undefined {
  return getService<ApprovalServiceWrapper>(SERVICE_IDS.APPROVALS)?.getInstance();
}

export function getLlm(): LlmService | undefined {
  return getService<LlmServiceWrapper>(SERVICE_IDS.LLM)?.getInstance();
}

export function getOpencodeGateway(): OpencodeCliGateway | undefined {
  return getService<OpencodeGatewayService>(SERVICE_IDS.OPENCODE_GATEWAY)?.getInstance();
}

export function getDialogueEngine(): DialogueEngine | undefined {
  return getService<DialogueEngineService>(SERVICE_IDS.DIALOGUE_ENGINE)?.getInstance();
}

export function getChat(): import("../chat/chat-service.js").ChatCore | undefined { return getService<ChatService>(SERVICE_IDS.CHAT)?.getInstance(); }

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

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
