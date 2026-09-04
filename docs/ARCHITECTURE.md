# Finance Agent OS — Architecture (Current)

**Date:** September 4, 2026
**Version:** 0.5.0
**Status:** Live — Desktop OS + Supervisor + Finance Environment + Strategy Lab + Execution Pipeline
**Stack:** `@finance/core` + `@finance/shared` · Fastify + TypedEventBus · Next.js 14 desktop · Paper (live gated)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Repository Structure (Actual)](#repository-structure-actual)
3. [Target Architecture — Complete OS](#target-architecture--complete-os)
4. [Finance Runtime (Composition Root)](#finance-runtime-composition-root)
5. [Core Platform](#core-platform)
6. [Agents (6)](#agents-6)
7. [Finance Environment (OpenMausBot-inspired)](#finance-environment-openmausbot-inspired)
8. [Tools — Provider Abstraction](#tools--provider-abstraction)
9. [Strategy Lab](#strategy-lab)
10. [Execution Pipeline](#execution-pipeline)
11. [Desktop OS (OpenMausBot-inspired)](#desktop-os-openmausbot-inspired)
12. [Event Flows](#event-flows)
13. [What Already Works](#what-already-works)
14. [What Is Incomplete / Next](#what-is-incomplete--next)
15. [Implementation Notes](#implementation-notes)

---

## Executive Summary

Finance Agent OS is now a **complete finance-focused agent OS** in the OpenMausBot lineage — not a dashboard over mocks.

* **Desktop OS** (`apps/dashboard/src/components/desktop/`) — 3-column OpenMausBot shell: Chat/Task → Agent Workspace → Tool Activity → Market / Strategy / Portfolio / Risk / Paper / Terminal. Talks only to the real backend via `GET /api/*`, `POST /api/publish` (supervisor.task + terminal.command) and `GET /api/events` SSE (`useFinanceEvents`).
* **SupervisorAgent** (`apps/server/src/agents/supervisor/`) — deterministic planner `task → plan` (e.g. `"Analyze BTC"` → Market → Research → Strategy → Risk → Final) validates against `AgentRegistry`/`ToolRegistry`, publishes `supervisor.plan_created`/`supervisor.step_started|completed|failed`, and for trade steps routes through the **Execution Pipeline** with `correlationId = plan.id` so permissions/audit/Risk are never bypassed.
* **Finance Environment** (`apps/server/src/environment/`) — `MarketDataPort + PortfolioPort + PaperTradingPort + BacktestPort` behind `FinanceEnvironment` → `BinanceMarketDataAdapter` (read-only `BinanceAdapter`) + `PaperTradingAdapter` (wraps `PaperBroker`, paper-only assert). `createFinanceEnvironment({bus, mode:'paper'})` / `createTestEnvironment()` via `ServiceLifecycle id finance-environment`.
* **Strategy Lab** (`apps/server/src/strategy-lab/`) — `Strategy Idea → Strategy → Backtest → Performance → Risk → Paper Candidate`. Modular `strategy-factory` (`ema-crossover|rsi-reversal|macd-crossover|momentum` via shared SMA/EMA/RSI/MACD helpers), `BacktestEngine` reuse (or `market.getOHLCV` or `syntheticCandles`), pure `analyzePerformance`/`analyzeRisk`, orchestrator `StrategyLab` + `StrategyLabService`.
* **Execution Pipeline** (`apps/server/src/execution-pipeline/`) — `Signal → Risk → Permission → Paper → Result` with audit logging, validation, and `LIVE_TRADING_ENABLED=false` default (paper only). `validateSignal` + `checkPermission` (gateway + per-symbol/day limits) + `PipelineAuditLog` → `AuditLogger`, stages `pipeline.*` on `TypedEventBus`, daily counts.
* **Finance Tools** (`apps/server/src/tools/finance-tools.ts` + `providers/`) — exchange-agnostic: `createExchangeProvider` → `MemoryProvider` (tests/synthetic) | `BinanceProvider` (live read). Market (price/ohlcv/orderbook), portfolio (snapshot/balance/positions), indicators (SMA/EMA/RSI/MACD/Bollinger) + utility (validate-symbol/format-money/event-log). All via `ToolRegistry`.
* **Reliability/Observability** — `FinanceRuntime` lifecycle `CREATED→REGISTERING→INITIALIZING→STARTING→RUNNING→STOPPING→DRAINING→STOPPED`, health aggregation, 50k bus history, `RuntimeEvents`, SSE heartbeat, `PaperBroker` single truth, `AuditLogger` + pipeline audit, pipeline/risk/gateway events surfaced in desktop `ToolActivity`/`RiskPanel`/`PaperTradingPanel`/`TerminalPanel`.

Reused, not rewritten: `TypedEventBus` singleton, 5 finance agents (Market/Quant/Risk/Portfolio/Execution), `BacktestEngine`, `RiskEngine`, `PaperBroker`, `FinanceGateway`, `MarketStateService`, `AgentMemory`, `OrderManager`/`TradeEngine`, `StateRecovery`, `AuditLogger`.

---

## Repository Structure (Actual)

```
finance-agent-os/
├── packages/
│   ├── core/src/               # @finance/core — runtime, bus, registries, lifecycle
│   │   ├── agent.ts            # BaseAgent (id/name/version/capabilities, idle→running→stopped)
│   │   ├── event-bus.ts        # TypedEventBus (publish/subscribe/getHistory/replay, source/correlationId)
│   │   ├── registries.ts       # AgentRegistry / ToolRegistry / PluginRegistry / StrategyRegistry / ServiceRegistry
│   │   ├── lifecycle.ts        # LifecycleManager (CREATED…STOPPED)
│   │   ├── runtime.ts          # FinanceRuntime (composition, start/stop, getHealth/getStatus)
│   │   └── index.ts
│   └── shared/src/             # @finance/shared — types, ToolDefinition/StrategyConfig/PluginInfo
├── apps/
│   ├── server/src/
│   │   ├── core/
│   │   │   ├── runtime.ts      # createRuntime() composition root — SERVICE_IDS + get* accessors
│   │   │   ├── server.ts       # Fastify + SSE (/api/events), REST (/api/health|agents|portfolio|market|signals|orders|trades|strategies|backtest|risk|execution|gateway|audit|publish|events)
│   │   │   ├── eventBus.ts     # shim re-export of packages/core TypedEventBus
│   │   │   └── storage.ts
│   │   ├── agents/
│   │   │   ├── market/         # MarketAgent (Binance REST 2s + synthetic fallback, market.tick)
│   │   │   ├── quant/          # QuantAgent (SMA/EMA/RSI/MACD/Bollinger, confluence → quant.signal buy/sell)
│   │   │   ├── risk/           # RiskAgent (exposure/drawdown/VaR/Sharpe/concentration, risk.approved|rejected)
│   │   │   ├── portfolio/      # PortfolioAgent (positions/PnL/Kelly/rebalance, portfolio.order|updated)
│   │   │   ├── execution/      # ExecutionAgent (paper/live CCXT, execution.filled)
│   │   │   └── supervisor/     # SupervisorAgent — planner.ts (extractSymbol/extractQuantity/classify, buildAnalyze/Trade/Portfolio/Backtest/Generic) + index.ts (plan/validate/executePlan, setExecutionPipeline → ExecutionPipeline)
│   │   ├── environment/        # FinanceEnvironment (OpenMausBot-inspired)
│   │   │   ├── types.ts        # MarketDataPort/PortfolioPort/PaperTradingPort/BacktestPort/FinanceEnvironment
│   │   │   ├── finance-environment.ts # FinanceEnvironmentImpl + BacktestEngine wiring
│   │   │   ├── adapters/binance-market-data.adapter.ts # BinanceMarketDataAdapter → BinanceAdapter
│   │   │   ├── adapters/paper-trading.adapter.ts       # PaperTradingAdapter → PaperBroker (paper-only guard)
│   │   │   ├── index.ts        # createFinanceEnvironment / createTestEnvironment
│   │   │   └── service.ts      # FinanceEnvironmentService (ServiceLifecycle)
│   │   ├── strategy-lab/       # Strategy Lab
│   │   │   ├── types.ts        # StrategyIdea/LabConfig/PerformanceAnalysis/RiskAnalysis/PaperCandidate/LAB_EVENTS
│   │   │   ├── strategy-factory.ts # LAB_BUILDERS + createStrategyFromIdea (lab:<id>:<kind>)
│   │   │   ├── performance.ts  # analyzePerformance (profitFactor/expectancy verdict)
│   │   │   ├── risk-analysis.ts# analyzeRisk (7 checks → APPROVED/REJECTED riskScore)
│   │   │   ├── strategy-lab.ts # StrategyLab submitIdea→toStrategy→backtest→performance→risk→candidate + bus events
│   │   │   ├── service.ts      # StrategyLabService
│   │   │   └── index.ts
│   │   ├── execution-pipeline/ # Signal → Risk → Permission → Paper → Result
│   │   │   ├── types.ts        # PipelineSignal/PipelineConfig/PipelineResult/AuditEntry/PIPELINE_EVENTS
│   │   │   ├── validation.ts   # validateSignal + validateNotional
│   │   │   ├── permission.ts   # checkPermission (gateway + daily/per-symbol limits)
│   │   │   ├── audit.ts        # PipelineAuditLog (bus pipeline.audit.*)
│   │   │   ├── pipeline.ts     # ExecutionPipeline (riskAgent.evaluate → gateway → paperBroker → audit)
│   │   │   ├── service.ts      # ExecutionPipelineService
│   │   │   └── index.ts
│   │   ├── tools/              # Finance tools via ToolRegistry (registerAllTools)
│   │   │   ├── finance-tools.ts# registry wiring (21 tools: market 6 + portfolio 3 + indicators 6 + utility 3 + legacy)
│   │   │   ├── price.ts / ohlcv.ts / orderbook.ts / portfolio.ts / indicators.ts
│   │   │   ├── validateSymbol.ts / formatMoney.ts / eventLog.ts
│   │   │   └── ...
│   │   ├── providers/          # Exchange-agnostic provider (exchange code stays separate)
│   │   │   ├── types.ts        # ExchangeProvider (getPrice/getOHLCV/getOrderBook/getBalance …)
│   │   │   ├── memory-provider.ts # in-memory/synthetic (tests, syntheticCandles)
│   │   │   ├── binance-provider.ts
│   │   │   └── index.ts        # createExchangeProvider(mode)
│   │   ├── market/             # ExchangeAdapter + MarketStateService
│   │   ├── strategies/         # StrategyRegistry + default strategies (SMA/EMA/RSI/MACD/BB)
│   │   ├── risk-engine/        # RiskEngine (pure metrics, called by RiskAgent)
│   │   ├── broker/             # PaperBroker + BinanceBroker (+ ccxtWrapper)
│   │   ├── order-manager/      # OrderManager state machine
│   │   ├── trade-engine/       # TradeEngine (orders ≠ trades)
│   │   ├── backtesting/        # BacktestEngine (historical simulation)
│   │   ├── memory/             # AgentMemory (structured persistence)
│   │   ├── audit/              # AuditLogger (bus audit.*)
│   │   ├── gateway/            # FinanceGateway (permissions, executionMode, live guard)
│   │   ├── plugins/binance-plugin.ts # BinanceMarketPlugin (lifecycle)
│   │   ├── adapters/binance-ws.ts
│   │   ├── persistence/prisma.ts + prisma/schema.prisma
│   │   ├── state/state-recovery.ts
│   │   └── security/env-validator.ts
│   │   ├── index.ts            # entry, starts runtime + Fastify
│   │   └── __tests__/          # market-data-tools, portfolio-and-indicators, risk-engine, strategies, paper-broker, gateway-audit-memory, finance-environment, supervisor, strategy-lab, execution-pipeline, tools, utility-tools
│   └── dashboard/src/          # Next.js 14
│       ├── app/page.tsx        # <DesktopShell />
│       ├── components/
│       │   ├── desktop/
│       │   │   ├── Shell.tsx        # 3-col overview + tabs (overview/market/strategy/portfolio/risk/paper/terminal), health/SSE bar
│       │   │   ├── ChatPanel.tsx    # task input → desktop-api.supervisorTask → POST /api/publish supervisor.task (+ quick prompts)
│       │   │   ├── AgentWorkspace.tsx # AgentStatus + supervisor plan trace (supervisor.plan_created/step_*)
│       │   │   ├── ToolActivity.tsx # tool.* + supervisor.* stream
│       │   │   ├── MarketPanel.tsx  # tickers + MarketChart + MarketMeta
│       │   │   ├── StrategyPanel.tsx# BacktestPanel + strategy-lab.* stream
│       │   │   ├── PortfolioPanel.tsx # holdings table (GET /api/portfolio)
│       │   │   ├── RiskPanel.tsx    # exposure/drawdown + risk.* stream + GET /api/risk/status
│       │   │   ├── PaperTradingPanel.tsx # GET /api/execution/status + pipeline.* + OrdersPanel + TradeForm
│       │   │   └── TerminalPanel.tsx# CLI → terminal.command, audit/risk views
│       │   ├── MarketChart.tsx / MarketMeta.tsx / AgentStatus.tsx / BacktestPanel.tsx / OrdersPanel.tsx / TradeForm.tsx
│       │   └── lib/
│       │       ├── api.ts           # API_BASE, fetchPortfolio/fetchTicks/fetchHealth/connectEvents (SSE)
│       │       ├── desktop-api.ts   # publishEvent/supervisorTask/terminalCommand/fetchRisk/Gateway/Execution
│       │       └── useFinanceEvents.ts # hook wrapping connectEvents (connected + buffer)
│       └── next.config.mjs (proxy /api → :4132)
├── docs/
│   ├── ARCHITECTURE.md (this file) · API.md · AGENTS.md · EVENTS.md · RUNTIME.md · STRATEGIES.md · RISK.md · EXECUTION.md · SECURITY.md · DEVELOPMENT.md
│   └── architecture/
├── scripts/verify-honesty.mjs  # ticks source, candles/orderbook synthetic flag, orders/trades, backtest honesty
├── prisma/schema.prisma
└── .github/workflows/ci.yml
```

---

## Target Architecture — Complete OS

```
                         User
                          │
                 Desktop OS (Next.js, SSE)
                 Chat → supervisor.task → Terminal
                          │ POST /api/publish  GET /api/*  GET /api/events
                          ▼
                   Fastify (:4132)
                          │
                    FinanceRuntime (@finance/core)
   ┌──────────────────────┼──────────────────────────────────────────┐
   │                      │                                          │
 AGENTS                 TOOLS                                   SERVICES
   │                      │                                          │
 ┌─┼────────────┐   ToolRegistry (21)                     ┌─────────┴─────────┐
 │ │            │    price/ohlcv/orderbook                 │                   │
Market Quant  Risk   portfolio/indicators/utility          FinanceGateway   AuditLogger
 │   │    │     │    (via ExchangeProvider)                MarketState  PaperBroker
 Portfolio Execution  memory ↔ binance                     StateRecovery OrderManager
   │      │        ↕                                      TradeEngine AgentMemory
 Supervisor◄───────▶Finance Environment◄────────────────── StrategyRegistry
   │ plan │     adapters                                   FinanceEnvironment◄──┐
   │      │  BinanceMarketData ─┐   PaperTrading ─┐       StrategyLab         │
   │      └────►BacktestEngine◄─┴──► PaperBroker  │       ExecutionPipeline───┘
   │             market.getOHLCV  validation/audit │            │
   └─────────────── correlationId ─────────────────┘            │
                          │                                     │
                       EVENT BUS (TypedEventBus, 50k, replay, filtered)
                          │                                     │
                    FinanceGateway                               │
                     Risk/Governance                             │
                          │                                     │
                    Execution Layer                               │
                     ┌────┴────┐                                 │
                     ▼         ▼                                 │
                  PAPER     LIVE BROKER (gated LIVE_TRADING_ENABLED)
                  BROKER       │
                               ▼
                            Binance
```

**Component responsibilities — see [Current Architecture] preserved sections + additions below.**

---

## Finance Runtime (Composition Root)

`apps/server/src/core/runtime.ts:400 createRuntime()` is the **single composition root** (`SERVICE_IDS` canonical). Creates `FinanceRuntime({port, host, executionMode})` → `TypedEventBus` → registers in order: 6 agents (Market, Quant, `riskAgent` captured, Portfolio, Execution, **Supervisor** with `bus+agentRegistry+toolRegistry`) → `registerAllTools(runtime)` (21) → `BinanceMarketPlugin` → services: `StrategyRegistryService` (then mirrors into `runtime.registerStrategy`), `GatewayService`, `AuditLoggerService`, `MarketStateServiceWrapper`, `PaperBrokerService`, `StateRecoveryService`, `OrderManagerService`, `TradeEngineService`, `AgentMemoryService`, **`FinanceEnvironmentService`(`createFinanceEnvironment({bus, mode:'paper', strategyRegistry})`)**, **`StrategyLabService`({bus, strategyRegistry, market: financeEnv.market})**, **`ExecutionPipelineService`({bus, riskAgent, gateway, paperBroker, auditLogger})** → **`supervisor.setExecutionPipeline(executionPipelineService.getInstance())`** to close the loop. Exports `getRuntime/getGateway/getPaperBroker/getMarketState/getFinanceEnvironment/getSupervisor/getStrategyLab/getExecutionPipeline`.

`packages/core/src/runtime.ts:166 FinanceRuntime` owns `TypedEventBus + 5 registries + LifecycleManager`, `start()` advances `REGISTERING→INITIALIZING(→ plugins/services initialize/start)→STARTING(→ agents start)→RUNNING`, `stop()` is `STOPPING→DRAINING→STOPPED`, `getStatus/getHealth` aggregates phase/running/uptime/components/busSize, `computeAggregateStatus` folds agent/service health.

---

## Core Platform

* **TypedEventBus** `packages/core/src/event-bus.ts` — `publish({type,data,source,correlationId})` → `{id,timestamp}` + history (`maxHistory 50_000`), `subscribe/subscribeFiltered`, `replay`, `getHistory`, SSE fan-out. Canonical bus is `@finance/core`; `apps/server/src/core/eventBus.ts` is shim.
* **Registries** `packages/core/src/registries.ts` — `AgentRegistry(startAll/stopAll/health)`, `ToolRegistry(register/execute/list, tool.* bus events)`, `PluginRegistry(initializeAll/startAll)`, `StrategyRegistry(register/toggle/list/get/calculate)`, `ServiceRegistry(register/initializeAll/startAll/listInfo)`.
* **Lifecycle** `packages/core/src/lifecycle.ts` — 8-phase `CREATED→REGISTERING→INITIALIZING→STARTING→RUNNING→STOPPING→DRAINING→STOPPED` with guarded `advance/transitionTo`.
* **Server** `apps/server/src/core/server.ts` — Fastify CORS, `GET /api/health|agents|strategies|risk/status|portfolio|portfolio/positions|market/ticks|candles|orderbook|market/state|signals|orders|trades|execution/status|gateway/stats|state|audit`, `POST /api/publish`, `POST /api/gateway/trade`, `POST /api/backtest/run`, `GET /api/events` SSE (filter/replay/heartbeat 15s/lastEventId), 404/error handlers.
* **Security** `apps/server/src/security/env-validator.ts` — validates `PORT 1-65535`, `EXECUTION_MODE paper|live`, live fails fast unless `LIVE_TRADING_ENABLED=true` + `BINANCE_API_KEY/SECRET`.
* **Persistence** `prisma/schema.prisma` + `apps/server/src/persistence/prisma.ts` (Postgres/Prisma), `state/state-recovery.ts` (persist/restore), `core/storage.ts` (file fallback), `memory/agent-memory.ts`.

---

## Agents (6)

| Agent | ID | File | Subscribes | Publishes | Notes |
|-------|----|------|------------|-----------|-------|
| Market | `market` | `agents/market/index.ts` | — | `market.tick {symbol,price,change,volume,source:binance\|synthetic}` | Binance REST 2s; synthetic 1500ms without key; `market/state` |
| Quant | `quant` | `agents/quant/` | `market.tick` | `quant.signal {buy/sell, confidence≥0.6, 2/4 confluence}` | `strategies.ts` pure SMA/EMA/RSI/MACD/BB |
| Risk | `risk` | `agents/risk/` + `risk-engine/` | `quant.signal` | `risk.approved|rejected {checks:{exposure,drawdown,concentration,confidence,VaR}}` | 15s cooldown, maxPos 20%/lev 3x/drawdown 10%/VaR 5%, via `risk-engine.ts` metrics |
| Portfolio | `portfolio` | `agents/portfolio/` | `risk.approved, order.filled, market.tick` | `order.created, portfolio.updated` | 1% risk/ Kelly, mark-to-market; **holds no truth — prefers PaperBroker** |
| Execution | `execution` | `agents/execution/` | `order.created` | `order.filled|rejected {fee,slippage 0.05%/0.1%}` | paper (latency 100ms) / live CCXT |
| **Supervisor** | `supervisor` | `agents/supervisor/` | `supervisor.task, supervisor.plan_*` (self) | `supervisor.plan_created, supervisor.step_started|completed|failed, supervisor.task:ack` | deterministic planner, execution steps via ExecutionPipeline |

`docs/AGENTS.md` details lifecycle `register→start→running→stop→stopped` and `BaseAgent` contract.

---

## Finance Environment (OpenMausBot-inspired)

`apps/server/src/environment/` — agents interact with markets **only** via `FinanceEnvironment`:

```ts
interface FinanceEnvironment { market: MarketDataPort; portfolio: PortfolioPort; trading: PaperTradingPort; backtest: BacktestPort; }
MarketDataPort   { getPrice, getOHLCV, getOrderBook, getMarketState, isAvailable }
PortfolioPort    { getSnapshot, getBalance, getPositions }
PaperTradingPort { createOrder, cancelOrder, getOrders, getPortfolio } // paper-only assert
BacktestPort     { run(strategyId, {symbol,timeframe,candles}), listStrategies, isAvailable }
```

`FinanceEnvironmentImpl` composes `market+portfolio+trading+backtest` + `BacktestEngine` + `StrategyRegistry`. `BinanceMarketDataAdapter` wraps only `BinanceAdapter` (read path), `PaperTradingAdapter` wraps `PaperBroker` (validates `quantity>0`, `symbol`, paper guard). Factories `createFinanceEnvironment({bus,mode:'paper', strategyRegistry})` (real) and `createTestEnvironment({market?, portfolio?, broker?})` (memory). Registered as `FinanceEnvironmentService` (`id finance-environment`). Used by Strategy Lab and Supervisor backtest steps. Live orders disabled — `paper` default asserts.

---

## Tools — Provider Abstraction

`apps/server/src/tools/finance-tools.ts:registerAllTools(runtime)` registers **21 tools** (typed `ToolDefinition + execute`):

*Market (6):* `market.get_price / fetch_price, market.get_ohlcv / fetch_ohlcv, market.get_orderbook / fetch_orderbook` — via `createExchangeProvider` → `ExchangeProvider` (`getPrice/getOHLCV/getOrderBook/getBalance/getPositions/getPortfolio`). `memory-provider` (synthetic/deterministic, tests) vs `binance-provider` (Binance REST). `providers/types.ts` keeps exchange code out of tools; `market/market-state.ts` tracks ticks.

*Portfolio (3):* `portfolio.get_snapshot / get_portfolio_snapshot, portfolio.get_balance, portfolio.get_positions`.

*Indicators (6):* `quant.calculate_indicator (sma/ema/rsi/macd/bollinger), quant.research, strategy.evaluate, risk.calculate_position_size, risk.assess, portfolio.summarize`.

*Utility (3):* `validate-symbol, format-money, event-log` (plus `calculate_position_size` etc overlap). All validated via `ToolRegistry.execute` with `tool.called|completed|failed` bus events, `inputSchema` JSON-schema.

---

## Strategy Lab

`apps/server/src/strategy-lab/` — `Strategy Idea → Strategy → Backtest → Performance → Risk → Paper Candidate`

* `types.ts:StrategyIdea {id, kind, symbol, timeframe, params, createdAt}, LabConfig {minSharpe,maxDrawdown,profitFactor,minTrades}, PerformanceAnalysis {profitFactor, avgWin/avgLoss, expectancy, verdict pass|fail|inconclusive}, RiskAnalysis {checks[7], riskScore 0-100, decision APPROVED|REJECTED}, PaperCandidate, LabRun, LAB_EVENTS(strategy-lab.idea_created|strategy_created|backtest_completed|performance_ready|risk_ready|candidate_ready)`.
* `strategy-factory.ts:LAB_BUILDERS` 4 modular builders `ema-crossover (fast/slow), rsi-reversal (period/overbought/oversold), macd-crossover, momentum (period/threshold)` share `computeEMA/RSI/MACD` helpers; `createStrategyFromIdea` registers namespaced `lab:<ideaId>:<kind>`; `defineLabStrategy` wraps for `StrategyRegistry`.
* `performance.ts:analyzePerformance(candles→ trades → profitFactor/grossProfit/expectancy, verdict vs thresholds)` pure.
* `risk-analysis.ts:analyzeRisk(candles→ drawdown/sharpe/tradeCount/winRate/profitFactor/totalReturn/exposureProxy → 7 checks → riskScore)` pure.
* `strategy-lab.ts:StrategyLab {bus, StrategyRegistry, market:MarketDataPort, BacktestEngine, config}` — `parseIdea` (SYMBOL_BLOCKLIST excludes EMA/RSI/MACD…, extractors for symbol/timeframe/kind/params), `submitIdea(string|IdeaInput) → StrategyIdea`, `toStrategy(idea)`, `backtest(strategy, symbol)` via `engine.run` reusing `BacktestEngine` (or `market.getOHLCV` or `syntheticCandles` fallback), `run(idea)` full pipeline emitting `strategy-lab.*`.
* `service.ts:StrategyLabService(ServiceLifecycle)`.

---

## Execution Pipeline

`apps/server/src/execution-pipeline/` — `Signal → Risk → Permission → Paper → Result` (reliable, permissioned, auditable, **live disabled**)

* `types.ts:PipelineSignal {id,symbol,side,quantity,price,type,agentId,strategy,confidence,correlationId}, PipelineConfig {liveTradingEnabled=false, dailyLimit, perSymbolLimit, defaultNotional}, PipelineResult {ok, stage, signal, riskResult?, permission?, order?, auditId}, AuditEntry, PIPELINE_EVENTS(pipeline.started|risk_passed|risk_rejected|permission_granted|permission_denied|paper_filled|paper_failed|live_blocked|audit_written)`.
* `validation.ts:validateSignal(signal) + validateNotional`; `permission.ts:checkPermission({gateway, signal, dailyCounts}) → {allowed,reason}` (gateway `canExecute`, per-symbol/day caps); `audit.ts:PipelineAuditLog({bus}) → record(entry)+ bus publish pipeline.audit.*`.
* `pipeline.ts:ExecutionPipeline({bus, riskAgent, gateway, paperBroker, auditLogger})` — `execute(signal): PipelineResult` sequentially: `validation → riskAgent.evaluate({symbol,side,quantity,price,confidence,agentId}) → risk.* → permission (gateway+limits) → paper only (paperBroker.createOrder, never live unless LIVE_TRADING_ENABLED guard passes → otherwise live_blocked) → writes `AuditEntry` via `PipelineAuditLog` + `AuditLogger` mirroring, emits stage events, increments `dailyCounts`. Exports `getExecutionPipeline()`.
* `service.ts:ExecutionPipelineService(ServiceLifecycle)`. Desktop `PaperTradingPanel` surfaces `pipeline.*`; `TerminalPanel` + `GET /api/audit` surface audit trail.

---

## Desktop OS (OpenMausBot-inspired)

`apps/dashboard/src/` — **modular, no backend rewrite**, talks only to real backend.

* `lib/api.ts:API_BASE, fetchPortfolio/fetchTicks/fetchHealth/connectEvents({onEvent,onOpen,onError,replay,lastEventId})` (SSE).
* `lib/desktop-api.ts:publishEvent(type,data), supervisorTask(task)=>POST /api/publish {type:'supervisor.task', data:{task}} , terminalCommand(cmd)=>POST /api/publish {type:'terminal.command'}, fetchRisk/Gateway/Execution`.
* `lib/useFinanceEvents.ts` hook (connected + events buffer + reconnect).
* `components/desktop/` — `ChatPanel` (input + quick prompts like "Analyze BTC", "Buy 0.05 BTC"), `AgentWorkspace` (AgentStatus live `GET /api/agents` + supervisor plan trace filtered `supervisor.*`), `ToolActivity` (`tool.* + supervisor.*`), `MarketPanel` (tickers via `GET /api/market/ticks` + `MarketChart` lightweight-charts + `MarketMeta` synthetic badge from `source`), `StrategyPanel` (`BacktestPanel POST /api/backtest/run` + `strategy-lab.*`), `PortfolioPanel` (`GET /api/portfolio` single truth from PaperBroker: totalValue/cash/PnL + holdings table), `RiskPanel` (`risk.*` + `GET /api/risk/status`), `PaperTradingPanel` (`GET /api/execution/status` + `pipeline.*`/`execution.*` + `OrdersPanel` + `TradeForm` → `POST /api/gateway/trade`), `TerminalPanel` (history + `terminal.command` bus echo, `help/clear/task <…>`).
* `components/desktop/Shell.tsx` — top bar health/SSE, 3-column overview grid (`Chat|AgentWorkspace|ToolActivity` row + `Market|Strategy|Portfolio` + `Risk|Paper|Terminal` rows) plus tab nav `overview/market/strategy/portfolio/risk/paper/terminal` reusing same panels single-column.
* `app/page.tsx` is `<DesktopShell/>` only.

---

## Event Flows

**Market → Signal → Risk → Paper (classic 5-agent loop)**

```
Binance REST (fetchTick) ─┐
Synthetic 1500ms fallback ┘─→ MarketAgent ── market.tick {source} ──→ TypedEventBus ─┬─→ QuantAgent (buffer 100, SMA/EMA/RSI/MACD/BB, confluence ≥0.6) ─→ quant.signal(buy/sell)
                                                                    ├─→ PortfolioAgent (mark-to-market) ─→ portfolio.updated
                                                                    └─→ Dashboard SSE → MarketChart
Quant quant.signal ─→ RiskAgent (exposure/drawdown/concentration/VaR/Sharpe, 15s cooldown) ─→ risk.approved|rejected ─┬─→ PortfolioAgent (1% sizing) ─→ order.created ─→ ExecutionAgent (paper slippage 0.05%/fee 0.1%) ─→ order.filled → PaperBroker → portfolio.updated
                                                                                                                          └─→ Dashboard
```

**Supervisor (User → Desktop → Pipeline)**

```
User types "Buy 0.05 BTC" in ChatPanel → desktop-api.supervisorTask → POST /api/publish {type:'supervisor.task', data:{task}} → bus supervisor.task
  → SupervisorAgent.handleEvent → plan(task) → planner: extractSymbol(BTC→BTCUSDT) + classifyTask(trade|analyze|portfolio|backtest|generic) + extractQuantity + lastPrice → buildTradeSteps(symbol,task) with price/side/qty → createPlan → publish supervisor.plan_created
  → validate(plan) against AgentRegistry/ToolRegistry
  → executePlan(plan): for each step {publish supervisor.step_started → toolRegistry.execute(step.toolId, step.input) OR if agent=execution && no toolId → executionPipeline.execute({symbol,side,quantity,price,type:'market',agentId:'supervisor',strategy:plan.kind,confidence:0.85,correlationId:plan.id}) → publish execution.result → publish supervisor.step_completed (+pipelineStage) } → supervisor emits supervisor.task:ack
Bus traces supervisor.* + tool.* + pipeline.* → AgentWorkspace/ToolActivity/PaperTradingPanel.
```

**Strategy Lab**

```
StrategyLab.submitIdea("EMA 12/26 BTC 1h") → parseIdea (blocklist, extract symbol/timeframe/kind/params) → StrategyIdea
  → toStrategy → LAB_BUILDERS[kind] → defines lab:<id>:<kind> strategy (shared computeEMA/RSI/MACD) → registers in StrategyRegistry → publishes strategy-lab.strategy_created
  → backtest(strategy) → BacktestEngine.run(symbol,timeframe,candles) where candles = BacktestEngine.candles | financeEnv.market.getOHLCV | syntheticCandles → publishes strategy-lab.backtest_completed
  → analyzePerformance → verdict, analyzeRisk → APPROVED/REJECTED → PaperCandidate → strategy-lab.candidate_ready
Full run() does idea→strategy→backtest→performance→risk→candidate sequentially.
```

**Execution Pipeline internals**

```
PipelineSignal → validateSignal → RiskAgent.evaluate → risk.approved|rejected? → checkPermission(gateway.canExecute + dailyCounts + per-symbol) → AuditEntry stage=risk|permission → PaperBroker.createOrder (paper-only, live guard LIVE_TRADING_ENABLED) → order.filled|failed → audit pipeline.audit.written → PipelineResult{ok, stage, auditId}
```

---

## What Already Works

| Capability | Status | Location | Notes |
|------------|--------|----------|-------|
| TypedEventBus | ✅ Done | `packages/core/src/event-bus.ts` + shim | id/timestamp/source/correlationId, filtered/replay, 50k history, error-isolated |
| FinanceRuntime + Lifecycle | ✅ Done | `packages/core/src/runtime.ts` + `apps/server/src/core/runtime.ts` | composition root, 8-phase, health aggregation |
| 5 Registries | ✅ Done | `packages/core/src/registries.ts` | Agent/Tool/Plugin/Strategy/Service |
| 5 Finance Agents + Supervisor | ✅ Done | `apps/server/src/agents/*` | + supervisor deterministic planner via pipeline |
| Finance Environment | ✅ Done | `apps/server/src/environment/` | market/portfolio/paper/backtest ports, adapters, service |
| Finance Tools (21) | ✅ Done | `apps/server/src/tools/finance-tools.ts` + `providers/` | exchange-agnostic, ToolRegistry |
| Market State | ✅ Done | `apps/server/src/market/market-state.ts` | ticks/candles/state |
| Risk Engine | ✅ Done | `apps/server/src/risk-engine/` | metrics + cooldown/concentration |
| Portfolio | ✅ Done | `apps/server/src/agents/portfolio/` | positions/PnL/Kelly; truth = PaperBroker |
| PaperBroker + Broker | ✅ Done | `apps/server/src/broker/` | slippage/fees, order/portfolio truth |
| Order/Trade Engine | ✅ Done | `apps/server/src/order-manager/` + `trade-engine/` | state machine, trades ≠ orders |
| Strategy Registry | ✅ Done | `apps/server/src/strategies/` + `packages/core` | toggle/pluggable |
| BacktestEngine | ✅ Done | `apps/server/src/backtesting/` | simulation, reused by Strategy Lab |
| Strategy Lab | ✅ Done | `apps/server/src/strategy-lab/` | modular factory, reusable backtesting, performance/risk, orchestrator |
| Execution Pipeline | ✅ Done | `apps/server/src/execution-pipeline/` | permissioned, audited, paper-only default |
| FinanceGateway | ✅ Done | `apps/server/src/gateway/` | permission + executionMode + audit |
| AuditLogger | ✅ Done | `apps/server/src/audit/` | bus audit.* + pipeline audit |
| StateRecovery | ✅ Done | `apps/server/src/state/` + `persistence/` | Prisma + recovery |
| Memory | ✅ Done | `apps/server/src/memory/` | AgentMemory |
| Security | ✅ Done | `apps/server/src/security/` | env-validator gates live |
| Binance Adapter/Plugin | ✅ Done | `apps/server/src/market/exchange-adapter.ts` + `plugins/binance-plugin.ts` + `adapters/binance-ws.ts` | REST + WS, synthetic guard |
| Fastify Server | ✅ Done | `apps/server/src/core/server.ts` | all REST, SSE, proxy-safe |
| Dashboard Desktop OS | ✅ Done | `apps/dashboard/src/components/desktop/` | Shell + 9 panels, SSE, real-only data (— until backend) |
| Tests | ✅ Done | `packages/core/__tests__/` + `apps/server/__tests__/` | registries/event-bus/runtime + 12 server suites (~273 tests) |
| CI | ✅ Done | `.github/workflows/ci.yml` | tsc + build + test |

---

## What Is Incomplete / Next

| Area | Status | Next |
|------|--------|------|
| Live Binance execution | Gated (env gate correct) | `BinanceBroker` live path already gated by `LIVE_TRADING_ENABLED`; needs integration keys + risk sign-off, no code change |
| Strategy persistence | Lab strategies in-memory | Persist lab:<id>:<kind> in Prisma + StateRecovery snapshot |
| Backtest persistence | Results in bus only | Write `LabRun` → DB + `/api/strategy-lab/runs` |
| Pipeline persistence | Audit in AuditLogger + bus | Already mirrored; add `GET /api/pipeline/audit` pagination + retention |
| Auth | No | Add API auth (future Phase Security) |
| Honeycomb/OTel | No | Optional observability export for pipeline/supervisor spans |
| E2E `node scripts/verify-honesty.mjs` | ✅ Exists | Run in CI vs live preview |

---

## Implementation Notes

* Single truth laws: `TypedEventBus = packages/core/src/event-bus.ts`; Portfolio/orders/trades = `PaperBroker`; `tick.source` honest (`binance|synthetic`); `candles/orderbook.synthetic: true` until real history — enforced by `scripts/verify-honesty.mjs` (ticks source, candles/orderbook flag, orders/trades source, backtest).
* Add an agent: `apps/server/src/agents/<id>/index.ts` extends `BaseAgent`, then `runtime.registerAgent(new MyAgent(bus))` in `apps/server/src/core/runtime.ts` or `pnpm openbot add agent my-agent`.
* Add a tool: `apps/server/src/tools/<name>.ts` → `registerAllTools` or `pnpm openbot add tool my-tool`. Keep exchange code in `providers/` not tools.
* Add a strategy: `STRATEGY_REGISTRY` + `registerStrategy` or new `LAB_BUILDERS` kind in `strategy-lab/strategy-factory.ts`.
* Add a service: implement `ServiceLifecycle`, `runtime.registerService(new MyService(...))` with id in `SERVICE_IDS`.

---

*Generated — Finance Agent OS Architecture (Current) — Phase 5, Sept 4 2026*
