# Finance Agent OS — Architecture Audit (Phase 0)

**Date:** September 1, 2026
**Version:** 0.1.0
**Status:** Initial Audit

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture](#current-architecture)
3. [What Already Works](#what-already-works)
4. [What Is Incomplete](#what-is-incomplete)
5. [What Is Duplicated](#what-is-duplicated)
6. [What Should Be Preserved](#what-should-be-preserved)
7. [What Should Be Refactored](#what-should-be-refactored)
8. [Missing Backend Capabilities](#missing-backend-capabilities)
9. [Target Architecture](#target-architecture)
10. [Implementation Roadmap](#implementation-roadmap)

---

## Executive Summary

The Finance Agent OS repository contains a **working prototype** of an event-driven finance agent platform. The implementation is more advanced than initially expected:

- **5 fully implemented agents** (Market, Quant, Risk, Portfolio, Execution)
- **EventBus** with history, replay, filtering, and typed events
- **Fastify server** with SSE, REST API, and CORS
- **Real-time market data** (Binance REST API with synthetic fallback)
- **Technical analysis indicators** (SMA, EMA, RSI, MACD, Bollinger Bands)
- **Risk management** with exposure, drawdown, VaR, Sharpe calculations
- **Portfolio management** with position tracking, PnL, Kelly criterion
- **Paper trading execution** with slippage, fees, and latency simulation
- **File-based persistence** (JSON storage under `.data/`)
- **Next.js 14 dashboard** with real-time SSE streaming

### Key Finding

The existing backend is **significantly more functional** than the "incomplete" description suggests. Most Phase 1-14 requirements are already implemented. However, the implementation lacks:

1. Formal abstractions (Agent, Tool, Plugin interfaces)
2. A runtime/registry system
3. Proper testing (zero tests)
4. Type validation (runtime)
5. Governance/gateway layer
6. Real database persistence
7. State recovery on restart
8. Backtesting engine
9. Memory system
10. Comprehensive audit logging

---

## Current Architecture

### Repository Structure

```
finance-agent-os/
├── apps/
│   ├── server/                    # Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point, agent orchestration
│   │   │   ├── core/
│   │   │   │   ├── eventBus.ts    # Typed EventBus with history/replay
│   │   │   │   ├── server.ts      # Fastify server, SSE, REST API
│   │   │   │   └── storage.ts     # File-based JSON persistence
│   │   │   └── agents/
│   │   │       ├── market/        # MarketAgent (Binance REST + synthetic)
│   │   │       ├── quant/         # QuantAgent (SMA/EMA/RSI/MACD/BB)
│   │   │       ├── risk/          # RiskAgent (exposure/drawdown/VaR/Sharpe)
│   │   │       ├── portfolio/     # PortfolioAgent (1% sizing/Kelly)
│   │   │       └── execution/     # ExecutionAgent (paper/live CCXT)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── dashboard/                 # Next.js 14 frontend
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx       # Main dashboard page
│       │   │   ├── layout.tsx     # Root layout with Tailwind CDN
│       │   │   └── globals.css    # Global styles
│       │   ├── components/
│       │   │   ├── MarketChart.tsx # Canvas-based price chart
│       │   │   └── AgentStatus.tsx # Agent status display
│       │   └── lib/
│       │       └── api.ts         # API client, SSE connection
│       ├── package.json
│       └── next.config.mjs        # Proxy /api → :4132
├── docs/                          # Documentation (this file)
├── package.json                   # Root workspace config
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── test-e2e.mjs                   # Basic E2E test script
├── README.md
├── .env.example
├── .gitignore
└── .github/
    └── workflows/
        ├── ci.yml                 # CI: tsc + build
        └── pages.yml              # GitHub Pages deploy
```

### Data Flow (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Dashboard (Next.js)                      │
│  MarketChart • AgentStatus • Event Log • Portfolio Display      │
└──────────────────────┬──────────────────────────────────────────┘
                       │ GET /api/events (SSE)
                       │ GET /api/portfolio
                       │ GET /api/market/ticks
                       │ POST /api/publish
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Fastify Server (:4132)                        │
│  /api/health  /api/events  /api/state  /api/portfolio  /api/publish │
└──────────────────────┬──────────────────────────────────────────┘
                       │ eventBus.subscribe() / publish()
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     EventBus (Singleton)                         │
│  publish() • subscribe() • subscribeFiltered() • replay()       │
│  history[10000] • FinanceEvent {id,type,data,timestamp,...}      │
└──────────────────────┬──────────────────────────────────────────┘
                       │ market:tick → signal:* → risk:* → portfolio:order → execution:filled
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     5 Finance Agents                             │
│  Market → Quant → Risk → Portfolio → Execution                  │
└─────────────────────────────────────────────────────────────────┘
```

### Event Pipeline

```
MarketAgent (polls Binance REST every 2s)
    │
    ▼ publishes: market:tick {symbol, price, change, volume, source}
    │
QuantAgent (subscribes to market:tick)
    │ • accumulates price buffer (100 ticks/symbol)
    │ • computes SMA(7), SMA(25), RSI(14), MACD(12,26,9), Bollinger(20,2)
    │ • confluence scoring: buy/sell/hold
    ▼ publishes: signal:buy | signal:sell | signal:hold {symbol, action, confidence, indicators}
    │
RiskAgent (subscribes to signal:buy, signal:sell)
    │ • exposure check (max 20% per position, max leverage 3x)
    │ • drawdown check (max 10%)
    │ • concentration check (max 20% per symbol)
    │ • confidence threshold (0.6)
    │ • VaR check (max 5% daily loss)
    ▼ publishes: risk:approved | risk:rejected {signal, reason, checks, metrics}
    │
PortfolioAgent (subscribes to risk:approved)
    │ • position sizing: qty = (cash × 0.01) / price (1% risk per trade)
    │ • tracks positions, realized/unrealized PnL
    │ • updates on market:tick for mark-to-market
    ▼ publishes: portfolio:order {symbol, side, qty, price, confidence}
    │
ExecutionAgent (subscribes to portfolio:order)
    │ • validates order
    │ • paper mode: slippage 0.05%, fee 0.1%, latency 100ms
    │ • live mode: CCXT wrapper (Binance, mock if no keys)
    ▼ publishes: execution:filled {orderId, symbol, side, qty, price, fee, mode}
    │
PortfolioAgent (also subscribes to execution:filled)
    • updates positions/cash/PnL
    ▼ publishes: portfolio:update
```

---

## What Already Works

### ✅ EventBus (Phase 2 — Complete)

- **File:** `apps/server/src/core/eventBus.ts`
- **Status:** Fully functional
- **Features:**
  - Typed `FinanceEvent` with id, type, data, timestamp, channelId, threadId, agentId, runId
  - Auto-generates id (UUID) and timestamp if missing
  - `publish()` with validation (type required)
  - `subscribe()` returns unsubscribe function
  - `subscribeFiltered()` with predicate filtering
  - `replay()` for event replay
  - `getHistory()` with filter and limit
  - Event history with configurable max (10,000 default)
  - Subscriber count tracking
  - Error isolation (handler errors don't break bus)

### ✅ Market Agent (Phase 6 — Partial)

- **File:** `apps/server/src/agents/market/`
- **Status:** Functional with caveats
- **Features:**
  - Polls Binance REST API (`/api/v3/ticker/price`) every 2s
  - Synthetic fallback when no API keys or request fails
  - Supports: BTCUSDT, ETHUSDT, EURUSD, AAPL, SPY
  - Publishes `market:tick` events
  - Maintains tick history (1000 max)
  - Has `AGENT.md` documentation

- **Missing:**
  - No WebSocket connection (despite `connectBinanceWS` name — it's synthetic intervals)
  - No candle/ohlcv data
  - No orderbook data
  - No normalized `Ticker`/`Candle`/`OrderBook` models
  - No reconnection logic
  - No stale data detection

### ✅ Quant Agent (Phase 8 — Complete)

- **File:** `apps/server/src/agents/quant/`
- **Status:** Fully functional
- **Features:**
  - Pure indicator functions in `strategies.ts` (SMA, EMA, RSI, MACD, Bollinger)
  - Confluence scoring with 4 indicators
  - Signal generation: buy/sell/hold with confidence 0-1
  - Publishes `signal:buy`, `signal:sell`, `signal:hold`
  - Indicator methods exposed for external use

- **Missing:**
  - No strategy interface (hardcoded indicators)
  - No strategy registry
  - No timeframe support (uses raw tick buffer)
  - No signal expiration

### ✅ Risk Agent (Phase 10 — Complete)

- **File:** `apps/server/src/agents/risk/`
- **Status:** Fully functional
- **Features:**
  - Configurable risk limits (maxPositionPct, maxDrawdownPct, maxDailyLoss, maxLeverage, maxOpenPositions, confidenceThreshold)
  - Exposure calculation
  - Drawdown tracking
  - Concentration limits
  - VaR calculation (95% confidence)
  - Sharpe ratio calculation
  - Publishes `risk:approved` or `risk:rejected`
  - Rejected log with bounded history

- **Missing:**
  - No risk engine abstraction
  - No cooldown mechanism
  - No mandatory stop-loss rules
  - No strategy-specific exposure limits
  - No leverage limit enforcement

### ✅ Portfolio Agent (Phase 12 — Complete)

- **File:** `apps/server/src/agents/portfolio/`
- **Status:** Fully functional
- **Features:**
  - Position tracking (Map<symbol, Position>)
  - Cash management
  - Realized/unrealized PnL calculation
  - Position sizing: 1% risk per trade
  - Kelly criterion implementation
  - Rebalance weights calculation
  - Mark-to-market on `market:tick`
  - Publishes `portfolio:order` and `portfolio:update`

- **Missing:**
  - No persistent state
  - No position history
  - No trade history
  - No fee tracking per position
  - No multi-currency support

### ✅ Execution Agent (Phase 14 — Complete)

- **File:** `apps/server/src/agents/execution/`
- **Status:** Fully functional
- **Features:**
  - Order validation
  - Paper mode: slippage 0.05%, fee 0.1%, latency 100ms
  - Live mode: CCXT wrapper with dynamic import
  - OrderId generation (UUID)
  - Fill tracking with history
  - Rejected order tracking
  - Execution statistics
  - Mode switching (paper/live)

- **Missing:**
  - No order management system (state machine)
  - No order book
  - No trade engine (orders vs trades)
  - No broker adapter abstraction
  - No paper broker with full simulation (limit orders, order history)

### ✅ Fastify Server (Phase 20 — Partial)

- **File:** `apps/server/src/core/server.ts`
- **Status:** Functional
- **Features:**
  - CORS enabled
  - `GET /api/health` — uptime, version
  - `GET /api/events` — SSE with filtering, replay, heartbeat (15s), lastEventId
  - `POST /api/publish` — publish custom events
  - `GET /api/state` — channels, threads, messages, recentEvents
  - `GET /api/portfolio` — mock portfolio data
  - `GET /api/market/ticks` — mock tick data
  - 404 handler
  - Error handler

- **Missing:**
  - Most endpoints return mock/hardcoded data
  - No request validation (Zod)
  - No authentication
  - No rate limiting
  - No structured error responses
  - No API versioning

### ✅ Dashboard (Phase 25 — Partial)

- **File:** `apps/dashboard/`
- **Status:** Functional UI
- **Features:**
  - Next.js 14 with Tailwind CDN
  - Real-time SSE event streaming
  - Market chart (Canvas-based)
  - Agent status display
  - Portfolio summary
  - Risk metrics display
  - Positions table
  - Signals feed
  - Event log
  - Auto-polling for ticks/portfolio (5s/7s intervals)

- **Issues:**
  - Portfolio endpoint returns hardcoded mock data
  - Market ticks endpoint returns mock data
  - AgentStatus uses hardcoded agent list
  - Some fallback values hardcoded in JSX
  - Uses Tailwind CDN (not recommended for production)

---

## What Is Incomplete

### ❌ Core Runtime (Phase 1)

- No `Agent` interface/abstract class
- No `Tool` interface
- No `Plugin` interface
- No `Service` interface
- No service registry
- No agent registry
- No plugin registry
- No tool registry
- No health monitoring
- No dependency injection

### ❌ Agent Framework (Phase 3)

- No base Agent class
- No lifecycle management (start/stop/restart)
- No health checks
- No capability registration
- Agents are ad-hoc classes with inconsistent interfaces

### ❌ Tool System (Phase 4)

- No tool abstraction
- No tool registry
- No input/output schemas
- No permission system
- Tools are hardcoded in agent methods

### ❌ Plugin System (Phase 5)

- No plugin architecture
- No plugin registry
- No plugin lifecycle
- All functionality is monolithic

### ❌ Exchange Adapter (Phase 6)

- No `ExchangeAdapter` abstraction
- No normalized models (Ticker, Candle, OrderBook, Trade)
- No reconnection logic
- No stale data detection
- No duplicate detection

### ❌ Market State (Phase 7)

- No Market State service
- No real-time state tracking
- No historical data storage
- No retention strategy

### ❌ Strategy Registry (Phase 9)

- No strategy interface
- No strategy registry
- No strategy enable/disable
- No strategy configuration
- Indicators are hardcoded

### ❌ Finance Gateway (Phase 11)

- No gateway between agents and execution
- No permission evaluation
- No audit trail
- Agents can directly trigger execution

### ❌ Order Management (Phase 13)

- No order state machine
- No order lifecycle events
- No order book
- Orders are simple data objects

### ❌ Trade Engine (Phase 15)

- No trade abstraction
- No trades separate from orders
- No entry/exit tracking
- No trade PnL calculation

### ❌ Database/Persistence (Phase 16)

- File-based JSON storage only
- No database (PostgreSQL)
- No ORM (Prisma)
- No migrations
- No models for: User, Account, Exchange, Strategy, Signal, etc.

### ❌ State Recovery (Phase 17)

- No state persistence
- Application state is in-memory only
- Restart loses all data

### ❌ Memory System (Phase 18)

- No agent memory
- No historical decisions
- No research storage

### ❌ Backtesting Engine (Phase 19)

- No backtesting framework
- No historical data loading
- No simulation mode
- No performance metrics

### ❌ Audit System (Phase 22)

- No audit logging
- No event recording
- No compliance trail

### ❌ Security (Phase 23)

- No authentication
- No authorization
- API secrets potentially exposed
- No input validation

---

## What Is Duplicated

### 1. Agent Status

- `AgentStatus.tsx` has hardcoded agent list
- No server-side agent registry to query
- Dashboard can't display real agent status

### 2. Portfolio Data

- `server.ts` has `mockPortfolio()` returning hardcoded data
- `PortfolioAgent` has real portfolio state in memory
- Endpoint doesn't use real PortfolioAgent state

### 3. Market Ticks

- `server.ts` has `mockTicks()` returning random data
- `MarketAgent` has real tick data in memory
- Endpoint doesn't use real MarketAgent data

### 4. Position Types

- `PortfolioAgent` defines `Position` interface
- `RiskAgent` defines its own `Position` interface
- Different structures for same concept

### 5. Order Types

- `PortfolioAgent` defines `Order` interface
- `ExecutionAgent` defines its own `Order` interface
- Different structures for same concept

---

## What Should Be Preserved

### 1. EventBus Implementation

The EventBus is well-designed and should be preserved. It needs:
- Type-safe event categories (Phase 2 enhancement)
- Validation schema

### 2. Indicator Functions

The pure functions in `strategies.ts` (SMA, EMA, RSI, MACD, Bollinger) are correct and should be preserved in the quant engine.

### 3. Risk Metrics

The pure functions in `metrics.ts` (exposure, drawdown, VaR, Sharpe) are correct and should be preserved.

### 4. Allocation Helpers

The pure functions in `allocation.ts` (Kelly criterion, position sizing, rebalance) are correct and should be preserved.

### 5. Dashboard UI

The dashboard is well-designed visually and should be preserved. It needs:
- Real data integration
- Remove hardcoded fallbacks

### 6. SSE Implementation

The SSE implementation is solid with filtering, replay, heartbeat, and lastEventId support.

---

## What Should Be Refactored

### 1. Agent Architecture

Current: Ad-hoc classes with inconsistent interfaces
Target: Base `Agent` class with lifecycle, health, capabilities

### 2. Event Types

Current: String-based event types (`"market:tick"`)
Target: Typed event categories with validation

### 3. Data Models

Current: Inline interfaces scattered across agents
Target: Centralized models in `packages/shared`

### 4. Server Endpoints

Current: Mock data in some endpoints
Target: Real data from agent registries

### 5. Configuration

Current: Environment variables scattered
Target: Centralized config with validation

---

## Missing Backend Capabilities

### Priority 1 (Core Platform)

| Capability | Status | Phase |
|------------|--------|-------|
| Agent Registry | Missing | Phase 3 |
| Plugin Registry | Missing | Phase 5 |
| Tool Registry | Missing | Phase 4 |
| Finance Gateway | Missing | Phase 11 |
| State Persistence | File-only | Phase 16 |
| State Recovery | Missing | Phase 17 |

### Priority 2 (Financial Safety)

| Capability | Status | Phase |
|------------|--------|-------|
| Order Management | Basic | Phase 13 |
| Paper Broker | Basic | Phase 14 |
| Risk Engine | Basic | Phase 10 |
| Audit Logging | Missing | Phase 22 |
| Security/Auth | Missing | Phase 23 |

### Priority 3 (Trading Features)

| Capability | Status | Phase |
|------------|--------|-------|
| Exchange Adapter | Missing | Phase 6 |
| Market State | Missing | Phase 7 |
| Strategy Registry | Missing | Phase 9 |
| Backtesting | Missing | Phase 19 |
| Trade Engine | Missing | Phase 15 |

### Priority 4 (Advanced)

| Capability | Status | Phase |
|------------|--------|-------|
| Memory System | Missing | Phase 18 |
| Windows Support | Partial | Phase 26 |
| Testing | Missing | Phase 27 |
| Documentation | Partial | Phase 28 |

---

## Target Architecture

```
                    WINDOWS FINANCE APP
                            │
             ┌──────────────┼──────────────┐
             ↓              ↓              ↓
         Dashboard       Terminal        REST API
             │              │              │
             └──────────────┼──────────────┘
                            ↓
                   FINANCE RUNTIME
                            │
          ┌─────────────────┼─────────────────┐
          ↓                 ↓                 ↓
       AGENTS             TOOLS            PLUGINS
          │                 │                 │
     ┌────┼────┐            │        ┌────────┼────────┐
     ↓    ↓    ↓            │        ↓        ↓        ↓
   Quant Risk Portfolio     │    Binance   Market   Research
     ↓    ↓    ↓            │
   Execution Research       │
     │                      │
     └──────────┬───────────┘
                ↓
             EVENT BUS
                ↓
        FINANCE GATEWAY
                ↓
         RISK / GOVERNANCE
                ↓
          EXECUTION LAYER
           ┌────┴────┐
           ↓         ↓
        PAPER     LIVE BROKER
        BROKER       │
                     ↓
                  Binance
```

### Component Responsibilities

#### Finance Runtime
- Application lifecycle
- Configuration management
- Dependency injection
- Service registry
- Health monitoring
- Logging

#### Agents
- **Market Agent**: Market data collection (REST, WebSocket)
- **Quant Agent**: Technical analysis, signal generation
- **Risk Agent**: Risk assessment, trade approval/rejection
- **Portfolio Agent**: Position management, PnL tracking
- **Execution Agent**: Order execution (paper/live)
- **Research Agent**: Market research, news analysis (future)
- **Backtest Agent**: Strategy backtesting (future)

#### Tools
- Market data tools (getCandles, getTicker, getOrderBook)
- Analysis tools (calculateRSI, calculateMACD, etc.)
- Portfolio tools (getPositions, calculatePnL, etc.)
- Execution tools (placeOrder, cancelOrder, etc.)

#### Plugins
- Exchange plugins (Binance, Bybit, OKX)
- Data source plugins (News, On-chain, Economic Calendar)
- Analysis plugins (Technical Analysis, Fundamental Analysis)

#### Event Bus
- Strongly typed events
- Event validation
- Event history
- Event replay
- Event filtering

#### Finance Gateway
- Agent permission evaluation
- Tool permission evaluation
- Risk rule enforcement
- Execution mode validation
- Audit logging

#### Risk Engine
- Position size limits
- Exposure limits
- Drawdown limits
- Daily loss limits
- Leverage limits
- Cooldown enforcement

#### Execution Layer
- Paper Broker (default)
- Live Broker (opt-in)
- Order management
- Trade management

---

## Event Flow

### Market Data Flow

```
Binance REST API
       │
       ▼
MarketAgent
       │ publishes: market.tick
       ▼
EventBus
       │
       ├──→ QuantAgent (for signal generation)
       ├──→ PortfolioAgent (for mark-to-market)
       └──→ Dashboard (via SSE)
```

### Signal Flow

```
MarketAgent
       │ publishes: market.tick
       ▼
QuantAgent
       │ computes indicators
       │ generates signal
       │ publishes: signal.buy | signal.sell | signal.hold
       ▼
EventBus
       │
       ├──→ RiskAgent (for risk assessment)
       └──→ Dashboard (via SSE)
```

### Execution Flow

```
QuantAgent
       │ publishes: signal.buy
       ▼
RiskAgent
       │ evaluates risk
       │ publishes: risk.approved | risk.rejected
       ▼
EventBus
       │
       ├──→ PortfolioAgent (on risk.approved)
       │         │
       │         │ computes position size
       │         │ publishes: portfolio.order
       │         ▼
       │    EventBus
       │         │
       │         ▼
       │    ExecutionAgent
       │         │ validates order
       │         │ executes (paper/live)
       │         │ publishes: execution.filled
       │         ▼
       │    EventBus
       │         │
       │         ▼
       │    PortfolioAgent
       │         │ updates positions
       │         │ updates PnL
       │         │ publishes: portfolio.update
       │         ▼
       │    Dashboard (via SSE)
       │
       └──→ Dashboard (via SSE)
```

---

## Implementation Roadmap

### Phase 1: Core Runtime (1-2 days)
- Define Agent, Tool, Plugin, Service interfaces
- Create FinanceRuntime class
- Create registries (Agent, Plugin, Tool)
- Add health monitoring
- Add configuration management

### Phase 2: Event Bus Enhancement (1 day)
- Add typed event categories
- Add event validation (Zod)
- Add event metadata (correlationId)
- Enhance tests

### Phase 3: Agent Framework (1-2 days)
- Create base Agent class
- Refactor existing agents to use base class
- Add lifecycle management
- Add capability registration

### Phase 4: Tool System (1 day)
- Create Tool interface
- Implement finance tools
- Create ToolRegistry
- Add input/output validation

### Phase 5: Plugin System (1 day)
- Create Plugin interface
- Create PluginRegistry
- Refactor Binance code into plugin
- Add plugin lifecycle

### Phase 6: Exchange Adapter (2 days)
- Create ExchangeAdapter interface
- Normalize market data models
- Implement BinanceAdapter
- Add reconnection logic

### Phase 7: Market State (1 day)
- Create MarketState service
- Track real-time prices
- Track historical candles
- Add stale data detection

### Phase 8: Quant Engine (1-2 days)
- Create Strategy interface
- Refactor indicators as strategies
- Add strategy parameters
- Add signal expiration

### Phase 9: Strategy Registry (1 day)
- Create StrategyRegistry
- Add strategy enable/disable
- Add strategy configuration

### Phase 10: Risk Engine (1-2 days)
- Enhance RiskAgent
- Add mandatory stop-loss
- Add cooldown mechanism
- Add strategy exposure limits

### Phase 11: Finance Gateway (2 days)
- Create FinanceGateway
- Add permission evaluation
- Add audit logging
- Integrate with execution

### Phase 12: Portfolio Engine (1 day)
- Refactor PortfolioAgent
- Add position history
- Add trade tracking
- Add fee tracking

### Phase 13: Order Management (1-2 days)
- Create OrderManager
- Add order state machine
- Add order lifecycle events

### Phase 14: Paper Broker (1 day)
- Create BrokerAdapter interface
- Enhance PaperBroker
- Add order history
- Add trade history

### Phase 15: Trade Engine (1 day)
- Create TradeManager
- Separate orders from trades
- Add entry/exit tracking
- Add trade PnL calculation

### Phase 16: Database (2-3 days)
- Set up PostgreSQL + Prisma
- Create database schema
- Implement migrations
- Migrate file storage to database

### Phase 17: State Recovery (1 day)
- Implement state persistence
- Add state reconstruction
- Test restart scenarios

### Phase 18: Memory System (1-2 days)
- Create MemoryManager
- Add structured memory
- Add decision history

### Phase 19: Backtesting (2-3 days)
- Create BacktestEngine
- Add historical data loading
- Add simulation mode
- Add performance metrics

### Phase 20: SSE Enhancement (1 day)
- Add event filtering
- Add replay support
- Add reconnection logic

### Phase 21: REST API (1-2 days)
- Implement all API endpoints
- Add request validation
- Add response validation
- Add error handling

### Phase 22: Audit System (1 day)
- Create AuditLogger
- Add event recording
- Add compliance trail

### Phase 23: Security (1-2 days)
- Add authentication
- Add authorization
- Add input validation
- Protect secrets

### Phase 24: Live Binance Adapter (1-2 days)
- Implement BinanceBroker
- Add safety checks
- Add execution mode validation

### Phase 25: Dashboard Integration (1-2 days)
- Connect to real backend data
- Remove hardcoded fallbacks
- Add real-time updates

### Phase 26: Windows Support (1 day)
- Ensure cross-platform compatibility
- Test on Windows
- Add Windows-specific docs

### Phase 27: Testing (2-3 days)
- Add unit tests for all components
- Add integration tests
- Add E2E tests
- Add failure scenario tests

### Phase 28: Documentation (1-2 days)
- Update README.md
- Create all docs files
- Add API documentation
- Add development guide

---

## Summary

The existing codebase is a solid foundation. The main gaps are:

1. **Formal abstractions** (Agent, Tool, Plugin interfaces)
2. **Registry system** (for agents, tools, plugins)
3. **Governance layer** (Finance Gateway)
4. **Persistence** (database, state recovery)
5. **Testing** (currently zero tests)
6. **Documentation** (partially complete)

The implementation should focus on:
1. Preserving working code
2. Adding formal abstractions
3. Connecting components via registries
4. Adding persistence and recovery
5. Comprehensive testing

**Estimated effort:** 25-35 days for full implementation.

---

*Generated by Finance Agent OS Architecture Audit — Phase 0*
