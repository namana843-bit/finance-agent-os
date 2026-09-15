import type { ServiceLifecycle, ServiceInfo } from "@finance/core";
import type { TypedEventBus } from "@finance/core";
import type { Storage } from "../core/storage.js";
import { ChatCore } from "./chat-service.js";
import type { SubmitTaskFn } from "./types.js";

export class ChatService implements ServiceLifecycle {
  private readonly core: ChatCore;
  private info: ServiceInfo = {
    id: "chat",
    name: "Chat Service",
    version: "0.1.0",
    description: "Bots-as-contacts chat layer: threads, bot registry, event mirroring",
    status: "registered",
  };

  constructor(opts: { bus: TypedEventBus; storage?: Storage; submitTask?: SubmitTaskFn; getLlm?: () => Pick<import("../llm/llm-service.js").LlmService, "complete" | "isConfigured"> | undefined }) {
    this.core = new ChatCore({ bus: opts.bus, storage: opts.storage, submitTask: opts.submitTask, getLlm: opts.getLlm });
  }

  async initialize(): Promise<void> {
    this.info.status = "initialized";
  }

  async start(): Promise<void> {
    this.core.start();
    this.info.status = "active";
  }

  async stop(): Promise<void> {
    this.core.stop();
    this.info.status = "stopped";
  }

  getHealth(): ServiceInfo {
    return { ...this.info };
  }

  getInstance(): ChatCore {
    return this.core;
  }
}
