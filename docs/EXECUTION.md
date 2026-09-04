# Execution Layer

## Paper Broker (Default)

Paper trading is the default mode. No real orders are sent.

```typescript
const broker = new PaperBroker(bus, {
  initialCash: 100_000,
  slippage: 0.0005,  // 0.05%
  fee: 0.001,        // 0.1%
  latencyMs: 100,    // Simulated latency
});
```

Features:
- Market & limit orders
- Slippage simulation
- Fee calculation
- Position tracking
- Order history

## Live Binance Broker

⚠️ **Live trading is DISABLED by default.**

To enable:
```env
EXECUTION_MODE=live
LIVE_TRADING_ENABLED=true
BINANCE_API_KEY=your_key
BINANCE_SECRET=your_secret
```

Safety gates:
- Must set both `EXECUTION_MODE=live` AND `LIVE_TRADING_ENABLED=true`
- API keys must be configured
- Rate limiting and retry with exponential backoff
- All orders published as events for audit

## Order Lifecycle

```
CREATED → PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED
                                              → CANCELLED
                                    → REJECTED
                                    → FAILED
```

Every state transition emits an event for audit logging.
