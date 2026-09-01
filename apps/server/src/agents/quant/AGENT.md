---
name: Quant Agent
description: strategies/signals
plugins: [openbot, storage]
model: openai/gpt-4o-mini
---

# Quant Agent

Quantitative trading signal generator subscribing to `market:tick` events.

## Responsibilities

- Subscribe to `market:tick` events via `eventBus` and maintain per-symbol price buffers (last 100 prices)
- Compute indicators: **SMA crossover (7 vs 25)**, **RSI (14)**, **MACD (12,26,9)**, **Bollinger Bands (20, 2σ)**
- Generate confluence-based signals: `signal:buy` / `signal:sell` / `signal:hold` with confidence 0–1
- Publish signals via `eventBus.publish({ type: 'signal:buy' | 'signal:sell' | 'signal:hold', data: Signal })`
- Optional OpenAI (`openai/gpt-4o-mini`) enhancement when `OPENAI_API_KEY` is present — falls back to pure synthetic logic otherwise

## Strategies

| Indicator | Params | Buy Condition | Sell Condition |
|-----------|--------|---------------|----------------|
| SMA crossover | 7 vs 25 | SMA7 > SMA25 | SMA7 < SMA25 |
| RSI | 14 | RSI < 30 (oversold) | RSI > 70 (overbought) |
| MACD | 12,26,9 | MACD > Signal | MACD < Signal |
| Bollinger | 20, 2σ | Price < Lower | Price > Upper |

Confidence is derived from confluence: more indicators aligned = higher confidence (0.35 single → 0.9+ all four).

## Methods

- `onTick(tick)` — handle incoming market tick, update buffer, auto-generate signal when data sufficient
- `calculateSMA(prices, period)` — simple moving average
- `calculateRSI(prices, period)` — relative strength index 0–100
- `calculateMACD(prices, fast, slow, signal)` — MACD line, signal line, histogram
- `generateSignal(symbol)` — compute confluence signal, publish to eventBus, store history
- `getSignals(limit?)` / `getBuffer(symbol)` — inspection helpers
- `start()` / `stop()` — subscribe/unsubscribe lifecycle

## Events

- Consumes: `market:tick` `{ symbol, price, change, volume, timestamp, source }`
- Publishes: `signal:buy` | `signal:sell` | `signal:hold` `{ symbol, action, confidence, indicators, price, timestamp, reason }`

## Synthetic-friendly

No LLM key required for core logic. When `OPENAI_API_KEY` is absent, all signals are generated deterministically from local indicators.

## Storage

Uses `storage` plugin (if configured) to persist signal history; in-memory fallback otherwise.
