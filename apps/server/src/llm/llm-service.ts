import { CliDriver } from "./cli-driver.js";
import type { SpawnFn } from "./cli-driver.js";
import { OpenAICompatDriver } from "./openai-compat.js";
import type {
  CompleteOptions,
  LlmCompletion,
  LlmConfig,
  LlmDriver,
  LlmServiceOptions,
} from "./types.js";
import type { UsageSnapshot } from "./usage.js";
import { UsageTracker } from "./usage.js";

export class LlmService {
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly spawnImpl: SpawnFn | undefined;
  private readonly tracker: UsageTracker | undefined;

  constructor(opts?: LlmServiceOptions) {
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 30_000;
    this.fetchImpl = opts?.fetchImpl;
    this.spawnImpl = opts?.spawnImpl;
    this.tracker = opts?.tracker;
  }

  async complete(
    cfg: LlmConfig,
    prompt: string,
    opts?: CompleteOptions,
  ): Promise<string> {
    let driver: LlmDriver;
    if (cfg.provider === "cli") {
      driver = new CliDriver({
        command: cfg.command,
        model: opts?.model ?? cfg.model,
        args: cfg.args,
        timeoutMs: this.defaultTimeoutMs,
        spawnImpl: this.spawnImpl,
      });
    } else {
      const apiKey = process.env[cfg.apiKeyEnv];
      if (!apiKey) {
        throw new Error(`LLM key missing: ${cfg.apiKeyEnv}`);
      }
      driver = new OpenAICompatDriver({
        baseUrl: cfg.baseUrl,
        apiKey,
        model: opts?.model ?? cfg.model,
        timeoutMs: this.defaultTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
    }
    const modelOpt = opts?.model !== undefined ? { model: opts.model } : undefined;
    let result: LlmCompletion;
    if (typeof driver.completeWithUsage === "function") {
      result = await driver.completeWithUsage(prompt, modelOpt);
    } else {
      result = { text: await driver.complete(prompt, modelOpt) };
    }
    // Record only settled (successful) turns.
    if (this.tracker !== undefined && opts?.botId !== undefined) {
      await this.tracker.record(opts.botId, {
        model: opts.model ?? cfg.model,
        provider: cfg.provider,
        command: cfg.provider === "cli" ? cfg.command : undefined,
        promptChars: prompt.length,
        completionChars: result.text.length,
        usage: result.usage,
      });
    }
    return result.text;
  }

  isConfigured(cfg: LlmConfig): boolean {
    if (cfg.provider === "cli") {
      return cfg.command.trim().length > 0;
    }
    const apiKey = process.env[cfg.apiKeyEnv];
    return apiKey !== undefined && apiKey.length > 0;
  }

  async usageReady(): Promise<void> {
    await this.tracker?.ready;
  }

  getUsage(): UsageSnapshot {
    return (
      this.tracker?.snapshot() ?? {
        rows: [],
        totals: { turns: 0, tokens: 0, costUsd: null },
      }
    );
  }
}
