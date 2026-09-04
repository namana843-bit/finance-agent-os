# Finance Runtime

The Finance Runtime is the central orchestrator of the Finance Agent Platform. It manages the lifecycle of all agents, tools, plugins, strategies, and services. Composition root is `apps/server/src/core/runtime.ts:createRuntime()`.

## Architecture

```
FinanceRuntime (@finance/core — LifecycleManager CREATED→…→RUNNING)
├── TypedEventBus        — Event-driven communication (50k history, correlationId, replay)
├── AgentRegistry        — 6 agents: Market, Quant, Risk, Portfolio, Execution, Supervisor
├── ToolRegistry         — 21 finance tools (price/ohlcv/orderbook/portfolio/indicators/utility via ExchangeProvider)
├── PluginRegistry       — BinanceMarketPlugin
├── StrategyRegistry     — Strategy configuration & signals (plus lab:<id>:<kind> from Strategy Lab)
├── ServiceRegistry      — 11 services ↓
│   ├── FinanceGateway       — Governance between agents and execution
│   ├── AuditLogger          — Records all events for compliance (+ pipeline mirror)
│   ├── MarketStateService   — Real-time market state tracking
│   ├── StateRecovery        — Persist/restore state across restarts
│   ├── PaperBroker          — Paper trading execution (single truth)
│   ├── OrderManager / TradeEngine — Order lifecycle, trades ≠ orders
│   ├── AgentMemory          — Structured agent memory
│   ├── StrategyRegistry     — Pluggable strategies
│   ├── FinanceEnvironment   — MarketData/Portfolio/PaperTrading/Backtest ports (Binance + Paper adapters)
│   ├── StrategyLab          — Idea → Strategy → Backtest → Performance → Risk → Candidate (reuses BacktestEngine)
│   └── ExecutionPipeline    — Signal → Risk → Permission → Paper → Result (audited, paper-only default)
├── ExchangeProvider     — memory-provider (tests/synthetic) | binance-provider (live read) — keeps exchange code out of tools
└── Desktop OS           — Next.js Shell (Chat→supervisor.task, Workspace, ToolActivity, Market/Strategy/Portfolio/Risk/Paper/Terminal) via SSE + REST
```

## Usage

```typescript
import { FinanceRuntime } from "@finance/core";

const runtime = new FinanceRuntime({
  port: 4132,
  executionMode: "paper",
});

// Register components
runtime.registerAgent(myAgent);
runtime.registerTool(toolDef, toolHandler);
runtime.registerPlugin(pluginInfo, pluginLifecycle);
runtime.registerStrategy(strategyConfig, strategyHandler);

// Start
await runtime.start();

// Health check
const health = await runtime.getHealth();
```

## Event Flow

```
MarketAgent → market.tick → QuantAgent → quant.signal → RiskAgent → risk.approved → PortfolioAgent → order.created → ExecutionAgent → order.filled
```
