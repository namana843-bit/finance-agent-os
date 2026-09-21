import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";

export interface LLMProviderOptions {
  signal?: AbortSignal;
  botId?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;

  listModels(): Promise<ModelInfo[]>;

  chat(
    request: ChatRequest,
    opts?: LLMProviderOptions,
  ): AsyncIterable<LLMEvent>;

  supportsTools(): boolean;

  healthCheck(): Promise<ProviderHealth>;
}
