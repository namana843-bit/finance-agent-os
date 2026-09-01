---
name: Portfolio Agent
description: position and cash management
plugins: [openbot, storage]
---

# Portfolio Agent

Portfolio management agent that handles position tracking, cash, PnL, and order generation via 1% risk sizing.

## Responsibilities

- Subscribe to `risk:approved`, `execution:filled`, and `market:tick` events via `eventBus`
- Maintain portfolio state `{cash 100000, positions Map<string, {qty, avgPrice, currentPrice}>, realizedPnL, unrealizedPnL}`
- On `risk:approved`: create order intent `{symbol, side, qty, price, confidence}` -> publish `portfolio:order` (sizing: risk 1% per trade, qty = (cash*0.01)/price)
- On `execution:filled`: update positions, cash, realized PnL
- On `market:tick`: update currentPrice, recalculate unrealizedPnL, publish `portfolio:update`
- Provide allocation helpers via `allocation.ts`
- Track history of orders and fills

## State

- `cash: 100000`
- `positions: Map<string, {qty, avgPrice, currentPrice}>`
- `realizedPnL: 0`
- `unrealizedPnL: 0`
- `orderHistory: Order[]`
- `fillHistory: Fill[]`

## Methods

- `start()` / `stop()` — subscribe/unsubscribe lifecycle (idempotent)
- `isRunning()` — whether subscribed
- `getPortfolio()` — returns `{cash, positions, realizedPnL, unrealizedPnL, totalValue, positionCount}`
- `getPositions()` — returns array or Map copy of positions
- `getPnL()` — returns `{realizedPnL, unrealizedPnL, totalPnL, totalValue}`
- `getAllocation()` — returns `{symbol: weight}` where weight = position value / totalValue
- `rebalance(targetWeights)` — computes delta trades via `rebalanceWeights`, publishes `portfolio:order` for each non-zero delta
- `getOrderHistory()` / `getFillHistory()` / `clearHistory()` — history helpers
- `handleApproved(event)` / `handleFilled(event)` / `handleTick(event)` — internal handlers (also exposed)

## Events

- Consumes: `risk:approved` `{signal, reason, checks} or {symbol, side/action, price, confidence}`, `execution:filled` `{symbol, side, qty, price, ...}`, `market:tick` `{symbol, price}`
- Publishes: `portfolio:order` `{symbol, side, qty, price, confidence, timestamp}`, `portfolio:update` `{cash, positions, realizedPnL, unrealizedPnL, totalValue}`

## Allocation Helpers

Pure functions from `allocation.ts`: `kellyCriterion`, `positionSizing`, `rebalanceWeights`

## Storage

Uses `storage` plugin (if configured) to persist portfolio state; in-memory fallback otherwise.
