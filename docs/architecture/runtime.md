# Finance Agent Runtime — Architecture

## Overview

The **Finance Runtime** is the central orchestrator that manages the lifecycle of all components in the Finance Agent OS platform. It serves as the single composition root — every agent, tool, plugin, strategy, and service is registered with and managed by the runtime.

## Architecture Principles

1. **Runtime as Composition Root** — All components are registered with the `FinanceRuntime`. No module-level singletons for services that have lifecycle.
2. **Event-Driven** — Components communicate through a shared `TypedEventBus`. Agents publish events, other agents subscribe and react.
3. **Phase-Based Lifecycle** — The runtime uses a `LifecycleManager` with ordered phases: CREATED → REGISTERING → INITIALIZING → STARTING → RUNNING → STOPPING → DRAINING → STOPPED.
4. **Typed Events** — Events use a strongly typed bus with history, replay, and wildcard subscription support.
5. **Separation of Concerns** — Agents make decisions, services provide infrastructure, tools expose capabilities.

## Package Structure

```
packages/
  shared/    — Types and models shared across all packages
  core/      — Runtime, Event Bus, Agent base class, Registries
apps/
  server/    — Fastify HTTP server, all finance modules
  dashboard/ — Next.js frontend
```

## Core Package (`@finance/core`)

### FinanceRuntime

The central class that manages the entire platform lifecycle.

```
FinanceRuntime
├── eventBus: TypedEventBus          — shared event infrastructure
├── agentRegistry: AgentRegistry     — manages agent lifecycle
├── toolRegistry: ToolRegistry       — callable tools
├── pluginRegistry: PluginRegistry   — plugin lifecycle
├── strategyRegistry: StrategyRegistry — strategy management
├── serviceRegistry: ServiceRegistry — infrastructure services
├── lifecycle: LifecycleManager      — phase-based startup/shutdown
└── config: ResolvedRuntimeConfig    — resolved configuration
```

**Lifecycle Phases (in order):**
```
CREATED → REGISTERING → INITIALIZING → STARTING → RUNNING
                                                ↓
                                          STOPPING → DRAINING → STOPPED
```

**Startup sequence:** plugins.init → plugins.start → services.init → services.start → agents.start
**Shutdown sequence:** agents.stop → services.stop → plugins.stop (reverse order)

### LifecycleManager

Controls ordered startup/shutdown phases. Features:
- **Phase validation** — prevents illegal transitions
- **Hook system** — register callbacks on specific phase transitions
- **Transition log** — records all phase transitions with timestamps
- **Status queries** — `getPhase()`, `isRunning()`, `isStopped()`

### Runtime Configuration

```typescript
interface RuntimeConfig {
  port?: number;          // Default: 4132
  host?: string;          // Default: "0.0.0.0"
  executionMode?: "paper" | "live";  // Default: "paper"
  logLevel?: "debug" | "info" | "warn" | "error";  // Default: "info"
  version?: string;       // Default: "0.1.0"
  eventBus?: {
    maxHistory?: number;  // Default: 50_000
  };
}
```

### Runtime Status

```typescript
interface RuntimeStatus {
  phase: LifecyclePhase;  // Current lifecycle phase
  running: boolean;       // Is fully operational?
  uptime: number;         // Milliseconds since started
  config: ResolvedRuntimeConfig;
  components: ComponentCounts;  // { agents, tools, plugins, strategies, services }
  eventBusSize: number;
  lifecycleTransitions: number;
}
```

### Runtime Health

```typescript
interface RuntimeHealth {
  status: "healthy" | "degraded" | "unhealthy";  // Aggregate status
  phase: LifecyclePhase;
  uptime: number;
  agents: Record<string, AgentHealth>;
  plugins: PluginInfo[];
  services: ServiceInfo[];
  components: ComponentCounts;
  eventBusSize: number;
}
```

Health computation:
- **healthy** — all agents running, all services active
- **degraded** — any agent stopped or service not yet active, or runtime not in RUNNING phase
- **unhealthy** — any agent or service in error state

### Runtime Events

The runtime publishes lifecycle events to the event bus:

| Event | When |
|-------|------|
| `runtime.starting` | Before startup sequence begins |
| `runtime.started` | After all components started |
| `runtime.stopping` | Before shutdown begins |
| `runtime.stopped` | After all components stopped |
| `runtime.error` | On startup/shutdown error |
| `runtime.health_check` | Periodic health check (future) |

### Component Types

| Component | Role | Examples |
|-----------|------|----------|
| **Agent** | Business logic, signal generation, decision-making | MarketAgent, QuantAgent, RiskAgent, PortfolioAgent, ExecutionAgent |
| **Tool** | Callable capabilities exposed to agents | get_market_price, calculate_rsi, get_portfolio |
| **Plugin** | External data sources with lifecycle | BinanceMarketPlugin |
| **Strategy** | Pluggable trading strategies | EMA Crossover, RSI Reversal, MACD Crossover, Momentum |
| **Service** | Infrastructure with lifecycle | Gateway, AuditLogger, MarketState, PaperBroker, StateRecovery |

### Registries

- `AgentRegistry` — register/unregister/start/stop agents
- `ToolRegistry` — register tools with definitions + handlers
- `PluginRegistry` — register plugins with lifecycle hooks
- `StrategyRegistry` — register strategies with configs + handlers
- `ServiceRegistry` — register services with lifecycle (NEW in Phase 1)

### Event Bus (`TypedEventBus`)

A pub/sub event system with:
- **History** — configurable max history (default 50,000 events)
- **Type subscription** — subscribe to specific event types
- **Wildcard subscription** — patterns like `order.*`
- **Filtered subscription** — filter by source, agent, channel, time range
- **Replay** — replay historical events to a handler
- **Auto-generated IDs** — events get UUID + timestamp automatically

### Event Categories

```
Market:     market.tick, market.candle, market.orderbook, market.trade
Quant:      quant.analysis, quant.signal
Risk:       risk.check, risk.approved, risk.rejected, risk.alert
Portfolio:  portfolio.updated, portfolio.position_changed
Execution:  order.created, order.submitted, order.filled, order.cancelled, order.rejected
Trade:      trade.opened, trade.closed
Agent:      agent.started, agent.stopped, agent.error
System:     system.health, system.error
```

## Server App

### Finance Modules

| Module | Path | Description |
|--------|------|-------------|
| MarketAgent | agents/market/ | Real-time market data via Binance REST + synthetic fallback |
| QuantAgent | agents/quant/ | Technical analysis (SMA, EMA, RSI, MACD, Bollinger) |
| RiskAgent | agents/risk/ | Risk management (exposure, drawdown, VaR, Sharpe) |
| PortfolioAgent | agents/portfolio/ | Position tracking, PnL, allocation |
| ExecutionAgent | agents/execution/ | Order execution (paper + live) |
| FinanceGateway | gateway/ | Central authority between agents and execution |
| StrategyRegistry | strategies/ | Pluggable strategy system (4 built-in strategies) |
| PaperBroker | broker/ | Realistic paper trading simulation |
| BinanceBroker | broker/ | Live trading with safety gates |
| MarketStateService | market/ | Real-time market state tracking |
| BinanceAdapter | market/ | Exchange abstraction |
| BacktestEngine | backtesting/ | Strategy backtesting |
| OrderManager | order-manager/ | Order lifecycle state machine |
| TradeEngine | trade-engine/ | Trade management |
| StateRecovery | state/ | Application persistence and restart recovery |
| AuditLogger | audit/ | Financial audit logging |
| AgentMemory | memory/ | Structured persistent memory |
| EnvValidator | security/ | Environment validation |

### Server Runtime Wiring (`apps/server/src/core/runtime.ts`)

The server runtime is the composition root that:

1. Creates a `FinanceRuntime` instance
2. Registers 5 agents (Market, Quant, Risk, Portfolio, Execution)
3. Registers finance tools
4. Registers the BinanceMarketPlugin
5. Registers 9 services with the runtime:
   - StrategyRegistryService (manages trading strategies)
   - GatewayService (trade request routing)
   - AuditLoggerService (event auditing)
   - MarketStateServiceWrapper (market state tracking)
   - PaperBrokerService (paper trading)
   - StateRecoveryService (persistence)
   - OrderManagerService (order lifecycle)
   - TradeEngineService (trade management)
   - AgentMemoryService (agent memory)

### Service Access Pattern

Services are accessed through typed getter functions that delegate to the runtime:

```typescript
// Access via runtime
const gateway = runtime.getService<GatewayService>("gateway");

// Or via convenience accessor
const gateway = getGateway();
```

All services implement `ServiceLifecycle`:
```typescript
interface ServiceLifecycle {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): ServiceInfo;
}
```

### API Routes

The Fastify server exposes ~30 REST endpoints:

| Route | Method | Description |
|-------|--------|-------------|
| /api/health | GET | Runtime health status |
| /api/agents | GET | List all agents |
| /api/agents/:id/start | POST | Start an agent |
| /api/agents/:id/stop | POST | Stop an agent |
| /api/strategies | GET | List strategies |
| /api/strategies | POST | Register new strategy |
| /api/strategies/:id/toggle | POST | Enable/disable strategy |
| /api/risk/status | GET | Risk metrics |
| /api/risk/metrics | GET | Detailed risk metrics |
| /api/portfolio | GET | Portfolio snapshot |
| /api/portfolio/positions | GET | Current positions |
| /api/portfolio/allocation | GET | Allocation percentages |
| /api/market/ticks | GET | Recent market ticks |
| /api/market/state | GET | Market state snapshot |
| /api/market/candles | GET | Candle data |
| /api/market/orderbook | GET | Order book |
| /api/signals | GET | Recent signals |
| /api/orders | GET | Order history |
| /api/orders/:id | GET | Single order |
| /api/orders/:id/cancel | POST | Cancel order |
| /api/trades | GET | Trade history |
| /api/execution/status | GET | Execution stats |
| /api/state | GET | Full state snapshot |
| /api/events | GET | SSE event stream |
| /api/publish | POST | Publish event |
| /api/gateway/trade | POST | Submit trade via gateway |
| /api/gateway/stats | GET | Gateway statistics |
| /api/audit | GET | Audit records |
| /api/trading/signal | POST | Manual signal |

## Event Flow

```
MarketAgent ──market.tick──► QuantAgent ──quant.signal──► RiskAgent
                                                             │
                                                     risk.approved
                                                     risk.rejected
                                                             │
                                                     PortfolioAgent
                                                     ──order.created──► ExecutionAgent
                                                                        ──order.filled──► PortfolioAgent
                                                                                        ──portfolio.updated──► ...
```

### Gateway Flow (for API-initiated trades)

```
API ──POST /api/gateway/trade──► FinanceGateway
                                      │
                              gateway.trade_request
                                      │
                                RiskAgent evaluates
                                      │
                              risk.approved / risk.rejected
                                      │
                              FinanceGateway forwards
                              order.created → ExecutionAgent
```

## Data Flow Summary

1. **MarketAgent** polls Binance REST API (or generates synthetic ticks)
2. Publishes `market.tick` events
3. **QuantAgent** subscribes to ticks, computes indicators, publishes `quant.signal`
4. **RiskAgent** evaluates signals against risk limits, publishes `risk.approved` or `risk.rejected`
5. **PortfolioAgent** processes approved signals, creates orders (`order.created`)
6. **ExecutionAgent** fills orders, publishes `order.filled`
7. **PortfolioAgent** updates positions, publishes `portfolio.updated`
8. **StateRecovery** persists state to disk
9. **AuditLogger** records all events for compliance
10. **MarketState** maintains real-time market state snapshot

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 4132 | Server port |
| HOST | 0.0.0.0 | Server host |
| EXECUTION_MODE | paper | `paper` or `live` |
| LIVE_TRADING_ENABLED | false | Must be `true` for live orders |
| BINANCE_API_KEY | - | Binance API key |
| BINANCE_SECRET | - | Binance secret |
| NEXT_PUBLIC_API_BASE | http://localhost:4132 | Dashboard API base URL |

## Testing

- **Core package:** Event bus and registry unit tests (22 tests)
- **Server package:** Tools, strategies, risk engine, paper broker, gateway, audit tests (53 tests)
- **E2E:** `test-e2e.mjs` — smoke test against running server
