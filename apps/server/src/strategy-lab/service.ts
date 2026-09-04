// ============================================================================
// Strategy Lab — ServiceLifecycle wrapper for FinanceRuntime
// ============================================================================

import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import type { TypedEventBus } from "@finance/core";
import { StrategyLab } from "./strategy-lab.js";
import type { StrategyRegistry } from "../strategies/strategy-registry.js";
import type { MarketDataPort } from "../environment/types.js";

export class StrategyLabService implements ServiceLifecycle {
  private lab: StrategyLab;
  private info: ServiceInfo = {
    id: "strategy-lab",
    name: "Strategy Lab",
    version: "0.1.0",
    description: "Idea -> Strategy -> Backtest -> Performance -> Risk -> Paper Candidate (reuses BacktestEngine, modular strategies)",
    status: "registered",
  };

  constructor(opts: { bus: TypedEventBus; strategyRegistry?: StrategyRegistry; market?: MarketDataPort }) {
    this.lab = new StrategyLab({ bus: opts.bus, strategyRegistry: opts.strategyRegistry, market: opts.market });
  }

  async initialize(): Promise<void> { this.info.status = "initialized"; }
  async start(): Promise<void> { this.info.status = "active"; console.log(`[service:${this.info.id}] started`); }
  async stop(): Promise<void> { this.info.status = "stopped"; console.log(`[service:${this.info.id}] stopped`); }
  getHealth(): ServiceInfo { return { ...this.info }; }
  getInstance(): StrategyLab { return this.lab; }
}
