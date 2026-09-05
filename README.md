# Finance Agent OS — Autonomous Multi-Agent Trading Platform

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

An event-driven autonomous financial operating system powered by specialized, collaborating trading agents (`AlphaQuant` → `RiskSentinel` → `ExecRouter` → `MarketIntel` → `PortfolioLead`) communicating over a high-throughput **`TypedEventBus`** with `FinanceGateway` and institutional paper/live risk controls.

---

## 🏛️ Architecture

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
  • AlphaQuant (Quant/Signals)     • Market Depth / OHLCV        • FinanceGateway
  • RiskSentinel (VaR/Drawdown)    • Volatility Surface / RSI    • AuditLogger
  • ExecRouter (TWAP/Slippage)     • Portfolio Margin / Risk     • PaperBroker
  • MarketIntel (Order Flow/CVD)   • Strategy Backtesting (21+)  • StrategyRegistry
  • PortfolioLead (NAV/Rebalance)  • Exchange Providers          • ExecutionPipeline
     │                               │                               │
     └───────────────────────────────┼───────────────────────────────┘
                                     ▼
                   TypedEventBus (Event-Driven Backbone)
                                     │
                            Execution Pipeline
                   (Signal → Risk → Permission → Paper)
                                     │
                                ┌────┴────┐
                                ▼         ▼
                             PAPER      LIVE BROKER (Gated)
                             BROKER       │
                                          ▼
                                   Exchange Liquidity
```

---

## 🤖 Specialized Autonomous Trading Agents

| Agent | Role | Capabilities |
| :--- | :--- | :--- |
| **`AlphaQuant`** | Quantitative & Strategy Lead | RSI momentum models, Bollinger squeeze signals, statistical arbitrage, expected returns |
| **`RiskSentinel`** | Risk & Compliance Guardian | 99% Value-at-Risk (VaR), portfolio margin limits, maximum drawdown caps, liquidation distance |
| **`ExecRouter`** | Smart Order Execution Desk | TWAP/VWAP order slicing, exchange liquidity routing (Binance, Bybit), slippage minimization |
| **`MarketIntel`** | Market Microstructure & Flow | Orderbook depth scanning, whale absorption alerts, cumulative volume delta (CVD) |
| **`PortfolioLead`** | Portfolio Orchestrator & NAV | Capital allocation, multi-asset rebalancing, performance and PnL auditing |

---

## 💬 Multi-Agent Inter-Communication

Agents collaborate in real-time inside **Multi-Agent Trading Rooms**:
1. **Market Anomaly Detected**: `MarketIntel` identifies an orderbook imbalance or volume spike.
2. **Quant Signal Generated**: `AlphaQuant` calculates optimal entry, take-profit, stop-loss, and Sharpe ratio.
3. **Risk Audit & Clearance**: `RiskSentinel` validates the trade against portfolio margin and max drawdown limits.
4. **Execution Route Formatted**: `ExecRouter` constructs an interactive **Trade Approval Ticket** for manual confirmation or policy auto-pass.
5. **Portfolio Rebalanced**: `PortfolioLead` logs the Net Asset Value (NAV) and PnL projection.

---

## 📁 Repository Structure

```
finance-agent-os/
├── apps/
│   ├── dashboard/              # 100% Pure Desktop Application
│   │   ├── electron/           # Electron main & preload processes
│   │   ├── src/                # Trading Agent UI, Multi-Agent Rooms, Telemetry Drawer
│   │   │   ├── App.tsx         # Main Trading Desk component
│   │   │   ├── index.css       # TailwindCSS styling & dark theme
│   │   │   ├── main.tsx        # React root mount
│   │   │   └── lib/api.ts      # Fastify API & SSE client
│   │   ├── index.html          # Desktop entry document
│   │   ├── tailwind.config.js
│   │   └── vite.config.ts      # Standalone Vite bundler (base: './')
│   │
│   └── server/                 # Fastify API & WebSocket Server (:4132)
│       └── src/
│           ├── agents/         # Base and specialized financial agent implementations
│           ├── chat/           # DialogueEngine (Multi-agent chat & event broadcast)
│           ├── core/           # Server factory & FinanceRuntime composition
│           ├── environment/    # FinanceEnvironment (Market, Portfolio, Paper adapters)
│           └── strategy-lab/   # Quantitative strategy backtester & factory
│
├── packages/
│   ├── core/                   # Autonomous Multi-Agent Engine & TypedEventBus
│   └── shared/                 # Domain types, event schemas, & data structures
│
├── prisma/                     # Database schema & migrations
└── scripts/
    ├── openbot.js              # Interactive CLI terminal agent
    └── verify-honesty.mjs
```

---

## 🚀 Quick Start

### 1. Installation
```bash
pnpm install
```

### 2. Build All Packages
```bash
pnpm build
```

### 3. Development
```bash
# Start both Backend API Server and Desktop UI in parallel:
pnpm dev

# Or start individually:
pnpm dev:server       # Fastify backend on http://localhost:4132
pnpm dev:desktop      # Vite Desktop UI on http://localhost:5173
```

### 4. Run Native Desktop Window (Electron)
```bash
pnpm desktop:electron
```

### 5. Typecheck & Tests
```bash
pnpm typecheck        # Run TypeScript typechecks across all 5 workspace projects
pnpm test             # Run all 176 unit & integration tests
```

---

## 🔒 License
MIT © Finance Agent OS
