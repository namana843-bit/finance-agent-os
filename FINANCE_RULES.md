# Financial Data, Calculation & Evidence Rules (FINANCE_RULES)

This document establishes the mathematical standards, data integrity constraints, execution simulation rules, and statistical evidence requirements for **Finance Agent OS**.

All agents, backtesting engines, strategy modules, and data adapters must adhere to these rules.

---

## 1. Data Integrity & Numeric Precision

### Decimal Representation & Safety
1. **No NaN or Infinity**: Every numeric calculation must validate inputs using `Number.isFinite()`. Orders with `NaN`, `null`, `undefined`, or negative prices/quantities are rejected at the gateway.
2. **Precision Rounding**:
   - Crypto quantities: Round to a maximum of 6 to 8 decimal places (e.g., `Math.round(qty * 1e6) / 1e6`).
   - Fiat values / USD notional: Round to 2 decimal places (`Math.round(val * 100) / 100`).
   - Basis points: 1 bps = 0.0001 (0.01%).
3. **Symbol Normalization**:
   - Symbols must be uppercase alphanumeric strings (e.g., `BTCUSDT`, `ETHUSDT`).
   - Validation must pass through `validateSymbolTool` or canonical allowlists before order generation.

### Timestamp Freshness & Staleness Rules
1. **Quote Freshness Threshold**:
   - Market quotes older than **30,000 ms (30 seconds)** are classified as stale.
   - The risk engine immediately rejects trade proposals referencing stale data (`staleThresholdMs: 30000`).
2. **Chronological Monotonicity**:
   - Ticks and candle streams must have strictly ascending millisecond timestamps (`t[i] >= t[i-1]`). Duplicate timestamps must be deduplicated by sequence ID.

---

## 2. Quantitative & Backtesting Rules

To guarantee trustworthy, reproducible financial results, backtesting code must strictly follow these constraints (`apps/server/src/backtesting/`):

### Zero Look-Ahead Bias
- **Strict Sequential Iteration**: Strategies evaluate bar $i$ using strictly historical observations $[0 \dots i]$. Accessing $i+1$ during bar $i$'s signal evaluation is strictly prohibited.
- **Signal-to-Execution Decoupling**:
  - `next_bar_open` (Default / Recommended): A signal generated at the close of bar $i$ executes at the opening price of bar $i+1$.
  - `current_bar_close`: Only permitted if explicitly configured, applying full slippage and spread penalties.

### Realistic Execution Simulation
Every backtest must model real-world friction via `ExecutionSimulator`:
1. **Bid/Ask Spread**: Simulated half-spread added to buys and subtracted from sells (`spreadBps: 2` default).
2. **Market Impact / Slippage**: Execution price degraded proportionally to trade notional (`slippageBps: 5` default).
3. **Exchange Fees**:
   - Taker fee: `0.001` (10 bps / 0.10%) applied to market orders.
   - Maker fee: `0.0005` (5 bps / 0.05%) applied to resting limit orders.
4. **Volume Participation Ceiling**:
   - A single trade cannot consume more than **10% of candle volume** (`maxVolumeParticipation: 0.10`). Trades exceeding this limit are partially filled or rejected.
5. **Cash Insolvency Protection**:
   - Portfolios cannot hold negative cash unless margin trading is explicitly configured.

---

## 3. Institutional Performance Metrics

All strategy evaluations and reports must calculate metrics using the standardized formulas defined in `apps/server/src/backtesting/metrics.ts`:

### Annualization Factors ($N$)
- **24/7 Cryptocurrency Markets**: $N = 365$
- **Traditional Equities / Forex**: $N = 252$

### Core Mathematical Formulas
- **Annualized Return / CAGR**:
  $$\text{CAGR} = \left(\frac{V_{\text{final}}}{V_{\text{initial}}}\right)^{\frac{1}{\text{years}}} - 1$$
- **Annualized Volatility**:
  $$\sigma_{\text{annual}} = \sigma_{\text{periodic}} \times \sqrt{N}$$
- **Annualized Sharpe Ratio**:
  $$\text{Sharpe} = \frac{\bar{R}_{\text{annual}} - R_f}{\sigma_{\text{annual}}}$$
- **Annualized Sortino Ratio**:
  $$\text{Sortino} = \frac{\bar{R}_{\text{annual}} - R_f}{\sigma_{\text{downside}} \times \sqrt{N}}$$
  *(Where downside variance considers only returns below the risk-free benchmark).*
- **Maximum Drawdown (MDD)**:
  $$\text{MDD} = \max_{\tau \le t} \left(\frac{V_{\text{peak}}(\tau) - V(t)}{V_{\text{peak}}(\tau)}\right) \times 100$$
- **Profit Factor**:
  $$\text{Profit Factor} = \frac{\sum \text{Gross Profits}}{\sum |\text{Gross Losses}|}$$
- **Mathematical Expectancy**:
  $$\text{Expectancy} = (\text{Win Rate} \times \text{Average Win}) - (\text{Loss Rate} \times |\text{Average Loss}|)$$

---

## 4. Evidence & Research Standards

1. **Statistical Significance**:
   - Any strategy backtest claiming alpha must exhibit **at least 30 completed trades**. Backtests with fewer than 30 trades must include the warning: `[WARNING: Statistically Insignificant Sample Size]`.
2. **Out-of-Sample Validation**:
   - In-sample optimization without out-of-sample or walk-forward testing must be explicitly labeled as unverified curve-fit.
3. **No Cherry-Picking**:
   - Performance summaries must report both the winning metric (e.g., Total Return) and the risk metric (e.g., Max Drawdown, Sharpe, Sortino).
