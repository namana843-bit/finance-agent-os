---
name: Execution Agent
description: order execution with paper simulation and live CCXT placeholder
plugins: [openbot, storage]
---

# Execution Agent

Order execution agent that subscribes to `portfolio:order` and simulates fills (paper) or routes to CCXT/binance (live).

## Responsibilities

- Subscribe to `portfolio:order` events via `eventBus`
- Simulate fill with slippage and fee in paper mode, or delegate to CCXT binance in live mode
- Publish `execution:filled {orderId, symbol, side, qty, price, fee, timestamp, mode}` or `execution:rejected {orderId, reason, symbol, timestamp, mode}`
- Track fills history with uuid orderId
- Support mode switching via `EXECUTION_MODE` env (paper|live, default paper)

## Config

| Parameter | Default | Env | Description |
|-----------|---------|-----|-------------|
| mode | paper | EXECUTION_MODE | Execution mode paper or live |
| slippage | 0.0005 (0.05%) | - | Slippage applied to fill price |
| fee | 0.001 (0.1%) | - | Fee rate applied to notional |
| latency | 100 | - | Simulated latency ms before fill publish |

## State

- `config: {mode, slippage, fee, latency}`
- `fills: Fill[]` — history of executed fills (max 500)
- `stats: {mode, totalFills, totalVolume, totalFees, totalNotional}` — derived

## Methods

- `start()` / `stop()` — subscribe/unsubscribe lifecycle (idempotent)
- `isRunning()` — whether subscribed
- `execute(order)` — validate order, generate orderId uuid, simulate latency/slippage/fee, publish `execution:filled` or `execution:rejected`, track history
- `setMode(mode)` / `getMode()` — switch paper|live
- `getFills(limit?, symbol?)` / `clearFills()` — history access
- `getStats()` — aggregated stats
- `getConfig()` / `updateConfig(patch)` — config accessors

## Events

- Consumes: `portfolio:order` `{symbol, side, qty, price, confidence, timestamp, id?}`
- Publishes: `execution:filled` `{orderId, symbol, side, qty, price, fee, timestamp, mode}` , `execution:rejected` `{orderId, reason, symbol, timestamp, mode}`

## CCXT Wrapper

`ccxtWrapper.ts` provides `createExchange(exchangeId, apiKey, secret)`, `createOrder`, `fetchBalance` — mock if no keys, ready for real binance (`ccxt` dynamic import).

## Storage

Uses `storage` plugin (if configured) to persist fills; in-memory fallback otherwise.

## Synthetic-friendly

Paper mode is fully deterministic and requires no API keys. Live mode falls back to paper simulation when `BINANCE_API_KEY` / `BINANCE_SECRET` are absent.
