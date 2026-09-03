# Finance Agent OS — OpenBot for Finance

Event-driven trading OS: 5 agents (Market → Quant → Risk → Portfolio → Execution) on a **single `TypedEventBus`** (`@finance/core`, `packages/core/src/event-bus.ts:1`) with `FinanceGateway` + `Paper/Live` broker. Cross-platform (Windows/Linux/Docker) — the finance-native equivalent of OpenBot. **No fake data:** dashboard shows `—` until `GET /api/portfolio` / `GET /api/market/ticks` return real data; ticks carry `source: binance|synthetic`.

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

> **Merged to `main`:** #1 actionable Quant, #2 prod hardening, #3 dashboard honesty + `pnpm openbot` scaffold, #4 portfolio single-truth + `BacktestPanel`, #5 single EventBus shim, #7 orders/trades single truth, #8 honest README, #9 OrdersPanel, #10 MarketMeta synthetic badges, #11 verify-honesty script.

## Architecture

```
                    FINANCE RUNTIME
                          │
          ┌───────────────┼───────────────┐
          ↓               ↓               ↓
       AGENTS           TOOLS          PLUGINS
          │               │               │
     ┌────┼────┐          │      ┌────────┼────────┐
     ↓    ↓    ↓          │      ↓        ↓        ↓
   Quant Risk Portfolio   │   Binance   Market   Research
     ↓    ↓    ↓          │
   Execution Portfolio    │
     │                    │
     └────────┬───────────┘
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
│   ├── shared/              # Shared types and models
│   └── core/                # Runtime, EventBus, Registries
├── apps/
│   ├── server/              # Fastify backend
│   │   └── src/
│   │       ├── core/        # Runtime, Server, EventBus
│   │       ├── agents/      # Market, Quant, Risk, Portfolio, Execution
│   │       ├── tools/       # Finance tools
│   │       ├── plugins/     # Binance plugin
│   │       ├── market/      # Exchange adapter, market state
│   │       ├── strategies/  # Strategy registry
│   │       ├── risk-engine/ # Risk engine
│   │       ├── broker/      # Paper broker
│   │       ├── order-manager/ # Order lifecycle
│   │       ├── trade-engine/  # Trade management
│   │       ├── backtesting/   # Backtesting engine
│   │       ├── memory/      # Agent memory
│   │       └── audit/       # Audit logging
│   └── dashboard/           # Next.js 14 dashboard
└── docs/                    # Documentation
```

## Agents

- **Market Agent** (`apps/server/src/agents/market/index.ts:100`) — Binance REST via `fetchTick()` (`source: binance`); without `BINANCE_API_KEY` emits synthetic ticks (`source: synthetic`) on 1500ms interval with explicit log; with key, REST polling only (synthetic on fetch failure). Dashboard badge `● BINANCE` / `○ SYNTHETIC` from `tick.source`.
- **Quant Agent** — Technical analysis: SMA, EMA, RSI, MACD, Bollinger Bands — **only publishes actionable `buy/sell`** when `confidence ≥0.6` + `2/4` confluence (no `hold` flood).
- **Risk Agent** (`apps/server/src/risk-engine/risk-engine.ts:39`) — `15s` per-symbol cooldown (`60s` rejected most signals when quant emits every `~2s`), confidence threshold, exposure/drawdown/leverage checks.
- **Portfolio Agent** — Position management, PnL tracking, Kelly criterion (fallback); **single truth is `PaperBroker`** (`apps/server/src/broker/paper-broker.ts` / `apps/server/src/core/server.ts:129`).
- **Execution Agent** — Paper and live trading via CCXT; fills feed `GET /api/trades` (`source: execution-agent`).

## Honesty & Single-Truth Notes

- **No fake dashboard data:** `apps/dashboard/src/app/page.tsx` shows `— awaiting /api/portfolio` and `No positions yet — paper trading starts with $100k cash` until the server returns data. `AgentStatus` fetches live `GET /api/agents`.
- **Portfolio single truth:** `GET /api/portfolio` + `GET /api/portfolio/positions` + `GET /api/orders` + `GET /api/trades` prefer `PaperBroker` (real fills) and add `source: paper-broker|execution-agent`.
- **Market honesty:** `tick.source` is `binance|synthetic`; with key, no duplicate synthetic flood (`apps/server/src/agents/market/index.ts:100-132`).
- **EventBus single truth:** canonical `TypedEventBus` is `packages/core/src/event-bus.ts:1`; `apps/server/src/core/eventBus.ts` is a shim re-export (`feat/bus-unification`).

## Event Pipeline

```
MarketAgent → market.tick (source: binance|synthetic) → QuantAgent → quant.signal (buy/sell only, ≥0.6 + 2/4)
                                         ↓
                                    RiskAgent (15s cooldown) → risk.approved/rejected
                                         ↓
                              FinanceGateway → order.created
                                         ↓
                                    ExecutionAgent → order.filled
                                         ↓
                               PaperBroker → portfolio.updated → dashboard
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
