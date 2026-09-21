import type { TypedEventBus } from "@finance/core";
import { BaseServiceWrapper } from "../core/service-wrapper.js";
import type { Storage } from "../core/storage.js";
import { ChatCore } from "./chat-service.js";
import type { SubmitTaskFn } from "./types.js";

export class ChatService extends BaseServiceWrapper<ChatCore> {
  constructor(opts: { bus: TypedEventBus; storage?: Storage; submitTask?: SubmitTaskFn; getLlm?: () => Pick<import("../llm/llm-service.js").LlmService, "complete" | "isConfigured"> | undefined }) {
    const core = new ChatCore({ bus: opts.bus, storage: opts.storage, submitTask: opts.submitTask, getLlm: opts.getLlm });
    super(
      { id: "chat", name: "Chat Service", description: "Bots-as-contacts chat layer: threads, bot registry, event mirroring" },
      core,
      { onStart: (c) => c.start(), onStop: (c) => c.stop() }
    );
  }
}
