# Finance Tools Specification (TOOLS)

This document provides a comprehensive catalog of all callable tools available in **Finance Agent OS**, along with their input schemas, return types, operational status, and planned roadmap additions.

Tools are registered in `apps/server/src/tools/finance-tools.ts` and made available to agents via `FinanceToolRegistry`.

---

## 1. Currently Available Tools (23 Registered)

### Market Data Tools

| Tool ID | Name | Input Parameters | Output / Return | Status |
| :--- | :--- | :--- | :--- | :--- |
| `get_market_price` | Get Market Price | `{ symbol: string }` | `{ symbol, price, timestamp }` | ✅ Active (reads real-time event cache) |
| `get_price` | Get Exchange Price | `{ symbol: string }` | `{ symbol, price, timestamp, provider }` | ✅ Active (via `MarketDataProvider`) |
| `get_ohlcv` | Get OHLCV Candles | `{ symbol: string, timeframe?: string, limit?: number }` | `{ symbol, candles: OHLCV[] }` | ✅ Active (via `MarketDataProvider`) |
| `get_order_book` | Get Order Book | `{ symbol: string, depth?: number }` | `{ symbol, bids: [p, q][], asks: [p, q][] }` | ✅ Active (via `MarketDataProvider`) |
| `get_candles` | Get Historical Candles | `{ symbol: string, timeframe?: string, limit?: number }` | `{ candles: [] }` | ⚠️ Stub (returns TODO note for storage) |
| `validate_symbol` | Validate Symbol | `{ symbol: string }` | `{ valid: boolean, normalized: string }` | ✅ Active (checks supported tickers) |

### Technical Analysis & Quantitative Indicators

| Tool ID | Name | Input Parameters | Output / Return | Status |
| :--- | :--- | :--- | :--- | :--- |
| `calculate_rsi` | Calculate RSI | `{ prices: number[], period?: number }` | `{ rsi: number \| null, period: number }` | ✅ Active (pure Wilder RSI) |
| `calculate_rsi_indicator` | RSI Indicator (Extended) | `{ prices: number[], period?: number }` | `{ rsi: number, overbought: boolean, oversold: boolean }` | ✅ Active |
| `calculate_macd` | Calculate MACD | `{ prices: number[], fast?: number, slow?: number, signal?: number }` | `{ note: string }` | ⚠️ Stub (returns TODO note for strategy wrapper) |
| `calculate_macd_indicator` | MACD Indicator (Extended) | `{ prices: number[], fast?: number, slow?: number, signal?: number }` | `{ macd, signal, histogram, trend }` | ✅ Active (exponential moving averages) |
| `calculate_sma` | Simple Moving Average | `{ prices: number[], period: number }` | `{ sma: number, period: number }` | ✅ Active |
| `calculate_ema` | Exponential Moving Avg | `{ prices: number[], period: number }` | `{ ema: number, period: number }` | ✅ Active |
| `calculate_bollinger_bands` | Bollinger Bands | `{ prices: number[], period?: number, stdDev?: number }` | `{ upper, middle, lower, bandwidth, percentB }` | ✅ Active |
| `calculate_supertrend` | Supertrend Indicator | `{ prices: number[], period?: number, multiplier?: number }` | `{ supertrend, trend, upperBand, lowerBand }` | ✅ Active (ATR-based trend filter) |
| `calculate_indicator` | Generic Indicator Dispatch | `{ name: string, prices: number[], params?: object }` | `{ indicator: string, result: unknown }` | ✅ Active (dispatcher for SMA/EMA/RSI/etc.) |

### Portfolio & Position Management Tools

| Tool ID | Name | Input Parameters | Output / Return | Status |
| :--- | :--- | :--- | :--- | :--- |
| `get_portfolio` | Get Portfolio | `{}` | `{ cash, positions: Position[], totalValue }` | ✅ Active (event-bus portfolio state) |
| `get_portfolio_snapshot` | Portfolio Snapshot | `{}` | `{ cash, totalEquity, positions: PositionSnapshot[], timestamp }` | ✅ Active (via `PortfolioProvider`) |
| `get_balance` | Get Cash Balance | `{ asset?: string }` | `{ asset, free, locked, total }` | ✅ Active (via `PortfolioProvider`) |
| `get_positions` | Get Active Positions | `{ symbol?: string }` | `{ positions: Position[] }` | ✅ Active (via `PortfolioProvider`) |
| `calculate_position_size`| Position Sizer | `{ cash: number, price: number, riskPercent?: number }` | `{ qty, notional, riskAmount }` | ✅ Active (risk-adjusted sizing) |

### System, Logging & External Execution Tools

| Tool ID | Name | Input Parameters | Output / Return | Status |
| :--- | :--- | :--- | :--- | :--- |
| `format_money` | Format Money | `{ amount: number, currency?: string }` | `{ formatted: string }` | ✅ Active (locale-aware currency formatter) |
| `event_log` | Log Event | `{ message: string, level?: string, data?: object }` | `{ logged: boolean, timestamp }` | ✅ Active (publishes to `TypedEventBus`) |
| `opencode_run` | OpenCode CLI Runner | `{ command: string, args?: string[] }` | `{ stdout, stderr, exitCode }` | ✅ Active (gated CLI engine execution) |
| `websearch` | Web Search | `{ query: string, numResults?: number }` | `{ results: Array<{ title, url, snippet }> }` | ✅ Active (macro news/research) |

---

## 2. Planned Tools (Roadmap)

The following tools are designed and slated for upcoming milestones:

| Tool ID | Planned Capability | Motivation / Target Architecture |
| :--- | :--- | :--- |
| `get_historical_candles_db` | Persistent candle storage via TimescaleDB or ClickHouse | Eliminates the in-memory candle limitation; supports multi-year backtesting datasets. |
| `stream_order_depth_ws` | High-frequency live orderbook depth WebSocket hook | Real-time level 2 micro-structure feeds for whale tracking and CVD calculation. |
| `calculate_var_monte_carlo`| Monte Carlo Value-at-Risk (VaR) simulation tool | 10,000-path portfolio stress testing under extreme volatility conditions. |
| `smart_execution_router` | Multi-exchange liquidity aggregator | Splits large orders across Binance, Coinbase, and DEX liquidity pools using TWAP/VWAP. |
| `calculate_volatility_surface` | Implied Volatility (IV) surface and options Greeks | Delta, Gamma, Theta, Vega calculation for crypto derivatives hedging. |
| `sentiment_nlp_score` | Real-time news and social media sentiment pipeline | Extracts quantitative sentiment indicators from financial feeds and SEC filings. |
| `rebalance_portfolio` | Automated mean-variance / target-weight rebalancer | Computes optimal rebalancing transactions subject to minimal turnover and slippage. |
