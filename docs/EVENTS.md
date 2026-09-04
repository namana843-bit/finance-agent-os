# Events

The Finance Agent Platform uses a strongly typed event-driven architecture via `TypedEventBus`.

## Event Structure

```typescript
interface FinanceEvent {
  id: string;           // Auto-generated UUID
  type: string;         // Event type (e.g., "market.tick")
  data: unknown;        // Event payload
  timestamp: number;    // Auto-generated epoch ms
  source?: string;      // Source component
  correlationId?: string; // For request tracing
  agentId?: string;     // Agent that generated the event
}
```

## Event Categories

### Market
| Event | Description |
|-------|-------------|
| `market.tick` | Real-time price tick |
| `market.candle` | OHLCV candle data |
| `market.orderbook` | Order book snapshot |
| `market.trade` | Recent trade |

### Quant
| Event | Description |
|-------|-------------|
| `quant.analysis` | Analysis result |
| `quant.signal` | Trading signal (buy/sell/hold) |

### Risk
| Event | Description |
|-------|-------------|
| `risk.check` | Risk evaluation request |
| `risk.approved` | Trade approved |
| `risk.rejected` | Trade rejected |
| `risk.alert` | Risk alert |

### Portfolio
| Event | Description |
|-------|-------------|
| `portfolio.updated` | Portfolio state changed |
| `portfolio.position_changed` | Position modified |

### Execution
| Event | Description |
|-------|-------------|
| `order.created` | New order created |
| `order.submitted` | Order sent to broker |
| `order.partially_filled` | Partial fill |
| `order.filled` | Order completely filled |
| `order.cancelled` | Order cancelled |
| `order.rejected` | Order rejected |
| `order.failed` | Order execution failed |

### Trade
| Event | Description |
|-------|-------------|
| `trade.opened` | New trade opened |
| `trade.closed` | Trade closed |

### Agent
| Event | Description |
|-------|-------------|
| `agent.started` | Agent started |
| `agent.stopped` | Agent stopped |
| `agent.error` | Agent encountered error |

### System
| Event | Description |
|-------|-------------|
| `system.health` | Health check result |
| `system.error` | System-level error |

## Subscriptions

```typescript
// Subscribe to all events
bus.subscribe(handler);

// Subscribe to specific type
bus.subscribeTo("market.tick", handler);

// Wildcard subscription
bus.subscribeTo("order.*", handler);

// Filtered subscription
bus.subscribeFiltered({ type: "risk.approved", since: Date.now() - 60000 }, handler);
```

## History & Replay

```typescript
// Get event history
const history = bus.getHistory({ type: "market.tick" }, 100);

// Replay to handler
await bus.replay(handler, { type: "quant.signal" });
```
