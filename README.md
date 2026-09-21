# Finance Agent OS — Autonomous Multi-Agent Trading Platform

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

An event-driven autonomous financial operating system powered by specialized collaborating trading agents (`Supervisor` → `Market` → `Quant` → `Risk` → `Portfolio` → `Execution`) with SSE Event API and Electron/React Desktop Dashboard. Paper-only by default — live trading is gated behind `LIVE_TRADING_ENABLED` and HMAC approval tickets.

## ✨ Features

- **6 autonomous agents** communicating via `TypedEventBus` (`packages/core/src/event-bus.ts:1`)
- **7-stage execution pipeline** — Signal Validation → LoopGuard → KillSwitch → HardLimits → Risk HMAC Ticket → Gateway → OrderManager → PaperBroker
- **Real backtesting** — zero look-ahead, `next_bar_open` execution, slippage/spread/fees, Sharpe/Sortino/CAGR/Drawdown/ProfitFactor
- **File-persisted Agent Memory** — no SQLite hang: `memory/agent-memory.json` + `traces.jsonl` (5MB rotate, TTL cleanup)
- **Desktop OS** — Vite + React 18 + Electron trading desk (alpha lab, risk, telemetry, orderbook, PnL)
- **Fastify SSE API** on `:4132` — 40+ REST endpoints + event stream
- **Opencode CLI Gateway** — permissioned `opencode --version` path allowlist with `useShell=false`

## 🏛️ System Architecture

```
                                     User
                                      │
                      Desktop OS (Vite + React 18 + Electron)
             ┌────────────────────────┼────────────────────────┐
             │                        │                        │
      Trading Desk UI         Multi-Agent Rooms       Live Telemetry & Signals
     (AlphaQuant, Risk,     (Live Trading Floor,      (Orderbook, VaR, TWAP,
      ExecRouter, Intel)       Alpha Lab, Risk)        PnL & Active Alphas)
             │                        │                        │
             └────────────────────────┼────────────────────────┘
                                      │  HTTP REST / SSE Stream
                                      ▼
                             Fastify Server (:4132)
                                      │
                     FinanceRuntime (@finance/core)
      ┌───────────────────────────────┼───────────────────────────────┐
      │                               │                               │
TRADING AGENTS                     TOOLS                         SERVICES
  • Supervisor (Coordinator)       • Market Depth / OHLCV        • FinanceGateway
  • AlphaQuant (Quant/Signals)     • Volatility Surface / RSI    • OrderManager (Canonical)
  • RiskSentinel (VaR/Drawdown)    • Portfolio Margin / Risk     • PaperBroker (Risk-Gated)
  • ExecRouter (TWAP/Slippage)     • Strategy Backtesting (21+)  • BinanceRuntime (Read-Only)
  • MarketIntel (Order Flow/CVD)   • Exchange Providers          • ExecutionSimulator
  • PortfolioLead (NAV/Rebalance)  • Memory Traces (Sanitized)   • ExecutionPipeline
      │                               │                               │
      └───────────────────────────────┼───────────────────────────────┘
                                      ▼
                    TypedEventBus (Event-Driven Backbone)
                                      │
                             Execution Pipeline
      ┌───────────────────────────────────────────────────────────────┐
      │  1. Signal Validation (Schema & Numeric Verification)          │
      │  2. Anti-Loop Guard (Recursion & Burst Cooldown)              │
      │  3. Emergency Kill Switch Gate (Circuit Breaker)              │
      │  4. Hard Non-Bypassable Limits (Notional, Exposure, Drawdown) │
      │  5. Cryptographic Risk Gate (HMAC-SHA256 Ticket)              │
      │  6. Permission & Rate Limiter (FinanceGateway)                │
      │  7. Canonical Order Manager (Terminal States, Persistence)    │
      └───────────────────────────────┬───────────────────────────────┘
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                   PAPER BROKER             LIVE BROKER (Gated)
             (Enforces HMAC Ticket)        (Strict Read-Only Binance)
                        │                           │
                        ▼                           ▼
                 Paper Portfolio            Exchange Liquidity
                        ▲                           │
                        └───── Drift Reconciliation ┘
```

---

## 🛡️ Production Safety & Execution Pipeline

```mermaid
flowchart TD
    Sig[Signal / Proposal] --> V[1. Signal Validation]
    V --> LG[2. Anti-Loop Guard]
    LG --> KS[3. Kill Switch]
    KS --> HL[4. Hard Limits]
    HL --> RG[5. HMAC-SHA256 Risk Gate]
    RG --> GW[6. Gateway Permissions]
    GW --> OM[7. OrderManager]
    OM --> PB[Paper Broker]
    PB --> Rec[Reconciliation]
    LG -- depth>5 / burst --> Rej[Rejected & Audited]
    KS -- halt --> Rej
    HL -- exceeds limit --> Rej
    RG -- missing/expired --> Rej
```

1. **Signal Validation** — symbol/side/price/quantity + `agentId`; planner `extractQuantity` strictly requires `qty:` or `<n> BTC|ETH|SOL`
2. **Anti-Loop Guard** (`LoopGuard`) — max depth 5, per-symbol cooldown, dedup via payload hash
3. **Emergency Kill Switch** (`KillSwitch`) — cancels all open orders, emits `audit.kill_switch_activated`, live mode requires `KILL_SWITCH_OVERRIDE_KEY`
4. **Hard Limits** — notional, exposure, drawdown, concurrent orders
5. **Risk Ticket** (`ticket.ts`) — HMAC-SHA256, TTL 30s, replay prevention
6. **OrderManager** — `CREATED→PENDING→SUBMITTED→PARTIALLY_FILLED→FILLED`, atomic `writeFileAtomic`, unified `DATA_DIR`
7. **Reconciliation** — phantom order / drift detection

---

## 🤖 Agents — Where is my AI agent?

All agents live in `apps/server/src/agents/` and are wired in `apps/server/src/core/runtime.ts:253-264`:

| Agent | Path | Role |
| :--- | :--- | :--- |
| **`Supervisor`** | `agents/supervisor/index.ts` | Orchestrator — planner `task → Market → Quant → Risk → Portfolio → Execution`, LoopGuard, proposal validation |
| **`Market`** | `agents/market/index.ts` | Binance REST/WS, OHLCV, orderbook, synthetic fallback |
| **`Quant`** | `agents/quant/index.ts` | RSI/EMA/MACD/Bollinger, strategy signals, expected returns |
| **`Risk`** | `agents/risk/index.ts` | VaR 99%, margin/drawdown, HMAC ticket issuance, kill-switch |
| **`Portfolio`** | `agents/portfolio/index.ts` | Balances, positions, NAV, rebalancing |
| **`Execution`** | `agents/execution/index.ts` | TWAP/VWAP slicing, PaperBroker orders, slippage |
| **`Demo`** | `agents/demo-agent/index.ts` | Demo/test agent |
| **LLM Bridge** | `llm/agent-runtime.ts` + `llm/engine-manager.ts` + `llm/cli-session.ts` | `ProviderRegistry`/`EngineManager`/`CliSessionManager` for opencode `AgentRuntime` |

Talk to them: `SupervisorAgent.submitTask("buy 0.1 BTC if RSI <30")` → `bus.publish({type:"supervisor.task"})` → fan-out. Via HTTP: `POST /api/chat` or `POST /api/publish`.

## 🧰 Tech Stack

| Layer | Tech |
| :--- | :--- |
| Runtime | Node 22, TypeScript 5.6, pnpm 9 workspaces |
| Server | Fastify 5 + `@fastify/cors`, `ws` 8, `uuid`, `tsx` watch |
| Core | `packages/core` `TypedEventBus` + `FinanceRuntime` + `BaseServiceWrapper` (`apps/server/src/core/service-wrapper.ts`) |
| Dashboard | React 18 + Vite + Electron, `shadcn/ui`, `lib/fetch.ts` (deduped `fetchJson`), `lib/clipboard.ts` |
| DB | Prisma 5 (slim 9 models) + SQLite `file:./prisma/dev.db` + file-persisted `AgentMemory` |
| Tests | Vitest 3 |

## 📁 Repository Structure

```
finance-agent-os/
├── apps/
│   ├── dashboard/                  # Desktop App (React 18 + Vite + Electron :5173)
│   │   ├── electron/               # main & preload
│   │   ├── src/lib/fetch.ts        # shared fetchJson (deduped)
│   │   ├── src/lib/clipboard.ts    # useClipboard hook
│   │   └── src/components/ui/*     # shadcn/ui
│   └── server/                     # Fastify API (:4132) + Multi-Agent Runtime
│       ├── __tests__/              # engine/agent/CLI/resolver tests
│       └── src/
│           ├── agents/             # supervisor/planner, quant, risk(VaR), portfolio, execution, market, demo
│           ├── audit/              # immutable audit logs + correlation IDs
│           ├── backtesting/        # engine + execution-simulator + metrics (Sharpe/Sortino/CAGR/Drawdown)
│           ├── broker/             # PaperBroker
│           ├── core/               # LoopGuard, server, runtime, storage(DATA_DIR), service-wrapper
│           ├── environment/        # market/portfolio/paper adapters
│           ├── execution-pipeline/ # 7-stage gated pipeline
│           ├── gateway/            # FinanceGateway + OpencodeCliGateway (hardened) + OpencodeDaemon
│           ├── llm/                # ProviderRegistry, EngineManager, AgentRuntime, CliSession, persistence(DATA_DIR), engines(DATA_DIR)
│           ├── market/             # binance-rest/ws, normalizer, market-state
│           ├── memory/             # AgentMemory (file-persisted, sanitized)
│           ├── order-manager/      # OrderManager (writeFileAtomic + DATA_DIR)
│           ├── risk-engine/        # HMAC ticket
│           ├── safety/             # hard-limits, kill-switch (no default), reconciliation
│           ├── strategies/         # registry (EMA/RSI/MACD…)
│           ├── tools/              # finance-tools + indicators
│           └── utils/              # validation-helpers (asRecord/asString)
├── packages/
│   ├── core/                       # TypedEventBus, FinanceRuntime, BaseServiceWrapper
│   └── shared/                     # domain types, event schemas
├── prisma/                         # slim schema (9 models)
└── scripts/                        # scaffold via pnpm --filter @finance/server cli
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 22+, pnpm 9 (`npm i -g pnpm`), Windows/macOS/Linux

### 1. Install
```bash
pnpm install
```

### 2. Env
```bash
cp .env.example .env
# edit .env — see Environment table below
```

### 3. Build
```bash
pnpm build
# or pnpm --filter @finance/server build  # must be BUILD_OK
```

### 4. Dev
```bash
pnpm dev                    # server :4132 + dashboard :5173 in parallel
pnpm dev:server             # only Fastify on http://localhost:4132
pnpm dev:desktop            # only Vite on http://localhost:5173
pnpm desktop:electron       # native Electron window
```

### 5. Typecheck & Tests
```bash
pnpm typecheck              # tsc --noEmit across 5 workspaces
pnpm test                   # vitest run (server + core)
```

---

## ⚙️ Environment

`.env.example` → `.env` (gitignored). Key vars:

| Var | Default | Notes |
| :--- | :--- | :--- |
| `PORT` | `4132` | Fastify port |
| `HOST` | `0.0.0.0` | bind host |
| `EXECUTION_MODE` | `paper` | `paper` (safe) / `live` (requires kill-switch key) |
| `FINANCE_DATA_DIR` | `~/.finance-agent` | unified `DATA_DIR` for orders/memory/agents/engines — `apps/server/src/config.ts:6` |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` | CORS allowlist (no wildcard) — `core/server.ts:34` |
| `KILL_SWITCH_OVERRIDE_KEY` | *(none)* | **required in live mode**, ephemeral in paper — `safety/kill-switch.ts:75` |
| `DATABASE_URL` | `file:./prisma/dev.db` | no quotes, no `?connection_limit` — `prisma/schema.prisma:11` |
| `BINANCE_API_KEY/SECRET` | — | read-only market data |
| `BINANCE_WS_ENABLED` | `true` | live WS toggle |
| `OPENCODE_CLI_PATH` | — | opencode binary (auto-resolve via PATH + `PNPM_HOME` + `~/.opencode`) |
| `OPENCODE_GATEWAY_ENABLED` | `true` | opencode gateway toggle |

---

## 🔌 API Reference (Fastify `:4132`)

Base: `http://localhost:4132`

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | health + version |
| `GET` | `/api/agents` | list agents + status |
| `POST` | `/api/agents/:id/start` / `/stop` | lifecycle |
| `GET` | `/api/strategies` / `/api/strategies/:id/toggle` | registry |
| `GET` | `/api/signals?limit=&symbol=` | recent signals |
| `GET` | `/api/orders` / `/api/orders/:id` / `/api/orders/pending` | orders |
| `POST` | `/api/orders/:id/cancel` / `approve` / `reject` | order actions |
| `GET` | `/api/trades` | fills |
| `GET` | `/api/portfolio` + `/positions` `/history` `/allocation` | portfolio |
| `GET` | `/api/risk/status` `/metrics` | risk + VaR |
| `GET` | `/api/market/state` + `/api/market/candles?symbol=&limit=` `/orderbook` | market |
| `POST` | `/api/publish` | publish bus event (**denylist** `supervisor.|risk.|gateway.|order.|trade.proposal_`) — `core/server.ts:389` |
| `POST` | `/api/chat` + `GET /api/chat/history` `GET /api/threads` | chat/dialogue |
| `GET` | `/api/memory/stats` `GET /api/memory/traces?symbol=&limit=` `GET /api/memory/entries?agentId=&category=` `DELETE /api/memory` | AgentMemory (file-persisted) |
| `GET` | `/api/llm/engines` `/api/llm/providers` `/api/llm/usage` `/api/llm/models` | LLM layer |
| `GET` | `/api/opencode/cli-path` `/api/opencode/paths` `/api/opencode/gateway/stats` | opencode gateway |
| `GET` | `/.well-known/finance-agent/environment` | environment discovery |
| `SSE` | `/api/events` (via `TypedEventBus`) | real-time event stream |

Example:
```bash
curl http://localhost:4132/api/health
curl http://localhost:4132/api/agents
curl http://localhost:4132/api/memory/stats
curl "http://localhost:4132/api/memory/traces?symbol=BTCUSDT&limit=50"
curl -X POST http://localhost:4132/api/chat -H "Content-Type: application/json" -d '{"message":"analyze BTC risk"}'
```

## 🖥️ CLI

Server binary: `finance-agent` (`apps/server/package.json:6` `bin: finance-agent → dist/cli-entry.js`)

```bash
pnpm --filter @finance/server cli --help
node apps/server/dist/cli-entry.js help
pnpm --filter @finance/server cli status   # agents + services
pnpm --filter @finance/server cli add agent my-agent --template quant
```

## 💾 Unified Data Dir & Persistent Agent Memory

- **Single source**: `DATA_DIR = FINANCE_DATA_DIR || ~/.finance-agent` (`config.ts:6`). All services (`orders.json`, `memory/`, `agents.json`, `engines.json`) resolve under it — fixes `process.cwd()` divergence on Windows.
- **AgentMemory** (`memory/agent-memory.ts:1` `import * as path` — ESM safe): debounced 3s snapshot `memory/agent-memory.json` + append-only `traces.jsonl` (5MB rotate), 60s TTL cleanup, secret redaction, `writeFileAtomic` + `renameWithRetry` (Windows `EBUSY` safe), wired via `core/runtime.ts:143` `AgentMemoryService`.
- **Prisma slim**: 9 models only (hot `Event/AuditLog/MarketCandle` → in-memory/JSONL to avoid WAL lock). Generate: `pnpm prisma generate && pnpm prisma db push`.

## 🔐 Security Hardening (Audit 2026-09)

- **CORS** (`core/server.ts:34`): `origin:true+credentials:true` → `ALLOWED_ORIGINS` allowlist callback (fixes wildcard CSRF)
- **/api/publish** (`core/server.ts:389`): denylist `supervisor.|risk.|gateway.|order.|trade.proposal_|audit.kill_switch|opencode.` → `403`
- **Opencode gateway** (`gateway/opencode-cli-gateway.ts:285`): extended metachars `; & | $ > < \ ( ) { } [ ] ! % * ? ~`, per-arg `safeArgRe`, `useShell=false` even for `npx` fallback
- **Kill-switch** (`safety/kill-switch.ts:75`): no `EMERGENCY_OVERRIDE_SECRET_DEFAULT`; live throws if missing
- **Persistence**: unified `DATA_DIR` + `writeFileAtomic` (`atomic.ts:28`) across `storage.ts:45`, `llm/persistence.ts:7`, `llm/engines.ts:220`, `order-manager.ts:30`

## 🔬 Backtesting

- Zero look-ahead (window ends at bar `i`), `next_bar_open` / `current_bar_close`
- Slippage (bps) + spread (bps) + maker/taker fees + `maxVolumeParticipation: 0.10` + cash insolvency guard
- Metrics: Sharpe, Sortino, CAGR, Max Drawdown (+ duration), Win/Loss, Profit Factor, Expectancy

Run via `StrategyLab` (`strategy-lab/service.ts`) or `POST /api/backtest/run`.

## 🧪 Testing & CI

```bash
pnpm typecheck
pnpm --filter @finance/server test        # vitest
pnpm --filter @finance/core test
# CI: .github/workflows/ci.yml runs typecheck + tests on push/PR
```

PR: `fix/audit-hardening` → [#25](https://github.com/namana843-bit/finance-agent-os/pull/25) (dedupe `fetchJson`/`BaseServiceWrapper`/validation-helpers/clipboard + hardening + README).

## 🔒 License
MIT © Finance Agent OS
