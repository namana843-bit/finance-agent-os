import type { SpawnFn } from "./cli-driver.js";
import type { UsageTracker } from "./usage.js";

export interface OpenAICompatConfig {
  provider: "openai-compat";
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}

export interface CliConfig {
  provider: "cli";
  command: string;
  model?: string;
  args?: string[];
}

export type LlmConfig = OpenAICompatConfig | CliConfig;

export interface LlmCompletion {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface LlmDriver {
  complete(prompt: string, opts?: { model?: string }): Promise<string>;
  completeWithUsage?(
    prompt: string,
    opts?: { model?: string },
  ): Promise<LlmCompletion>;
}

export interface CompleteOptions {
  model?: string;
  /** When set (and a tracker is configured), the settled turn is recorded. */
  botId?: string;
}

export interface LlmServiceOptions {
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnFn;
  tracker?: UsageTracker;
}
