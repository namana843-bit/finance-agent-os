import type { ServiceInfo, ServiceLifecycle } from "@finance/core";

export interface ServiceWrapperConfig {
  id: string;
  name: string;
  version?: string;
  description: string;
}

export class BaseServiceWrapper<T> implements ServiceLifecycle {
  protected inner: T;
  protected info: ServiceInfo;

  private onStart?: (inner: T) => void | Promise<void>;
  private onStop?: (inner: T) => void | Promise<void>;

  constructor(
    config: ServiceWrapperConfig,
    inner: T,
    hooks?: {
      onStart?: (inner: T) => void | Promise<void>;
      onStop?: (inner: T) => void | Promise<void>;
    }
  ) {
    this.inner = inner;
    this.info = {
      id: config.id,
      name: config.name,
      version: config.version ?? "0.1.0",
      description: config.description,
      status: "registered",
    };
    this.onStart = hooks?.onStart;
    this.onStop = hooks?.onStop;
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    if (this.onStart) await this.onStart(this.inner);
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    if (this.onStop) await this.onStop(this.inner);
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): T {
    return this.inner;
  }
}
