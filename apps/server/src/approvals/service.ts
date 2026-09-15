import type { ServiceInfo, ServiceLifecycle, TypedEventBus } from "@finance/core";
import { ApprovalService } from "./approval-service.js";
import type { ApprovalServiceOptions } from "./types.js";

export class ApprovalServiceWrapper implements ServiceLifecycle {
  private readonly inner: ApprovalService;
  private info: ServiceInfo = {
    id: "approvals",
    name: "Trade Approvals",
    version: "0.1.0",
    description: "Human-in-the-loop trade proposals: quant signals held for Approve/Reject",
    status: "registered",
  };

  constructor(opts: ApprovalServiceOptions & { bus: TypedEventBus }) {
    this.inner = new ApprovalService(opts);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.inner.start();
    this.info.status = "active";
  }

  async stop(): Promise<void> {
    this.inner.stop();
    this.info.status = "stopped";
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): ApprovalService {
    return this.inner;
  }
}
