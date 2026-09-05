// ============================================================================
// Finance Environment — Service Wrapper (lifecycle integration)
// Registers FinanceEnvironment as a ServiceLifecycle so runtime manages it.
// ============================================================================

import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import type { FinanceEnvironment } from "./types.js";
import type { TypedEventBus } from "@finance/core";

export class FinanceEnvironmentService implements ServiceLifecycle {
  private info: ServiceInfo = {
    id: "finance-environment",
    name: "Finance Environment",
    version: "0.1.0",
    description: "Finance Agent OS environment: market/portfolio/paper/backtest (no live orders)",
    status: "registered",
  };

  constructor(
    private env: FinanceEnvironment,
    private bus: TypedEventBus,
  ) {}

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    this.bus.publish({
      type: "environment.started",
      data: { environmentId: this.env.id, mode: this.env.mode, timestamp: Date.now() },
      source: "finance-environment",
    });
    console.log(`[service:${this.info.id}] started (mode=${this.env.mode})`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    this.bus.publish({
      type: "environment.stopped",
      data: { environmentId: this.env.id, timestamp: Date.now() },
      source: "finance-environment",
    });
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): FinanceEnvironment {
    return this.env;
  }
}
