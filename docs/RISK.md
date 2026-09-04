# Risk Engine

The Risk Engine evaluates every trade request before execution. No trade may bypass risk controls.

## Risk Rules

| Rule | Default | Description |
|------|---------|-------------|
| Max Position % | 20% | Max % of portfolio in single position |
| Max Order Size | $10,000 | Max notional value per order |
| Max Portfolio Exposure | 80% | Max total portfolio exposure |
| Max Symbol Exposure | 25% | Max exposure per symbol |
| Max Daily Loss | 5% | Max loss per day |
| Max Drawdown | 15% | Max drawdown from peak |
| Max Open Positions | 10 | Max simultaneous positions |
| Max Leverage | 3x | Max portfolio leverage |
| Cooldown | 60s | Min time between trades per symbol |
| Confidence Threshold | 0.6 | Min signal confidence for approval |

## Flow

```
quant.signal → RiskAgent.evaluate() → risk.approved / risk.rejected
```

## Risk Decision

```typescript
interface RiskDecision {
  id: string;
  decision: "APPROVED" | "REJECTED";
  reason: string;
  rulesChecked: string[];
  requestedQuantity: number;
  approvedQuantity: number;
  riskMetrics: RiskMetrics;
  timestamp: number;
  correlationId: string;
}
```

## Risk Metrics

- **Exposure** — Total position value as % of equity
- **Drawdown** — Current drawdown from peak equity
- **VaR** — Historical Value at Risk (95% confidence)
- **Sharpe Ratio** — Risk-adjusted return
- **Concentration** — Max single-position exposure
- **Leverage** — Total positions / equity
