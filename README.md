# Finance Agent OS — OpenBot-style Event-Driven Trading

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![Pages](https://github.com/namana843-bit/finance-agent-os/actions/workflows/pages.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Agents](https://img.shields.io/badge/Agents-5%20Market%7CQuant%7CRisk%7CPortfolio%7CExecution-violet)](apps/server/src/agents)
[![API](https://img.shields.io/badge/API-SSE%20%7C%20Event%20Bus-0ea5e9)](apps/server/src/core/server.ts)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black)](apps/dashboard)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000)](apps/server/src/core/server.ts)

Event API / SSE core with 5 autonomous finance agents — **Market → Quant → Risk → Portfolio → Execution → Binance/Broker**. Dashboard streams live via `EventSource` (`/api/events`).

```
┌─ Dashboard (Web/Terminal/API) ─┐
│  Next.js 14 • MarketChart • AgentStatus • SSE log │
└──────────────┬─────────────────┘
               │ EventSource /api/events  POST /api/publish
               ▼
┌─ Finance Agent OS (OpenBot-style) ─┐
│  Fastify 5 • eventBus.ts • storage.ts • server.ts │ port 4132
└──────────────┬─────────────────┘
               │ market:tick → signal:* → risk:* → portfolio:order → execution:filled
               ▼
┌─ Agents ─┐  Market (BTC/ETH/EURUSD/AAPL/SPY)  Quant (SMA/RSI/MACD/Bollinger)  Risk (exposure/drawdown/VaR/Sharpe)  Portfolio (1% sizing/Kelly)  Execution (paper/live CCXT/Binance)
└──────────┘
```

Live: **Dashboard** `http://localhost:3000` · **API** `http://localhost:4132/api/health` · **SSE** `curl -N http://localhost:4132/api/events`

## Quick start (WSL + Windows)

```bash
# WSL (server)
pnpm install
pnpm build          # tsc → apps/server/dist
pnpm dev:server     # http://0.0.0.0:4132  agents: market quant risk portfolio execution

# Windows (dashboard + server for browser localhost)
# Server auto-runs on Windows via C:\Users\Naman\AppData\Local\Temp\finance-server (0.0.0.0:4132)
# Dashboard
pnpm dev:dashboard  # http://localhost:3000 → proxies /api → 4132
```

Windows localhost fix: server must run on **Windows Node** (`C:\Program Files\nodejs\node.exe`) not WSL NAT — see `apps/server/dist/index.js:1`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | `{status, uptime}` |
| GET | `/api/events?replay=&type=&limit=` | SSE `text/event-stream` (15s heartbeat, replay) |
| POST | `/api/publish` | `{type, data, channelId, threadId, agentId}` → 201 |
| GET | `/api/state` | channels+threads+messages+recentEvents |
| GET | `/api/portfolio` | holdings/positions/risk |
| GET | `/api/market/ticks?limit=&symbol=` | ticks |

`eventBus.ts:14` `FinanceEvent {id,type,data,timestamp,channelId,threadId,agentId,runId}`

## Agents

- **Market** `apps/server/src/agents/market/index.ts:1` — `BTCUSDT ETHUSDT EURUSD AAPL SPY` synthetic + Binance REST (`/api/v3/ticker/price`)
- **Quant** `apps/server/src/agents/quant/index.ts:1` — SMA/EMA/RSI(14)/MACD(12,26,9)/Bollinger(20,2) → `signal:buy|sell|hold` confluence
- **Risk** `apps/server/src/agents/risk/index.ts:127` — `maxPositionPct 20 maxDrawdown 10 conf 0.6` → `risk:approved|rejected`
- **Portfolio** `apps/server/src/agents/portfolio/index.ts:110` — 1% sizing `qty=(cash*0.01)/price` → `portfolio:order`
- **Execution** `apps/server/src/agents/execution/index.ts:77` — paper slippage 0.05% fee 0.1% latency 100ms `ccxtWrapper.ts:218`

## Dashboard hydration

`MarketChart.tsx:23` is `use client` with `generateMockData()` deferred to `useEffect` + `mounted` guard to avoid `Text content does not match server-rendered HTML`.

## Deploy

- **CI** `.github/workflows/ci.yml` — pnpm install, tsc, build
- **Pages** `.github/workflows/pages.yml` — static export `apps/dashboard/out` → `gh-pages` branch (set `NEXT_PUBLIC_API_BASE` to your API URL)

```bash
pnpm build:dashboard   # next build (static if output:'export')
```

## License MIT
