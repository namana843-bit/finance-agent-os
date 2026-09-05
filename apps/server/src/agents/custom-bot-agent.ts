// ============================================================================
// CustomBotAgent — Dynamic User-Created Finance Agent
// Allows users to create, spawn, and configure bespoke trading/analysis bots
// with custom personas, prompts, strategy links, and symbol subscriptions.
// ============================================================================

import { BaseAgent } from "@finance/core";
import type { Agent, TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

export interface CustomBotConfig {
  id: string;
  name: string;
  avatar: string;
  role: string;
  color?: string;
  description: string;
  personaPrompt: string;
  strategyId?: string;
  symbols?: string[];
  parameters?: Record<string, unknown>;
  enabled?: boolean;
}

export class CustomBotAgent extends BaseAgent implements Agent {
  public readonly config: CustomBotConfig;
  private bus: TypedEventBus;
  private unsubscribe: (() => void) | null = null;
  private tickCount = 0;

  constructor(bus: TypedEventBus, config: CustomBotConfig) {
    super({
      id: config.id,
      name: config.name,
      version: "1.0.0",
      description: config.description || `Custom trading bot with persona: ${config.role}`,
      capabilities: ["custom-bot", "chat-responder", "market-monitoring", config.strategyId || "custom-strategy"],
    });

    this.bus = bus;
    this.config = {
      color: "#10b981",
      symbols: ["BTCUSDT", "ETHUSDT"],
      enabled: true,
      parameters: {},
      ...config,
    };
  }

  override async start(): Promise<void> {
    await super.start();
    this.setupListeners();
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private setupListeners(): void {
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      this.handleEvent(event);
    });
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    if (!this.config.enabled) return;

    // React to market ticks or signals
    if (event.type === "market.tick") {
      this.tickCount++;
      const data = event.data as Record<string, any>;
      // Every 50 ticks for relevant symbols, bot can optionally evaluate conditions
      if (this.tickCount % 50 === 0 && data?.symbol && this.config.symbols?.includes(data.symbol)) {
        // Can generate thoughts or custom alpha signals
      }
    }
  }

  public getProfile() {
    return {
      id: this.config.id,
      name: this.config.name,
      avatar: this.config.avatar,
      role: this.config.role,
      color: this.config.color || "#10b981",
      description: this.config.description,
      strategyId: this.config.strategyId,
      symbols: this.config.symbols,
      personaPrompt: this.config.personaPrompt,
    };
  }
}
