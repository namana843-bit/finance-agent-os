---
name: Risk Agent
description: exposure/drawdown
plugins: [openbot, storage]
---

# Risk Agent

Risk management agent that validates trading signals against exposure, drawdown, VaR, and position concentration constraints.

## Responsibilities

- Subscribe to `signal:buy` / `signal:sell` events via `eventBus`
- Evaluate signals against configurable risk limits
- Publish `risk:approved` or `risk:rejected` with detailed checks
- Handle `risk:rejected` logging for audit trail
- Maintain portfolio state `{cash 100000, positions Map, dailyPnL, peakValue}`
- Compute risk metrics via pure `metrics.ts` helpers

## Config

| Parameter | Default | Description |
|-----------|---------|-------------|
| maxPositionPct | 20 | Max % of portfolio per position |
| maxDrawdownPct | 10 | Max drawdown % before rejection |
| maxDailyLoss | 5 | Max daily loss % |
| maxLeverage | 3 | Max leverage ratio |
| maxOpenPositions | 5 | Max number of open positions |
| confidenceThreshold | 0.6 | Minimum signal confidence |

## State

- `portfolio.cash: 100000`
- `portfolio.positions: Map<string, Position>`
- `portfolio.dailyPnL: 0`
- `portfolio.peakValue: 100000`

## Methods

- `evaluate(signal)` — runs exposure, drawdown, VaR, concentration, confidence checks; publishes `risk:approved` or `risk:rejected {signal, reason, checks: {exposure, drawdown, concentration, confidence, var}}`
- `getRiskMetrics()` — returns current exposure, drawdown, VaR, concentration, Sharpe
- `handleRejected(event)` — logs `risk:rejected` events
- `start()` / `stop()` — subscribe/unsubscribe lifecycle
- `getPortfolio()` / `updatePortfolio(patch)` — portfolio accessors
- `getRejectedLog()` / `clearRejectedLog()` — audit helpers

## Events

- Consumes: `signal:buy` `{symbol, action, confidence, price, ...}` , `signal:sell` , `risk:rejected`
- Publishes: `risk:approved` `{signal, reason, checks}` , `risk:rejected` `{signal, reason, checks}`

## Metrics

Pure functions from `metrics.ts`: `calculateExposure`, `calculateDrawdown`, `calculateVaR`, `calculateSharpe`

## Storage

Uses `storage` plugin (if configured) to persist portfolio state and rejected logs; in-memory fallback otherwise.
