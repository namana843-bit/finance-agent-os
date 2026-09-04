# Agents

All finance agents extend `BaseAgent` and communicate through the `TypedEventBus`.

## Agent Lifecycle

```
register → start() → running → stop() → stopped
                    ↗ restart ↘
```

## Built-in Agents

| Agent | ID | Description | Subscribes To | Publishes |
|-------|----|-------------|---------------|-----------|
| Market Agent | `market` | Streams real-time ticks | — | `market.tick` |
| Quant Agent | `quant` | Generates trading signals | `market.tick` | `quant.signal` |
| Risk Agent | `risk` | Evaluates trade risk | `quant.signal` | `risk.approved`, `risk.rejected` |
| Portfolio Agent | `portfolio` | Manages positions & PnL | `risk.approved`, `order.filled`, `market.tick` | `order.created`, `portfolio.updated` |
| Execution Agent | `execution` | Executes orders | `order.created` | `order.filled`, `order.rejected` |

## Agent Interface

```typescript
interface Agent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: string[];

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getStatus(): AgentStatus;
  getHealth(): AgentHealth;
  handleEvent(event: FinanceEvent): Promise<void>;
}
```

## Creating a Custom Agent

```typescript
import { BaseAgent } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

class MyAgent extends BaseAgent {
  constructor(bus: TypedEventBus) {
    super({
      id: "my-agent",
      name: "My Agent",
      version: "1.0.0",
      description: "Custom agent",
      capabilities: ["custom-analysis"],
    });
    this.bus = bus;
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    // Handle events
  }
}
```
