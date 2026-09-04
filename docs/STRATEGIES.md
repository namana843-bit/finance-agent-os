# Strategies

The platform includes a pluggable strategy system with real quantitative analysis.

## Built-in Strategies

| Strategy | ID | Description |
|----------|----|-------------|
| EMA Crossover | `ema-crossover` | Buy when fast EMA crosses above slow EMA |
| RSI Reversal | `rsi-reversal` | Buy on oversold, sell on overbought |
| MACD Crossover | `macd-crossover` | Buy when MACD crosses above signal line |
| Momentum | `momentum` | Buy on positive momentum, sell on negative |

## Technical Indicators

All indicators are pure functions with no side effects:

- **SMA** — Simple Moving Average
- **EMA** — Exponential Moving Average
- **RSI** — Relative Strength Index (0–100)
- **MACD** — Moving Average Convergence Divergence
- **Bollinger Bands** — Volatility bands around SMA

## Strategy Interface

```typescript
interface StrategyInstance {
  config: StrategyConfig;
  calculate(prices: number[]): StrategyResult;
}

interface StrategyResult {
  side: "buy" | "sell" | "hold";
  confidence: number; // 0 to 1
  indicators: Record<string, unknown>;
  reasoning: string;
}
```

## Signal Flow

```
market.tick → QuantAgent → Strategy.calculate() → quant.signal
```

## Strategy Registry

```typescript
const registry = new StrategyRegistry();
registerDefaultStrategies(registry);

// Enable/disable
registry.enable("ema-crossover");
registry.disable("rsi-reversal");

// Get enabled only
const active = registry.getEnabled();
```
