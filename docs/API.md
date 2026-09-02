# REST API

Base URL: `http://localhost:4132`

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | System health check |

## Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents with status |
| POST | `/api/agents/:id/start` | Start an agent |
| POST | `/api/agents/:id/stop` | Stop an agent |

## Market

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/market/ticks?limit=20&symbol=BTCUSDT` | Recent market ticks |
| GET | `/api/market/candles?symbol=BTCUSDT&limit=100` | OHLCV candles |
| GET | `/api/market/orderbook?symbol=BTCUSDT&depth=10` | Order book |
| GET | `/api/market/state` | Current market state |

## Quantitative

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/signals?limit=20` | Recent trading signals |
| POST | `/api/trading/signal` | Manually trigger a signal |

## Strategies

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/strategies` | List strategies |
| POST | `/api/strategies` | Register a strategy |
| POST | `/api/strategies/:id/toggle` | Enable/disable strategy |

## Risk

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/risk/status` | Current risk status |
| GET | `/api/risk/metrics` | Detailed risk metrics |

## Portfolio

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio` | Portfolio overview |
| GET | `/api/portfolio/positions` | All positions |
| GET | `/api/portfolio/allocation` | Allocation breakdown |
| GET | `/api/portfolio/history` | Portfolio snapshots |

## Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders` | List all orders |
| GET | `/api/orders/:id` | Get specific order |
| POST | `/api/orders/:id/cancel` | Cancel order |

## Trades

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trades` | List all trades |

## Gateway

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/gateway/trade` | Submit trade through gateway |
| GET | `/api/gateway/stats` | Gateway statistics |

## Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/execution/status` | Execution stats & mode |

## Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit?eventType=risk.approved&limit=50` | Audit log |

## Events (SSE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events?type=market.tick&replay=true` | Real-time event stream |
| POST | `/api/publish` | Publish event |

## State

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/state` | Full runtime state |
