import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

export class DemoAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 5000; // 5 seconds

  constructor(bus?: TypedEventBus) {
    super({
      id: "demo-agent",
      name: "Demo Agent",
      version: "0.1.0",
      description: "A demonstration agent that publishes heartbeat events",
      capabilities: ["demo", "heartbeat", "event-logging"],
    });
    this.bus = bus ?? new TypedEventBus();
  }

  async start(): Promise<void> {
    await super.start();
    // Start publishing heartbeat events every 5 seconds
    this.heartbeatTimer = setInterval(() => {
      this.publishHeartbeat();
    }, this.heartbeatIntervalMs);
    console.log(`[DemoAgent] Started heartbeat timer (${this.heartbeatIntervalMs}ms)`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log(`[DemoAgent] Stopped heartbeat timer`);
    }
    await super.stop();
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    // Log when we receive any event
    this.recordActivity();
    console.log(`[DemoAgent] Received event: ${event.type} from ${event.source || 'unknown'}`);
    
    // You could add specific event handling here
    if (event.type === "market.tick") {
      const tick = event.data as { symbol: string; price: number; source: string };
      console.log(`[DemoAgent] Market tick: ${tick.symbol} = $${tick.price.toFixed(2)} (${tick.source})`);
    }
  }

  private publishHeartbeat(): void {
    try {
      this.recordActivity();
      this.bus.publish({
        type: "demo.heartbeat",
        data: {
          timestamp: Date.now(),
          agent: "demo-agent",
          status: "alive"
        },
        source: "demo-agent",
        agentId: "demo-agent",
      });
      console.log(`[DemoAgent] Published heartbeat`);
    } catch (err) {
      this.recordError(err);
    }
  }
}