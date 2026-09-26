# System Roadmap (ROADMAP)

This roadmap outlines the progressive evolution of **Finance Agent OS** across eight architectural pillars: **Foundation → Data → Quant → Research → Backtesting → Portfolio → Paper Trading → Live Execution**.

---

## Roadmap Milestones & Phase Matrix

```
[1. Foundation] ──► [2. Market Data] ──► [3. Quant Engine] ──► [4. Research & Intel]
       │
       ▼
[5. Backtesting] ──► [6. Portfolio & NAV] ──► [7. Paper Trading] ──► [8. Live Execution]
```

---

### Phase 1: Foundation & Core Infrastructure
*Status: Completed & Hardened*
- [x] Monorepo structure managed via `pnpm` workspaces (`apps/server`, `apps/dashboard`, `packages/core`, `packages/shared`).
- [x] In-process asynchronous `TypedEventBus` with strongly typed topics and subscription handlers.
- [x] Fastify HTTP & Server-Sent Events (SSE) server on port `4132`.
- [x] Atomic JSON file persistence (`writeFileAtomic`) to prevent corruption under abrupt termination.
- [x] Native Electron + React 18 + Vite desktop trading workspace with dark-mode terminal aesthetics.

### Phase 2: Market Data Architecture
*Status: Active / Core Implemented*
- [x] Exchange-agnostic `MarketDataProvider` interface supporting in-memory mocks and Binance feeds.
- [x] Real-time `market.tick` ingestion and normalizer with price and timestamp tracking.
- [x] Orderbook level-2 snapshot retrieval (`get_order_book`).
- [ ] *Planned*: High-performance historical candle database (TimescaleDB / ClickHouse) replacing in-memory mocks.
- [ ] *Planned*: Multiplexed WebSocket streaming with auto-reconnect and heartbeat ping/pong.

### Phase 3: Quantitative & Strategy Engine
*Status: Completed & Tested*
- [x] Pure mathematical technical indicators: SMA, EMA, Wilder's RSI, MACD, Bollinger Bands, and Supertrend.
- [x] Pluggable `StrategyRegistry` with default quantitative strategies:
  - EMA Crossover (Trend-following)
  - RSI Reversal (Mean-reversion)
  - MACD Crossover (Momentum)
  - Momentum Strategy
- [x] Signal generation decoupling signal emission from order execution.

### Phase 4: Research, Memory & Multi-Agent Intelligence
*Status: Completed & Active*
- [x] File-persisted `AgentMemory` with automatic secret redaction (`sanitizeSecrets`) and loop traces.
- [x] Multi-turn `AgentRuntime` reasoning loop with function calling and automatic conversation persistence.
- [x] OpenCode CLI integration via secure, permissioned gateway.
- [x] Web research tool for macro market queries.
- [ ] *Planned*: Financial news NLP sentiment extraction and SEC filing ingestion.

### Phase 5: Trustworthy Backtesting Engine
*Status: Completed & Verified*
- [x] Strict **Zero Look-Ahead Bias**: Bar-by-bar chronological iteration restricted to historical data $[0 \dots i]$.
- [x] Sequential signal-to-execution decoupling (`next_bar_open` and `current_bar_close`).
- [x] Realistic `ExecutionSimulator`:
  - Bid/Ask spread modeling in basis points (`spreadBps`).
  - Market impact / slippage modeling in basis points (`slippageBps`).
  - Maker / Taker fee tier deductions.
  - Volume participation ceiling (`maxVolumeParticipation: 0.10`).
  - Cash insolvency protection.
- [x] Institutional performance metrics: Annualized Sharpe, Sortino, CAGR, Max Drawdown & Duration, Profit Factor, Expectancy.

### Phase 6: Portfolio Management & Accounting
*Status: Completed & Active*
- [x] Double-entry style cash and position ledger tracking average entry prices and unrealized PnL.
- [x] Mark-to-market portfolio snapshot generation via `portfolio.updated`.
- [x] Position concentration, gross leverage, and portfolio exposure auditing.
- [ ] *Planned*: Multi-asset target-weight rebalancing calculator with minimal turnover optimization.

### Phase 7: Paper Trading & Defense-in-Depth Risk Pipeline
*Status: Completed & Hardened*
- [x] 7-Stage Execution Safety Pipeline:
  1. Signal validation
  2. Anti-Loop reliability guard (`LoopGuard`)
  3. Emergency Kill Switch (`KillSwitch`)
  4. Hard non-bypassable risk limits (`HardLimitsValidator`)
  5. Cryptographic HMAC-SHA256 `RiskApprovalTicket` (30s TTL, replay protection)
  6. Finance Gateway agent permissions
  7. Canonical `OrderManager` state machine (`CREATED` → `PENDING` → `SUBMITTED` → `FILLED`)
- [x] Simulation broker (`PaperBroker`) enforcing ticket verification before executing fills.

### Phase 8: Live Execution & Exchange Boundary
*Status: Hardened & Strictly Gated*
- [x] Strict gatekeeping: live trading is permanently disabled unless `EXECUTION_MODE=live` and `LIVE_TRADING_ENABLED=true` are explicitly passed.
- [x] Read-only Binance runtime client for price checking and account verification.
- [x] Automated position and order drift reconciliation (`ExchangeReconciliation`).
- [x] Administrative kill switch override key requirement.
- [ ] *Planned*: Multi-exchange smart order routing (Binance, Coinbase, Kraken) with TWAP/VWAP order slicing.
