import type { ServiceInfo, ServiceLifecycle } from "@finance/core";
import { LlmService } from "./llm-service.js";
import type { LlmServiceOptions } from "./types.js";

export class LlmServiceWrapper implements ServiceLifecycle {
  private readonly inner: LlmService;
  private info: ServiceInfo = {
    id: "llm",
    name: "LLM Service",
    version: "0.1.0",
    description: "OpenAI-compatible LLM completions for bots",
    status: "registered",
  };

  constructor(opts?: LlmServiceOptions) {
    this.inner = new LlmService(opts);
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.info.status = "active";
    console.log(`[service:${this.info.id}] started`);
  }

  async stop(): Promise<void> {
    this.info.status = "stopped";
    console.log(`[service:${this.info.id}] stopped`);
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): LlmService {
    return this.inner;
  }
}
