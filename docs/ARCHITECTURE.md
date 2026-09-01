# Finance Agent OS — Architecture Audit (Phase 0)

> **Status:** Phase 0 — Repository Audit — `docs: add architecture audit`  
> **Date:** 2026-09-01  
> **Auditor:** Lead Architect (Muse Spark)  
> **Repo:** https://github.com/namana843-bit/finance-agent-os  
> **Branch:** main @ 1a92fd8  
> **Principle:** Real finance agent platform + dashboard client. No fake data presented as real.

---

## 1. Executive Summary

The repository has a **functional prototype** but not a finance platform yet. Dashboard (Next.js 14, `apps/dashboard`) is visually complete with market chart, agent status, portfolio cards, SSE log — yet it renders **mock values** when the server is down and consumes **mock endpoints** when the server is up. Server (`apps/server`, Fastify 5) has 5 in-memory agents wired through a simple `EventBus` + file `Storage` — the pipeline `market:tick → signal:* → risk:* → portfolio:order → execution:filled → portfolio:update` actually runs end-to-end, metrics are pure and well-tested by structure, but the boundary to the outside world (exchanges, database, governance) is missing.

**Gap to target:** ~15-18% of the target Finance Agent Platform. Phases 1–28 are required; no phase can be skipped, but order can be adjusted after Phase 1–2 foundations.

---

## 2. Current Repository Layout

```
finance-agent-os/
├── package.json               # pnpm workspace root, scripts: dev, dev:server, dev:dashboard, build, start
├── pnpm-workspace.yaml        # apps/*, packages/* (packages/ does not exist yet)
├── pnpm-lock.yaml             # 33k lines, pnpm 9.0.0
├── .github/workflows/
│   ├── ci.yml                 # pnpm install --frozen-lockfile → tsc --noEmit → pnpm build → node test-e2e.mjs
│   └── pages.yml              # next build → upload apps/dashboard/out → deploy-pages
├── .gitignore                 # node_modules, .next, dist, .data, .env etc.
├── .env.example               # PORT=4132, HOST, EXECUTION_MODE=paper, BINANCE_*, NEXT_PUBLIC_API_BASE
├── CONTRIBUTING.md, LICENSE, README.md, test-e2e.mjs
├── apps/server/               # @finance/server
│   ├── package.json           # fastify 5.3.2, @fastify/cors, uuid, ws; tsx, typescript
│   ├── tsconfig.json          # ES2022, NodeNext, strict, outDir dist, rootDir src
│   └── src/
│       ├── index.ts           # boot: startServer + start 5 agents, graceful shutdown SIGINT/SIGTERM
│       ├── core/
│       │   ├── eventBus.ts    # EventBus class + singleton eventBus (203 lines)
│       │   ├── storage.ts     # file JSON Storage .data/{channels,threads,messages}.json (326 lines)
│       │   └── server.ts      # Fastify buildServer/startServer, 6 routes + SSE (404 lines)
│       └── agents/
│           ├── market/        # MarketAgent (178 lines) + service.ts (79 lines) + AGENT.md
│           ├── quant/         # QuantAgent (319 lines) + strategies.ts (211 lines) + AGENT.md
│           ├── risk/          # RiskAgent (507 lines) + metrics.ts (136 lines) + AGENT.md
│           ├── portfolio/     # PortfolioAgent (540 lines) + allocation.ts (189 lines) + AGENT.md
│           └── execution/     # ExecutionAgent (418 lines) + ccxtWrapper.ts (298 lines) + AGENT.md
└── apps/dashboard/            # @finance/dashboard
    ├── package.json           # next 14.2.5, react 18.3.1, lightweight-charts 4.1.3
    ├── next.config.mjs        # rewrites /api/:path* → localhost:4132, export mode when PAGES=1
    ├── tsconfig.json          # bundler, jsx preserve, @/* alias
    └── src/
        ├── app/
        │   ├── layout.tsx     # global nav + tailwind CDN, dark bg #0a0a0f
        │   ├── page.tsx       # DashboardPage 460 lines: tickers, chart, portfolio, risk, positions, signals, SSE log
        │   └── globals.css
        ├── components/
        │   ├── MarketChart.tsx # canvas sparkline 202 lines
        │   └── AgentStatus.tsx # 5 agent cards + polling 164 lines
        └── lib/api.ts         # API_BASE, fetch helpers, connectEvents(EventSource) 215 lines
```

No `packages/`, no `docs/` (until this audit), no tests (`.test.*` / `.spec.*`), no lint config, no Prisma/database, no Docker requirement by design.

---

## 3. Technology Inventory

| Layer | Choice | Version | Notes |
|-------|--------|---------|-------|
| Monorepo | pnpm workspaces | 9.0.0 | No Turborepo, plain `pnpm -r` |
| Server | Fastify + TypeScript | 5.3.2 / 5.6.3 | ESM NodeNext, strict true |
| Dashboard | Next.js | 14.2.5 | App Router, no src/tests |
| Charts | lightweight-charts | 4.1.3 | Imported but MarketChart uses manual Canvas (placeholder div #lw-chart hidden) |
| EventBus | Custom in-memory | — | history 10k, subscribe/replay/filter, not typed per domain |
| Persistence | File JSON in .data | — | No DB, no migrations |
| Exchanges | fetch + synthetic | — | `fetchBinancePrice` + `generateSyntheticTick`, no ws, no orderbook/candles |
| Execution | ccxtWrapper mock | — | Dynamic import ccxt optional, else mock; paper slippage 0.05% fee 0.1% latency 100ms |
| Tooling | tsc --noEmit, pnpm build | — | No ESLint, no Prettier, no Vitest/Jest, no CI type artifacts |

---

## 4. What Already Works (Verified by Reading Code)

### 4.1 Core

- **EventBus** (`apps/server/src/core/eventBus.ts:43`): publish with id/timestamp auto-gen, history trimming, subscriber isolation (async catch), `subscribe`, `subscribeFiltered`, `getHistory(filter, limit)`, `replay(handler, filter)`, `size/clear/subscriberCount` — 10k cap, oldest-first.
- **Storage** (`core/storage.ts:61`): channel/thread/message JSON collections, atomic tmp→rename (UNC fallback), `ensureDir`, `seedIfEmpty`, sortable messages, singleton.
- **Server** (`core/server.ts:81`): `buildServer(opts)` / `startServer`, Fastify+@fastify/cors, routes: `GET /api/health`, `GET /api/state`, `GET /api/portfolio` (mock), `GET /api/market/ticks` (mock), `POST /api/publish` (validates type, persists if channel/thread), `GET /api/events` SSE (headers, replay, filtered subscribe, heartbeat 15s, lastEventId resume, cleanup on close), 404/error handlers.
- **Boot** (`src/index.ts:12`): instantiates 5 agents on shared singleton bus, `start()` each, logs pipeline, handles SIGINT/SIGTERM/unhandledRejection/uncaughtException gracefully.

### 4.2 Agents (all implement start/stop/isRunning, communicate via bus)

- **MarketAgent** (`agents/market/index.ts:13`): supports 5 symbols BTCUSDT/ETHUSDT/EURUSD/AAPL/SPY, lastPrices Map, poll 2s + wsTimer 1.5s/1.2s synthetic fallback, `fetchTick`, `startPolling`, `connectBinanceWS` (mock unless BINANCE_API_KEY), publishes `market:tick {symbol,price,change,volume,timestamp,source}`, history 1000.
- **QuantAgent** (`agents/quant/index.ts:48`): buffers 100 prices/symbol, onTick→generateSignal, pure indicators SMA/EMA/RSI/MACD/Bollinger from `strategies.ts`, confluence voting (buyCount/sellCount/activeCount), confidence 0.35–0.95, publishes `signal:buy|sell|hold`, `getSignals/getBuffer`.
- **RiskAgent** (`agents/risk/index.ts:92`): config maxPositionPct 20 / maxDrawdown 10 / maxDailyLoss 5 / maxLeverage 3 / maxOpenPositions 5 / confidenceThreshold 0.6, portfolio {cash 100k, positions Map, dailyPnL, peakValue}, evaluate() 5 checks (exposure, drawdown, concentration, confidence, VaR) + leverage & openPositions, publishes `risk:approved|rejected {signal,reason,checks,metrics}`, returns RiskDecision, metrics via pure metrics.ts.
- **PortfolioAgent** (`agents/portfolio/index.ts:88`): handles `risk:approved→portfolio:order` with qty=(cash*0.01)/price, `execution:filled→fill` updates positions/cash/realized/unrealized, `market:tick→update currentPrice+recalc`, rebalancing via allocation.ts, getPortfolio/getPnL/getAllocation, bounded history 500.
- **ExecutionAgent** (`agents/execution/index.ts:77`): mode paper|live from env/config (default paper), validates orders, uuid orderId, paper: slippage buy +0.05% sell -0.05% fee 0.1% latency 100ms, live: via ccxtWrapper (real or mock), publishes `execution:filled|rejected`, stats.

### 4.3 Pure Functions (High Quality, Test-Ready)

- `strategies.ts`: sma, ema, rsi (Wilder smoothed, handles short vs long buffers), macd (fast/slow/signal 12/26/9, builds macdSeries → ema signal), bollingerBands (20,2).
- `metrics.ts`: calculateExposure (multi-signatures), calculateDrawdown (current vs peak + array max-drawdown), calculateVaR (sorted 1-confidence percentile, floor, positive-only), calculateSharpe (population variance).
- `allocation.ts`: kellyCriterion (p - q/b, clamp 0..1), positionSizing ((cash*riskPct)/price), rebalanceWeights (delta map or trades with price→qty).
- `ccxtWrapper.ts`: createExchange/createExchangeSync/createOrder/fetchBalance, mock exchange when no keys, dynamic import ccxt optional.

### 4.4 Dashboard

- Next 14 app router, layout with sticky nav, tailwind CDN, dark theme, `page.tsx` handles health ping, polling ticks/portfolio every 5–7s, SSE connectEvents with replay limit 50, opportunistic live updates for ticks/portfolio, fallback card values when offline, canvas MarketChart with sparkline row, positions table, risk cards, signals feed (filters events containing signal/risk.alert), SSE log (200 cap, monospace), publish test event button.
- `lib/api.ts`: API_BASE env fallback localhost:4132, fetchJson, fetchHealth/fetchPortfolio/fetchTicks/fetchState, connectEvents(EventSource) with typed opts, known types listener, fmtCurrency/fmtNumber/fmtPercent.
- `AgentStatus.tsx`: 5 hard-coded agents polling /api/health every 8s + SSE agent.status listener, pulse animation.
- Rewrites: `next.config.mjs:8` proxies /api → localhost:4132 in dev, static export when PAGES=1.

---

## 5. What Is Incomplete / Missing (Mapped to Target Phases)

| Phase | Requirement | Current State | Severity |
|-------|-------------|---------------|----------|
| 1 Runtime | Finance Runtime core (lifecycle, config, service/agent/plugin/tool registries, logging, health) | No runtime abstraction; agents constructed manually in index.ts; no registry, no DI, no config validation, no tool/plugin system | Critical |
| 2 EventBus | Strongly typed finance events (id,type,timestamp,source,correlationId,data,metadata) + validation + categories MARKET/QUANT/RISK/PORTFOLIO/EXECUTION/TRADE/AGENT/SYSTEM | Event is {id,type,data,timestamp,channelId,threadId,agentId,runId}; missing source/correlationId/metadata, no schema validation, stringly-typed type, no category enforcement | High |
| 3 Agents | Agent interface id/name/version/description/capabilities/status/start/stop/health/handleEvent + AgentRegistry + 7 agents incl. Research/Backtest | Ad-hoc classes with name/start/stop/isRunning only; no registry, no version/capabilities/health, missing Research/Backtest, no handleEvent contract | High |
| 4 Tools | Tool {id,name,description,inputSchema,outputSchema,execute,permissions} callable by agents, finance examples | No Tool concept; logic embedded in agents; no schema, no permissions | High |
| 5 Plugins | Pluggable plugin architecture (agents+tools+handlers+adapters), examples Binance/MarketData/News etc. | No plugin system; ccxtWrapper is closest but not pluggable | High |
| 6 Market Data | ExchangeAdapter abstraction + BinanceAdapter + normalized Ticker/Candle/OrderBook/Trade + publishes market.tick/candle/orderbook + reconnection handling | Raw fetchBinancePrice + synthetic only; no adapter, no candles/orderbook/trades, no subscription, no normalization boundary | Critical |
| 7 Market State | MarketState service (latest prices/candles/orderbook/metadata/connection/lastUpdate, real-time vs historical, retention, stale detection, API exposure) | No state service; MarketAgent history is tick-only in-memory, no candles/orderbook, no stale detection, ticks endpoint is mock | High |
| 8 Quant | Strategy interface + 6 strategies + SIGNAL model (id,symbol,side,strategy,timeframe,price,confidence,timestamp,indicators,reasoning,expiration) | QuantAgent hard-coded confluence of 4 indicators, no Strategy interface, no registry, side is buy/sell/hold lowercase, no timeframe/strategy/ids | High |
| 9 Strategy Registry | StrategyRegistry pluggable | No registry; adding strategy requires editing QuantAgent | Medium |
| 10 Risk | Deterministic RiskEngine covering maxPositionSize/orderSize/portfolioExposure/symbolExposure/dailyLoss/drawdown/openPositions/strategyExposure/leverage/cooldown/stop-loss, decision {APPROVED|REJECTED + reason+rules+qty+metrics} | RiskAgent covers 5 checks partially; missing many rules; decision is RiskDecision but not enforced gateway, execution can be called directly | Critical |
| 11 Gateway | Finance Gateway agents → risk → portfolio → execution permission, auditable | No gateway; PortfolioAgent directly consumes risk:approved→execution without permission checks; agents can publish portfolio:order bypassing risk | Critical |
| 12 Portfolio | Portfolio Manager backend source of truth, Position model, updates from execution events | PortfolioAgent implements most but position lacks entryPrice/markPrice/fees/exposure, no equity; still in-memory only, no persistence; dashboard still has fallback mock | High |
| 13 Orders | OrderManager with states CREATED/PENDING/SUBMITTED/PARTIALLY_FILLED/FILLED/CANCELLED/REJECTED/FAILED | No order manager; ExecutionAgent emits Fill but no state machine | High |
| 14 Paper Broker | BrokerAdapter + PaperBroker (paper default, gated), market/limit/fills/fees/slippage/balances/positions/PnL/history | ExecutionAgent paper sim is close but not isolated BrokerAdapter; config only checks EXECUTION_MODE, no LIVE_TRADING_ENABLED double-gate | Medium |
| 15 Trades | Trade {id,symbol,strategy,entry,exit,qty,entryPrice,exitPrice,fees,PnL,openedAt,closedAt} | No trade concept; fills update positions but no trade entity | Medium |
| 16 Persistence | PostgreSQL + Prisma/ORM, models User/Account/Exchange/Agent/Strategy/MarketCandle/Signal/RiskDecision/Order/Fill/Position/Trade/PortfolioSnapshot/Event/AuditLog, migrations, encrypted secrets | File JSON Storage only; no DB, no ORM | Critical |
| 17 State Recovery | Survive restart: recover portfolio/positions/orders/trades/strategyConfig/agentState | In-memory only; storage holds channels/threads/messages but not finance state; restart loses all | Critical |
| 18 Memory | Agent memory (state/decisions/signals/trades/research/strategy performance/risk/user context) | No memory system | Medium |
| 19 Backtesting | History→Strategy→Signal→Risk→Simulation→Portfolio→Performance | No backtester; strategies coupled to live ticks only | High |
| 20 SSE | GET /api/events robust (filter/replay/heartbeat/reconnect/shutdown) for all finance categories | SSE exists with heartbeat 15s + replay + filter + lastEventId, but limited categories | Medium |
| 21 REST API | ~15 endpoints health/agents/market/candles/orderbook/signals/strategies/risk/portfolio/orders/trades/execution/events with validation | Only 6 routes (health/state/portfolio/ticks/publish/events); missing many | High |
| 22 Audit | Complete audit log with correlationId | No audit; risk rejectedLog is closest | High |
| 23 Security | Env validation, secret protection, auth architecture, agent/tool/execution permissions, no secrets to frontend/SSE/logs | No validation beyond type checks; no auth, no permissions | High |
| 24 Live Binance | BinanceBroker architecture, double-gated LIVE | Single gate EXECUTION_MODE only | Medium |
| 25 Dashboard Integration | Real backend data, no fakes presented as real | Dashboard shows mock portfolio/market when API fails — misleading | High |
| 26 Windows | pnpm install/dev/build/start without Docker | Documented needs Windows Node for localhost NAT, otherwise works; no packaging yet | Low |
| 27 Testing | Unit/integration for all finance calculations + failure tests | Zero tests; test-e2e.mjs is manual curl after boot | Critical |
| 28 Docs | README + docs/ covering all above | README covers quick start + API table + agents 6 lines; no docs/ prior to this file | Medium |

---

## 6. Problems & Technical Debt

### 6.1 Mock Data as Real Data (Financial Safety)
- `core/server.ts:10` `mockPortfolio()` and `mockTicks()` are returned from real endpoints `/api/portfolio` and `/api/market/ticks`. Dashboard (`page.tsx:253`) falls back to hard-coded holdings when `portfolio` is null — rendered as if truth. No labeling as `DEMO` or `MOCK`.
- MarketAgent synthetic ticks and dashboard MarketChart synthetic points have no `isReal` flag exposed via API consistently (internal `source:binance|synthetic` not propagated).

### 6.2 No Type Safety on Finance Events
- `eventBus.ts:7` `FinanceEvent.type: string` — any string passes; no union of allowed finance event names, no zod/validation. `publish()` only checks non-empty string. CorrelationId absent, so tracing `market:tick → signal → risk → portfolio → execution` is impossible.

### 6.3 Storage vs. Finance State Mismatch
- File Storage holds chat-like entities (channels/threads/messages) inherited from OpenBot. Finance state (portfolio, positions, orders, trades, signals) is in-memory on agents — not persisted, not part of storage. Replay of chat history does not replay finance history for state reconstruction.

### 6.4 Direct Binance Coupling (Partial)
- `market/service.ts:45` `fetchBinancePrice` is the only exchange touchpoint — no adapter, no normalized interface. Adding Bybit/OKX/Coinbase requires touching MarketAgent.

### 6.5 No Enforcement Before Execution
- RiskAgent publishes `risk:approved` but PortfolioAgent trusts any `risk:approved` event (no source verification). ExecutionAgent trusts any `portfolio:order`. A malicious or buggy agent could publish `portfolio:order` directly, bypassing risk.

### 6.6 No Tests, Lint, or Build Guardrails
- No test runner in package.json. No eslint. `ci.yml` runs `tsc --noEmit && pnpm build` but no lint/test. No coverage gates for finance calculations.

### 6.7 Duplication & Naming Drift
- Event name drift: Market emits `market:tick` vs spec `market.tick`; quant emits `signal:buy` vs `quant.signal`; risk emits `risk:approved` vs `risk.approved`. Dashboard api.ts listens to both (defensive), but canonical names need consolidation.
- Multiple portfolio shapes: mockPortfolio (server.ts), PortfolioSnapshot (portfolio agent), Position (3 variants across risk/portfolio/execution).

### 6.8 Dashboard More Developed Than Backend
- Dashboard is 460-line polished dark UI with 6 sections, SSE, polling, chart — but backend only exposes 2 mock data endpoints. Balance is inverted: backend must catch up before more dashboard polish.

---

## 7. How Closely Current Matches Target Finance Agent Platform

| Target Pillar | Current Score | Notes |
|---------------|---------------|-------|
| Runtime (lifecycle, registries) | 10% | Basic boot in index.ts, no registries |
| Event Bus (typed, validated, replay) | 40% | Solid mechanics, missing finance typing/validation/correlation |
| Agents (7, via bus, registry) | 50% | 5 agents work end-to-end, missing Research/Backtest, registry/health |
| Tools | 0% | No tool system |
| Plugins | 5% | Only ccxtWrapper as proto-plugin |
| Market Data (adapters, normalized, resilient) | 15% | Synthetic + real fetch, no adapter/candles/orderbook |
| Market State | 5% | No service |
| Quant/Strategies | 30% | Pure indicators solid, no Strategy interface/registry |
| Risk Engine | 35% | 5 checks, good metrics, missing 5+ rules + gateway enforcement |
| Gateway/Governance | 0% | No gateway |
| Portfolio | 45% | Good sizing/PnL, in-memory only, incomplete model |
| Orders/Trades | 20% | ExecutionAgent has fills but no order state machine/trades |
| Broker (paper vs live) | 35% | Paper sim exists but not isolated, single gate |
| Persistence | 5% | File JSON for chat, not finance |
| Recovery/Memory/Backtest | 0% | None |
| SSE/API/Audit/Security | 30% | SSE solid but limited, 6/15 APIs, no audit/auth |
| **Overall** | **~18%** | Prototype tier — correct philosophy, missing platform |

Architecture philosophy inspiration from OpenBot (event-driven, agents, plugins, SSE, storage) is respected; domain translation to finance has started but is shallow.

---

## 8. What to Preserve (Do Not Throw Away)

- **EventBus mechanics** — history trimming, subscriber isolation, replay, filtered subscribe, SSE heartbeat 15s, lastEventId resume. Evolve to typed finance events, keep implementation.
- **Pure finance functions** — `strategies.ts`, `metrics.ts`, `allocation.ts` are high-quality, deterministic, test-friendly. Extract into shared core and reuse across Quant/Risk/Portfolio/Backtest.
- **Agents pipeline** — Market → Quant → Risk → Portfolio → Execution flow is correct and should remain; wire it through typed gateway later.
- **Fastify SSE implementation** — robust raw-write + flushHeaders + graceful close; keep and broaden.
- **Dashboard UI** — `page.tsx` layout, polling + SSE hybrid, canvas MarketChart, AgentStatus cards. Fix to not show fakes as real, then deepen with real streams.
- **Monorepo + pnpm + staging conventions** — keep, add lint/test/build scripts per workspace.
- **ccxtWrapper** mock/real switch — keep as foundation for BrokerAdapter.
- **CI/Pages workflows** — keep, add test/typecheck/lint gates.

---

## 9. What to Refactor / Replace

| Area | Action | Rationale |
|------|--------|-----------|
| `FinanceEvent` | Add `source, correlationId, metadata, schema version, strict union type`, validate with Zod | Traceability + safety |
| `server.ts` mock endpoints | Move mockPortfolio/mockTicks to `PaperBroker` / `MarketState` or mark as `GET /api/demo/*`, return 503 or labelled demo when not available | No fakes as real |
| `market/service.ts` | Replace with `ExchangeAdapter` interface; keep synthetic as `SyntheticAdapter`; Binance becomes adapter impl | Extensibility |
| Agent constructors | Inject `FinanceRuntime` (bus, config, registries, logger) instead of raw bus | Lifecycle + testability |
| Storage | Evolve file JSON to hold finance snapshots short-term; introduce Prisma/Postgres behind same Storage interface for Phase 16 | Persistence without rewrite |
| Event names | Canonicalize to `domain.action` dot notation per spec (`market.tick`, `quant.signal`, `risk.approved` etc.) with compatibility shims | Spec alignment |
| Portfolio/Position/Order shapes | Unify via shared `packages/core/src/models` (or `apps/server/src/models`) single source of truth | Deduplication |
| Dashboard fallbacks | Replace hard-coded `$125,430` etc. with `null` + skeleton or explicit `DEMO` badge + link to Paper mode | Honesty |

---

## 10. Target Architecture (Finance-Native, OpenBot-Inspired)

```
                         WINDOWS FINANCE APP
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
              Dashboard       Terminal        REST API (Fastify)
                  │              │               │
                  └──────────────┼───────────────┘
                                 ▼
                          FINANCE RUNTIME   ←  Phase 1
                    (lifecycle, config, registries, logging, health)
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
              AGENTS           TOOLS           PLUGINS   ← Phases 3-5
                │                │                │
       ┌────────┼────────┐       │      ┌─────────┼──────────┐
       ▼        ▼        ▼       │      ▼         ▼          ▼
    Quant    Risk   Portfolio  Tool   Binance  MarketData  Research
       │       │        │    Registry  Plugin   Plugin     Plugin
    Execution Research Backtest  │
       │                      │
       └──────────┬───────────┘
                  ▼
               EVENT BUS        ←  Phase 2 (typed, validated, replay)
        market.*  quant.*  risk.*  portfolio.*  execution.*  trade.*  agent.*  system.*
                  ▼
            FINANCE GATEWAY     ←  Phase 11 (permissions, risk, mode, audit)
                  ▼
            RISK ENGINE         ←  Phase 10 (deterministic, rejecting)
                  ▼
           PORTFOLIO ENGINE     ←  Phase 12 (source of truth)
                  ▼
           ORDER MANAGER        ←  Phase 13 (state machine)
                  ▼
           EXECUTION LAYER      ←  Phases 13-14
             ┌─────┴─────┐
             ▼           ▼
          PAPER       LIVE BROKER  ←  Phase 24 (double-gated)
          BROKER         │
             │           ▼
             │        BinanceAdapter  (ExchangeAdapter → normalize)
             │         Bybit/OKX/Coinbase (future)
             │
        TRADE ENGINE            ←  Phase 15

Supporting Systems:
  Database (Prisma + Postgres + migrations) ←  Phase 16
  Memory (structured now, semantic later)   ←  Phase 18
  State Store + Recovery                    ←  Phase 17
  Audit Log (append-only)                   ←  Phase 22
  Backtesting (reuse Strategy)              ←  Phase 19
  Strategy Registry + Agent Registry        ←  Phases 9, 3
  Market State Service                      ←  Phase 7
  Quant Engine                              ←  Phase 8

Clients:
  Dashboard = one consumer of SSE + REST (not source of truth)
  SSE: GET /api/events (typed, filtered, replay, heartbeat) ← Phase 20
  REST: 15+ endpoints (health/agents/market/candles/orderbook/signals/strategies/risk/portfolio/orders/trades/execution) ← Phase 21
  Security: env validation, secret encryption, RBAC, no secrets to frontend ← Phase 23
  Tests & Hardening: unit/integration + failure injections ← Phase 27
  Docs: ARCHITECTURE, RUNTIME, AGENTS, TOOLS, PLUGINS, EVENTS, MARKET-DATA, STRATEGIES, RISK, PORTFOLIO, EXECUTION, BACKTESTING, API, SECURITY, DEVELOPMENT ← Phase 28
```

---

## 11. Component Responsibilities

| Component | Responsibility | Lives In | Depends On |
|-----------|---------------|----------|------------|
| Finance Runtime | App lifecycle, config (zod), service/agent/plugin/tool registries, DI, logger, error boundary, health aggregate | `apps/server/src/core/runtime.ts` (new) | EventBus, Storage, Config |
| EventBus | Typed publish/subscribe/replay/history, validation, correlation propagation, metrics | `core/eventBus.ts` (evolve) | — |
| Agent Framework | Interface + registry, lifecycle (start/stop/restart/health), handleEvent routing, isolation | `core/agent.ts`, `core/agentRegistry.ts` | EventBus, Runtime |
| Tool System | Tool interface + registry, JSON Schema I/O, permissions, execution via gateway | `core/tool.ts` | EventBus, Gateway |
| Plugin System | Plugin manifest (agents+tools+events+adapters), install/enable/disable, dependency graph | `core/plugin.ts` | Runtime registries |
| ExchangeAdapter | Normalized Ticker/Candle/OrderBook/Trade, connect/disconnect/get*/subscribe*, reconnection, stale detection | `adapters/exchangeAdapter.ts`, `adapters/binanceAdapter.ts` | EventBus |
| Market State | Latest state + history window, retention, staleness flag, expose via API | `services/marketState.ts` | ExchangeAdapter, EventBus |
| Quant Engine | Strategy interface, indicators, signal model, timeframe handling | `services/quant.ts`, `strategies/` | MarketState, EventBus |
| Strategy Registry | Pluggable registry, persistence | `core/strategyRegistry.ts` | Storage/DB |
| Risk Engine | Deterministic rules (10+), decision, metrics, no bypass | `services/risk.ts` | Portfolio, Storage |
| Finance Gateway | Request→Risk→Portfolio→Execution permission chain, audit point | `services/gateway.ts` | Risk, Portfolio, Audit |
| Portfolio Engine | Positions/PnL/fees/exposure, source of truth, from execution events | `services/portfolio.ts` | EventBus, Storage |
| Order Manager | Order state machine, lifecycle events per transition | `services/orderManager.ts` | EventBus, Gateway |
| Paper Broker + BrokerAdapter | Sim fills/fees/slippage/balances, default; live adapter gated | `brokers/paperBroker.ts`, `brokers/brokerAdapter.ts` | Execution |
| Trade Engine | Orders↔Trades distinction, open/update/close, PnL calc | `services/tradeEngine.ts` | OrderManager, Portfolio |
| Database/Persistence | Prisma models, migrations, encrypted secrets | `prisma/schema.prisma` | Postgres (or file during dev) |
| State Recovery | Hydrate from DB on boot, snapshots | `core/recovery.ts` | Storage/DB |
| Memory | Per-agent structured memory + future vector | `services/memory.ts` | Storage |
| Backtest Engine | Historical replay through same strategy/risk/execution/portfolio pipeline | `services/backtest.ts` | Quant, Risk, Portfolio |
| SSE | Typed streams, filtering, replay, heartbeat, backpressure | `core/server.ts` SSE handler | EventBus |
| REST API | Validated endpoints (zod), error envelopes | `core/server.ts` routes | All services |
| Audit Log | Append-only ledger of signal/risk/order/fill/trade/portfolio/agent/tool | `services/audit.ts` | EventBus, Storage |
| Security | Env validation, secret vault, auth, RBAC | `core/security.ts` | Config |

---

## 12. Event Flow (Canonical, dot-notation)

```
                    ┌────────────────────┐
                    │  ExchangeAdapter   │
                    │  BinanceAdapter    │  reconnect, normalize
                    └────────┬───────────┘
                             │ market.tick / candle / orderbook / trade
                             ▼
                    ┌────────────────────┐
                    │  MarketState       │  retention, staleness
                    └────────┬───────────┘
                             │ market.candle (primary for quant)
                             ▼
                    ┌────────────────────┐
                    │  Quant Agent       │  Strategy.calculate() → Signal
                    │  (EMA/RSI/MACD…)   │  side BUY/SELL/HOLD, confidence, timeframe, indicators, reasoning
                    └────────┬───────────┘
                             │ quant.signal  {id,symbol,side,strategy,timeframe,price,confidence,timestamp,indicators,reasoning,expiration,correlationId}
                             ▼
                    ┌────────────────────┐
                    │  Finance Gateway   │  auth: agent/tool permissions
                    └────────┬───────────┘
                             │ risk.check
                             ▼
                    ┌────────────────────┐
                    │  Risk Engine       │  10+ deterministic rules
                    └────────┬───────────┘
                      ┌──────┴──────┐
                      │             │
                risk.approved   risk.rejected
                      │             │ → audit + agent notification
                      ▼
        ┌────────────────────────┐
        │  Portfolio Agent       │  calculate_position_size, check exposure
        └───────────┬────────────┘
                    │ order.created
                    ▼
        ┌────────────────────────┐
        │  Finance Gateway       │  execution permission, mode check
        └───────────┬────────────┘
                    │ order.submitted
                    ▼
   ┌─────────────────────────────┐
   │  Execution Layer            │
   │  PaperBroker (default)      │  fills, fees, slippage, latency
   │  BinanceBroker (live, gated)│  double gate EXECUTION_MODE=live && LIVE_TRADING_ENABLED=true
   └──────────┬──────────────────┘
              │ order.filled / partially_filled / cancelled / rejected / failed
              │ trade.opened / closed
              ▼
        ┌────────────────────┐
        │  Portfolio Engine  │  positions, realized/unrealized PnL, equity
        └─────────┬──────────┘
                  │ portfolio.updated / position_changed
                  ▼
        ┌────────────────────┐
        │  Audit Log + Memory│  append signal/risk/order/fill/trade/portfolio
        └─────────┬──────────┘
                  │ system.health / agent.error via bus
                  ▼
        ┌────────────────────┐
        │  SSE + REST Clients│  Dashboard (one client), Terminal, API consumers
        └────────────────────┘

No path may bypass Gateway→Risk. PAPER is default; LIVE requires explicit double opt-in.
```

---

## 13. Data Flow

- **Market Data In** — Binance REST/WS → ExchangeAdapter.normalize() → MarketState (latest + ring buffer, flags stale if no update > threshold) → publish market.* to bus → persist candles if DB enabled.
- **Signal Generation** — MarketState candles → Quant Engine per-strategy calculate() → Signal (id, symbol, side BUY/SELL/HOLD, strategy id, timeframe, price, confidence, indicators, reasoning, expiration, correlationId chained from tick).
- **Risk Gate** — Gateway receives signal + agent identity → RiskEngine.evaluate(signal, portfolio, strategyConfig, limits) → RiskDecision {APPROVED|REJECTED, reason, rulesChecked, requestedQty, approvedQty, riskMetrics, timestamp, correlationId} → publish risk.* → audit.
- **Order Lifecycle** — approved → OrderManager.create() (CREATED) → Gateway checks execution permission → SUBMITTED → BrokerAdapter.submit() → PARTIALLY_FILLED/FILLED/CANCELLED/REJECTED/FAILED per broker events → each transition publishes order.* → audit.
- **Trade & Portfolio** — fills → PortfolioEngine applies cash/position AvgEntry/MarkPrice/fees → recalc realized/unrealized PnL, exposure → publish portfolio.* → TradeEngine opens/updates/closes trades → audit + memory.
- **Clients** — Dashboard polls REST for snapshot, subscribes SSE for live streams; terminal and API consumers use same SSE + REST contract.

---

## 14. Implementation Roadmap (Phases 1–28, Sequential)

> Each phase: inspect → design → implement → tests → typecheck → lint → build → fix → docs → commit → push.

| Phase | Title | Deliverable | Pre-req |
|-------|-------|-------------|---------|
| 0 | **Audit** | This doc (`docs/ARCHITECTURE.md`) + commit `docs: add architecture audit` | — |
| 1 | **Core Finance Runtime** | `core/runtime.ts` with lifecycle, config (zod), service/agent/plugin/tool registries, logger, health; agents decoupled; dashboard = client | 0 |
| 2 | **Typed Event Bus** | FinanceEvent {id,type,timestamp,source,correlationId,data,metadata} + categories + zod validation + publish/subscribe/unsubscribe/replay/history + tests | 1 |
| 3 | **Agent Framework** | Agent interface + AgentRegistry + 7 agents (add Research/Backtest) via bus | 2 |
| 4 | **Tool System** | Tool interface + registry, permissions, 13+ finance tools callable by agents, no bypass risk | 3 |
| 5 | **Plugin System** | Plugin architecture (agents+tools+handlers+adapters) | 4 |
| 6 | **Market Data Platform** | ExchangeAdapter + BinanceAdapter + normalized models + publish market.tick/candle/orderbook + reconnection handling | 2 (parallel 5) |
| 7 | **Market State** | MarketState service, retention, stale detection, API exposure | 6 |
| 8 | **Quant Engine** | Strategy interface + 6 strategies + Signal model, market.candle→quant.signal deterministic | 7 |
| 9 | **Strategy Registry** | Pluggable registry | 8 |
| 10 | **Risk Engine** | Deterministic rules 10+, APPROVED/REJECTED decision model, extensive tests | 8/9 |
| 11 | **Finance Gateway** | Request→Risk→Portfolio→Execution gate, auditable | 10 |
| 12 | **Portfolio Engine** | Backend source of truth | 11 |
| 13 | **Order Management** | Order state machine (8 states) | 12 |
| 14 | **Paper Broker** | BrokerAdapter + PaperBroker (paper default, realistic) | 13 |
| 15 | **Trade Engine** | Orders↔Trades separation, PnL | 14 |
| 16 | **Database** | Postgres + Prisma, models, migrations, encrypted secrets | 1 (design early) |
| 17 | **State Recovery** | Restart restores portfolio/positions/orders/trades | 16 |
| 18 | **Memory** | Structured persistent memory, semantic-ready | 17 |
| 19 | **Backtesting** | Same Strategy via Historical→Signal→Risk→Simulation→Portfolio→Performance | 8,11,14 |
| 20 | **SSE** | Robust `GET /api/events` | 2 |
| 21 | **REST API** | 15 endpoints validated | 20 |
| 22 | **Audit System** | Append-only audit | 21 |
| 23 | **Security** | Env validation, secret encryption, auth, RBAC | 22 |
| 24 | **Live Binance Adapter** | Live double-gated | 14,23 |
| 25 | **Dashboard Integration** | Wire real backend data, remove fakes | 24 |
| 26 | **Windows Support** | pnpm install/dev/build/start without Docker | 25 |
| 27 | **Testing & Hardening** | Unit/integration/e2e + failure injections | Every prior |
| 28 | **Documentation** | README + 16 docs reflecting actual impl | Every prior |

---

## 15. Decisions & Constraints

| Decision | Rationale |
|----------|-----------|
| Keep file Storage as dev persistence, introduce DB behind same interface | Avoids rewrite, Windows-friendly, incremental migration |
| Keep Fastify 5 + EventSource SSE (no Socket.IO) | Light, typed, cross-origin, replay-friendly, OpenBot-aligned |
| No random signals; all signals from real market data or labelled synthetic | Financial safety + audit |
| Paper default, live double-gated | Prevents accidental real orders; safety > velocity |
| Dashboard never source of truth | Backend validates, audits, persists |
| pnpm 9, strict TS, NodeNext ESM | Leverage existing |
| No vector DB until needed | Structured memory suffices early |

---

## 16. Risks

- **Mock leakage** — if dashboard/backend ships with `mockPortfolio` still bound to `/api/portfolio`, users may trust fake P&L. Mitigation: Phase 6–7 moves mock to PaperBroker/MarketState or `GET /api/demo/*`, adds badge.
- **Event name breakage** — changing `market:tick`→`market.tick` breaks dashboard filters. Mitigation: versioned mapping + shims, dashboard updated in lockstep (Phase 20/25).
- **In-memory loss** — until Phase 17, restart wipes positions. Mitigation: soft snapshot to file storage interim.
- **No tests until Phase 27** risks regression. Mitigation: per-phase tests as gates.
- **Windows NAT localhost** — server must run on Windows Node for browser localhost proxy. Mitigation: Phase 26 documents and automates.

---

## 17. Phase 0 Completion Checklist

- [x] Inspected package.json, pnpm-workspace, tsconfig, apps/server, apps/dashboard, all agents, EventBus, storage, SSE, Binance code, components, env, tests, docs, workflows, README
- [x] Determined: works / incomplete / duplicated / preserved / refactored / missing / match score (see §4–9)
- [x] Created `docs/ARCHITECTURE.md` with current, problems, target, responsibilities, event flow, data flow, roadmap
- [x] Do not rewrite during Phase 0 — audit only
- [x] Next: commit `docs: add architecture audit` and push to https://github.com/namana843-bit/finance-agent-os

