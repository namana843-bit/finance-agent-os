# Finance Agent OS

A Windows-based Finance Agent Platform — the finance-native equivalent of OpenBot.

[![CI](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/namana843-bit/finance-agent-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

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
# Install dependencies
pnpm install

# Build shared packages
pnpm build

# Start server
pnpm dev:server

# Start dashboard (separate terminal)
pnpm dev:dashboard
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

- **Market Agent** — Real-time market data from Binance REST + synthetic fallback
- **Quant Agent** — Technical analysis: SMA, EMA, RSI, MACD, Bollinger Bands
- **Risk Agent** — Risk management: exposure, drawdown, VaR, Sharpe analysis
- **Portfolio Agent** — Position management, PnL tracking, Kelly criterion
- **Execution Agent** — Paper and live trading via CCXT

## Event Pipeline

```
MarketAgent → market.tick → QuantAgent → quant.signal
                                         ↓
                                    RiskAgent → risk.approved/rejected
                                         ↓
                                    PortfolioAgent → order.created
                                         ↓
                                    ExecutionAgent → order.filled
                                         ↓
                                    PortfolioAgent → portfolio.updated
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check with runtime status |
| GET | `/api/agents` | List all agents with health |
| GET | `/api/events` | SSE event stream |
| GET | `/api/portfolio` | Portfolio with positions and PnL |
| GET | `/api/market/ticks` | Market tick data |
| GET | `/api/signals` | Recent trading signals |
| GET | `/api/orders` | Order history |
| GET | `/api/trades` | Trade history |
| GET | `/api/strategies` | Registered strategies |
| GET | `/api/risk/status` | Risk metrics |
| GET | `/api/execution/status` | Execution statistics |
| POST | `/api/publish` | Publish custom events |

## Testing

```bash
pnpm test              # Run all tests
pnpm typecheck         # Type check
pnpm build             # Build all packages
```

## License

MIT
