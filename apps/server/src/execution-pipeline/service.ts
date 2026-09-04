// ============================================================================
// Execution Pipeline — Service Wrapper
// Registers as ServiceLifecycle in FinanceRuntime.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import type { RiskAgent } from "../agents/risk/index.js";
import type { FinanceGateway } from "../gateway/finance-gateway.js";
import type { PaperBroker } from "../broker/paper-broker.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { ExecutionPipeline } from "./pipeline.js";
import { PipelineAuditLog } from "./audit.js";
import type { PipelineConfig } from "./types.js";

export class ExecutionPipelineService implements ServiceLifecycle {
  private pipeline: ExecutionPipeline;
  private info: ServiceInfo = {
    id: "execution-pipeline",
    name: "Execution Pipeline",
    version: "0.1.0",
    description: "Safe execution: Signal -> Risk -> Permission -> Paper -> Result (live disabled by default)",
    status: "registered",
  };

  constructor(opts: {
    bus: TypedEventBus;
    riskAgent: RiskAgent;
    gateway: FinanceGateway;
    paperBroker: PaperBroker;
    auditLogger?: AuditLogger;
    config?: Partial<PipelineConfig>;
  }) {
    this.pipeline = new ExecutionPipeline({
      bus: opts.bus,
      riskAgent: opts.riskAgent,
      gateway: opts.gateway,
      paperBroker: opts.paperBroker,
      auditLogger: opts.auditLogger,
      pipelineAudit: new PipelineAuditLog(opts.bus),
      config: opts.config,
    });
  }

  async initialize(): Promise<void> { this.info.status = "initialized"; }
  async start(): Promise<void> { this.info.status = "active"; console.log(`[service:${this.info.id}] started (live=${this.pipeline.isLiveEnabled() ? "enabled" : "disabled"})`); }
  async stop(): Promise<void> { this.info.status = "stopped"; console.log(`[service:${this.info.id}] stopped`); }
  getHealth(): ServiceInfo { return { ...this.info }; }
  getInstance(): ExecutionPipeline { return this.pipeline; }
}
