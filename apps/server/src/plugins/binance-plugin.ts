// ============================================================================
// Finance Agent OS — Binance Plugin
// Phase 5: Plugin System — Binance market data plugin
// ============================================================================

import type { PluginInfo } from "@finance/shared";
import type { PluginLifecycle } from "@finance/core";

export const BinancePluginInfo: PluginInfo = {
  id: "binance-market",
  name: "Binance Market Data Plugin",
  version: "0.1.0",
  description: "Provides real-time and historical market data from Binance",
  status: "registered",
};

export class BinanceMarketPlugin implements PluginLifecycle {
  private status: PluginInfo["status"] = "registered";

  async initialize(): Promise<void> {
    this.status = "initialized";
    console.log("[plugin:binance] initialized");
  }

  async start(): Promise<void> {
    this.status = "active";
    const hasKey = !!process.env.BINANCE_API_KEY;
    console.log(`[plugin:binance] started (mode: ${hasKey ? "authenticated" : "public"})`);
  }

  async stop(): Promise<void> {
    this.status = "registered";
    console.log("[plugin:binance] stopped");
  }

  getHealth(): PluginInfo {
    return { ...BinancePluginInfo, status: this.status };
  }
}
