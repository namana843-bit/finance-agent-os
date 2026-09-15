import type { TypedEventBus } from "@finance/core";
import type { Storage, Message } from "../core/storage.js";

export interface BotConfig {
  id: string;
  name: string;
  avatar: string;
  personality: string;
  agentId: string;
  account: "paper" | "live";
}

export type SubmitTaskFn = (task: string, correlationId?: string) => Promise<unknown>;

export interface ChatCoreOptions {
  bus: TypedEventBus;
  storage?: Storage;
  submitTask?: SubmitTaskFn;
}

export interface SendResult {
  message: Message;
  planId: string | null;
}
