# Finance Agent OS — OpenBot for Finance

Event-driven trading OS: 5 agents (Market → Quant → Risk → Portfolio → Execution) on a **single `TypedEventBus`** (`@finance/core`, `packages/core/src/event-bus.ts:1`) with `FinanceGateway` + `Paper/Live` broker. Cross-platform (Windows/Linux/Docker) — the finance-native equivalent of OpenBot. **No fake data:** dashboard shows `—` until `GET /api/portfolio` / `GET /api/market/ticks` return real data; ticks carry `source: binance|synthetic`.

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

> **Merged to `main`:** #1 actionable Quant, #2 prod hardening, #3 dashboard honesty + `pnpm openbot` scaffold, #4 portfolio single-truth + `BacktestPanel`, #5 single EventBus shim, #7 orders/trades single truth, #8 honest README, #9 OrdersPanel, #10 MarketMeta synthetic badges, #11 verify-honesty script.

## Architecture

```
                          User
                           │
                  Desktop OS (Next.js, SSE — Chat/Workspace/Tool/Market/Strategy/Portfolio/Risk/Paper/Terminal)
                           │  POST /api/publish (supervisor.task)  GET /api/*  GET /api/events
                           ▼
                    Fastify (:4132) + TypedEventBus
                           │
                     FinanceRuntime (@finance/core — Lifecycle + 5 Registries)
    ┌──────────────────────┼──────────────────────────────────────┐
    │                      │                                      │
  AGENTS                 TOOLS                               SERVICES
    │                      │                                      │
  ┌─┼──────────┐     ToolRegistry (21)                    ┌──────┴─────────────┐
  │ │          │      price/ohlcv/orderbook                │                    │
Market Quant  Risk    portfolio/indicators/utility         FinanceGateway  AuditLogger
  │   │    │   │      (via ExchangeProvider)               MarketState   PaperBroker
Portfolio Execution   memory ↔ binance                    StateRecovery  OrderManager
  │      │        ↕                                       TradeEngine  AgentMemory
Supervisor◄──────▶Finance Environment◄──────────────────── StrategyRegistry
  │ plan │     adapters                                   FinanceEnvironment
  │      │  BinanceMarketData ─┐  PaperTrading ─┐         StrategyLab
  │      └────► BacktestEngine◄┴──► PaperBroker │         ExecutionPipeline ───┐
  │             market.getOHLCV  audit/validate │              │               │
  └────────────── correlationId ─────────────────┘              │               │
                           │                                    │               │
                        EVENT BUS (TypedEventBus 50k, replay, correlationId)
                           │                                    │
                     FinanceGateway                              │
                      Risk/Governance                            │
                           │                                     │
                     Execution Layer                              │
                      ┌────┴────┐                                │
                      ▼         ▼                                │
                   PAPER     LIVE BROKER (gated LIVE_TRADING_ENABLED)
                   BROKER       │
                                ▼
                             Binance
```

Flow: `User → Desktop Chat (supervisor.task) → Supervisor plan → Tools/Environment → Risk → ExecutionPipeline (Risk→Permission→Paper, audited) → PaperBroker → portfolio.updated → Desktop`.
`Strategy Idea → Strategy Lab → BacktestEngine (reused) → Performance/Risk → Paper Candidate` runs via Finance Environment market adapter.

## Quick Start

```bash
# Install (cross-platform — Windows / Linux / Docker)
pnpm install

# Build shared packages + server + dashboard
pnpm build

# Start server (paper mode by default — live requires env, see below)
pnpm dev:server          # Fastify on http://localhost:4132

# Start dashboard (separate terminal)
pnpm dev:dashboard       # Next.js on http://localhost:3000

# Verify
curl http://localhost:4132/api/health
curl http://localhost:4132/api/agents
curl http://localhost:4132/api/portfolio   # PaperBroker single truth (holdings/positions/cash)
node scripts/verify-honesty.mjs             # loop honesty contract: ticks source, candles/orderbook synthetic flag, orders/trades, backtest
```

### Production env (hardened in `apps/server/src/security/env-validator.ts:19`)

```bash
PORT=4132
HOST=0.0.0.0
EXECUTION_MODE=paper          # paper | live
LIVE_TRADING_ENABLED=false    # must be true + BINANCE_API_KEY + BINANCE_SECRET for live
BINANCE_API_KEY=
BINANCE_SECRET=
NEXT_PUBLIC_API_BASE=http://localhost:4132
```
`PORT` must be `1-65535` and `EXECUTION_MODE` must be `paper|live`; `live` fails fast unless `LIVE_TRADING_ENABLED=true` + keys are set.

### OpenBot-style scaffolding

```bash
pnpm openbot add agent my-agent     # scaffolds apps/server/src/agents/my-agent
pnpm openbot add tool my-tool       # scaffolds apps/server/src/tools
pnpm openbot add plugin my-plugin   # scaffolds apps/server/src/plugins
# registry is explicit in apps/server/src/core/runtime.ts:410 — pnpm openbot add is the OpenBot pattern
```

## Project Structure

```
finance-agent-os/
├── packages/
│   ├── core/src/             # @finance/core — FinanceRuntime, TypedEventBus, Agent/Tool/Plugin/Strategy/Service registries, LifecycleManager, BaseAgent
│   └── shared/src/           # @finance/shared — FinanceEvent, ToolDefinition, StrategyConfig, PluginInfo, types
├── apps/
│   ├── server/src/
│   │   ├── core/             # runtime.ts (createRuntime composition root, SERVICE_IDS, get* accessors), server.ts (Fastify + SSE), eventBus.ts (shim), storage.ts
│   │   ├── agents/           # market/ quant/ risk/ portfolio/ execution/ + supervisor/{planner.ts, index.ts} (deterministic planner → ExecutionPipeline)
│   │   ├── environment/      # FinanceEnvironment (MarketDataPort/PortfolioPort/PaperTradingPort/BacktestPort), adapters/{binance-market-data, paper-trading}, service.ts
│   │   ├── strategy-lab/     # Strategy Lab: strategy-factory.ts + performance.ts + risk-analysis.ts + strategy-lab.ts + service.ts
│   │   ├── execution-pipeline/ # Signal→Risk→Permission→Paper→Result: validation.ts + permission.ts + audit.ts + pipeline.ts + service.ts
│   │   ├── tools/            # finance-tools.ts (21 tools via ToolRegistry) + price.ts/ohlcv.ts/orderbook.ts/portfolio.ts/indicators.ts + validateSymbol/formatMoney/eventLog
│   │   ├── providers/        # ExchangeProvider abstraction (types.ts, memory-provider.ts, binance-provider.ts) — keeps exchange code out of tools
│   │   ├── market/           # exchange-adapter.ts, market-state.ts
│   │   ├── strategies/       # StrategyRegistry + default strategies (SMA/EMA/RSI/MACD/BB)
│   │   ├── risk-engine/      # pure risk metrics (exposure/drawdown/VaR/Sharpe)
│   │   ├── broker/           # paper-broker.ts (single truth) + binance-broker.ts
│   │   ├── order-manager/    # order state machine
│   │   ├── trade-engine/     # orders ≠ trades
│   │   ├── backtesting/      # BacktestEngine (reused by Strategy Lab + /api/backtest/run)
│   │   ├── gateway/          # FinanceGateway (permissions, executionMode, audit)
│   │   ├── audit/            # AuditLogger (audit.* events, pipeline mirror)
│   │   ├── memory/           # AgentMemory
│   │   ├── state/            # StateRecovery (persist/restore)
│   │   ├── persistence/      # Prisma (Postgres)
│   │   ├── security/         # env-validator.ts (gates live)
│   │   ├── plugins/          # binance-plugin.ts
│   │   ├── adapters/         # binance-ws.ts
│   │   └── __tests__/        # 12 suites: market-data-tools, portfolio-and-indicators, risk-engine, strategies, paper-broker, gateway-audit-memory, finance-environment, supervisor, strategy-lab, execution-pipeline, tools, utility-tools
│   └── dashboard/src/
│       ├── app/page.tsx      # <DesktopShell />
│       ├── components/desktop/ # Shell.tsx + ChatPanel + AgentWorkspace + ToolActivity + MarketPanel + StrategyPanel + PortfolioPanel + RiskPanel + PaperTradingPanel + TerminalPanel
│       ├── components/       # MarketChart, MarketMeta, AgentStatus, BacktestPanel, OrdersPanel, TradeForm
│       └── lib/              # api.ts (SSE), desktop-api.ts (supervisor.task/terminal.command), useFinanceEvents.ts
├── docs/                     # ARCHITECTURE.md (this OS), API.md, AGENTS.md, RUNTIME.md, EVENTS.md, STRATEGIES.md, RISK.md, EXECUTION.md, SECURITY.md, DEVELOPMENT.md
├── prisma/schema.prisma
└── scripts/verify-honesty.mjs
```

## Agents

- **Market Agent** (`apps/server/src/agents/market/index.ts:100`) — Binance REST via `fetchTick()` (`source: binance`); without `BINANCE_API_KEY` emits synthetic ticks (`source: synthetic`) on 1500ms interval with explicit log; with key, REST polling only (synthetic on fetch failure). Dashboard badge `● BINANCE` / `○ SYNTHETIC` from `tick.source`.
- **Quant Agent** — Technical analysis: SMA, EMA, RSI, MACD, Bollinger Bands — **only publishes actionable `buy/sell`** when `confidence ≥0.6` + `2/4` confluence (no `hold` flood).
- **Risk Agent** (`apps/server/src/risk-engine/risk-engine.ts:39`) — `15s` per-symbol cooldown (`60s` rejected most signals when quant emits every `~2s`), confidence threshold, exposure/drawdown/leverage checks.
- **Portfolio Agent** — Position management, PnL tracking, Kelly criterion (fallback); **single truth is `PaperBroker`** (`apps/server/src/broker/paper-broker.ts` / `apps/server/src/core/server.ts:129`).
- **Execution Agent** — Paper and live trading via CCXT; fills feed `GET /api/trades` (`source: execution-agent`).
- **Supervisor Agent** (`apps/server/src/agents/supervisor/`) — Deterministic planner `task → plan` (`planner.ts: extractSymbol/classifyTask/extractQuantity`): `"Analyze BTC" → Market→Research→Strategy→Risk→Final`, `"Buy 0.05 BTC" → validate→market→risk→execution→final`. Validates vs `AgentRegistry`/`ToolRegistry`, emits `supervisor.plan_created/step_started|completed|failed`, and trade steps execute via **`ExecutionPipeline` (`Signal→Risk→Permission→Paper`, `correlationId=plan.id`)** so permissions/audit/RiskAgent are never bypassed. Triggered from Desktop `ChatPanel → POST /api/publish {type:'supervisor.task'}`.

**Finance Environment** (`apps/server/src/environment/`) — `MarketDataPort/PortfolioPort/PaperTradingPort/BacktestPort` → `BinanceMarketDataAdapter` + `PaperTradingAdapter(PaperBroker)`; paper-only, used by Strategy Lab and Supervisor backtest steps. **Strategy Lab** (`strategy-lab/`) — `Idea→Strategy→Backtest(BacktestEngine reused)→Performance→Risk→Paper Candidate` via `FinanceEnvironment.market`. **Execution Pipeline** (`execution-pipeline/`) — `Signal→Risk(RiskAgent.evaluate)→Permission(FinanceGateway+limits)→Paper(PaperBroker)→Audit(PipelineAuditLog+AuditLogger)`, `LIVE_TRADING_ENABLED=false` default.

## Honesty & Single-Truth Notes

- **No fake dashboard data:** `apps/dashboard/src/app/page.tsx` shows `— awaiting /api/portfolio` and `No positions yet — paper trading starts with $100k cash` until the server returns data. `AgentStatus` fetches live `GET /api/agents`.
- **Portfolio single truth:** `GET /api/portfolio` + `GET /api/portfolio/positions` + `GET /api/orders` + `GET /api/trades` prefer `PaperBroker` (real fills) and add `source: paper-broker|execution-agent`.
- **Market honesty:** `tick.source` is `binance|synthetic`; with key, no duplicate synthetic flood (`apps/server/src/agents/market/index.ts:100-132`).
- **EventBus single truth:** canonical `TypedEventBus` is `packages/core/src/event-bus.ts:1`; `apps/server/src/core/eventBus.ts` is a shim re-export (`feat/bus-unification`).

## Event Pipeline

```
Classic (autonomous loop):
MarketAgent → market.tick (source: binance|synthetic) → QuantAgent → quant.signal (buy/sell only, ≥0.6 + 2/4)
                                          ↓
                                     RiskAgent (15s cooldown) → risk.approved/rejected
                                          ↓
                               FinanceGateway → order.created
                                          ↓
                                     ExecutionAgent → order.filled
                                          ↓
                                PaperBroker → portfolio.updated → dashboard (SSE)

Supervisor (user-driven, Desktop → Pipeline — pipeline enforces permissions/audit):
User → Desktop ChatPanel → POST /api/publish {type:'supervisor.task'} → TypedEventBus supervisor.task
  → SupervisorAgent → plan(task) → supervisor.plan_created → validate(registries)
  → executePlan: for step → supervisor.step_started → ToolRegistry.execute OR (execution step → ExecutionPipeline.execute{signal, correlationId:plan.id})
     → pipeline.risk_passed|rejected → pipeline.permission_granted|denied → pipeline.paper_filled → pipeline.audit_written
  → supervisor.step_completed (+pipelineStage) → dashboard ToolActivity/PaperTradingPanel/Terminal

Strategy Lab:
Idea → strategy-factory (lab:<id>:<kind>) → StrategyRegistry → BacktestEngine.run (via FinanceEnvironment.market.getOHLCV or synthetic) → performance (profitFactor/expectancy) → risk (7 checks→APPROVED/REJECTED) → PaperCandidate → strategy-lab.* SSE
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check with runtime status |
| GET | `/api/agents` | List all agents with health (used by dashboard `AgentStatus`) |
| POST | `/api/agents/:id/start` | Start agent |
| POST | `/api/agents/:id/stop` | Stop agent |
| GET | `/api/events` | SSE event stream (`?replay&limit&lastEventId`) |
| GET | `/api/portfolio` | Portfolio — `PaperBroker` single truth (`holdings/positions/availableCash/totalValue/pnl/risk`) + `source` |
| GET | `/api/portfolio/positions` | Positions — `PaperBroker` preferred |
| GET | `/api/market/ticks` | Market tick data (`tick.source: binance\|synthetic`) |
| GET | `/api/market/candles` | Candles (`synthetic: true` until real history) |
| GET | `/api/market/orderbook` | Orderbook (`synthetic: true` until WS) |
| GET | `/api/signals` | Recent trading signals (actionable `buy/sell` only) |
| GET | `/api/orders` | Order history — `PaperBroker` preferred (`source`) |
| GET | `/api/trades` | Trade history — `ExecutionAgent`/`PaperBroker` preferred (`source`) |
| GET | `/api/strategies` | Registered strategies |
| POST | `/api/strategies` | Register strategy |
| POST | `/api/strategies/:id/toggle` | Enable/disable strategy |
| GET | `/api/backtest/strategies` | List backtestable strategies (#1) |
| POST | `/api/backtest/run` | Run backtest `{strategyId,symbol,timeframe,candles}` (#1, used by `BacktestPanel`) |
| GET | `/api/risk/status` | Risk metrics (exposure/drawdown/sharpe) |
| GET | `/api/execution/status` | Execution statistics |
| GET | `/api/gateway/stats` | Gateway stats |
| POST | `/api/publish` | Publish custom events |
| POST | `/api/trading/signal` | Manually trigger `quant.signal` |
| POST | `/api/gateway/trade` | Submit trade via `FinanceGateway` → risk → execution |

## Testing & Builds

```bash
pnpm test              # Run all tests (CI runs pnpm test, not || true)
pnpm typecheck         # Type check
pnpm build             # Build all packages (server: tsc, dashboard: next build 8.85kB /)
pnpm --filter @finance/server build
pnpm --filter @finance/dashboard build
```

## License

MIT
