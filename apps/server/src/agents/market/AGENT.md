---
name: Market Agent
description: Streams BTC/ETH/FX/stocks via Binance WS + Yahoo
plugins: [openbot, storage]
---

# Market Agent

Streams real-time market ticks for BTC/ETH/FX/stocks via Binance WebSocket + Yahoo fallback.

## Responsibilities

- Subscribe to `eventBus` and publish `market:tick` events
- Maintain history buffer of last 1000 ticks
- Poll Binance public REST `https://api.binance.com/api/v3/ticker/price` with synthetic fallback
- Generate normalized `Tick {symbol, price, change, volume, timestamp, source}`

## Supported Symbols

`BTCUSDT`, `ETHUSDT`, `EURUSD`, `AAPL`, `SPY`

## Methods

- `start()` — subscribes to eventBus, starts 2s polling and Binance WS (synthetic mock if no key)
- `stop()` — graceful shutdown, clears timers and unsubscribes
- `fetchTick(symbol)` — fetch single tick (real price with synthetic fallback)
- `startPolling(symbols, intervalMs)` — poll loop for given symbols
- `connectBinanceWS(symbols)` — mock WS if no API key, generates synthetic ticks

## Events

- Publishes: `market:tick` via `eventBus.publish({type:'market:tick', data: tick})`
- Consumes: subscribes to `eventBus` for coordination

## HTTP

Server exposes `GET /api/market/ticks` proxy; agent keeps local history for that endpoint.
