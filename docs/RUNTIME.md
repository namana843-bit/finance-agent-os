# Finance Runtime

The Finance Runtime is the central orchestrator of the Finance Agent Platform. It manages the lifecycle of all agents, tools, plugins, and strategies.

## Architecture

```
FinanceRuntime
├── TypedEventBus        — Event-driven communication
├── AgentRegistry        — Manages all finance agents
├── ToolRegistry         — Registers callable tools
├── PluginRegistry       — Manages plugin lifecycle
├── StrategyRegistry     — Strategy configuration & signals
├── FinanceGateway       — Governance between agents and execution
├── AuditLogger          — Records all events for compliance
├── MarketStateService   — Real-time market state tracking
├── StateRecovery        — Persist/restore state across restarts
└── PaperBroker          — Paper trading execution
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
