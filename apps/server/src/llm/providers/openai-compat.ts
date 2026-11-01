import type { ModelInfo, ProviderHealth } from "@finance/shared";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIProviderOptions } from "./openai.js";

export interface OpenAICompatibleProviderOptions extends OpenAIProviderOptions {
  providerId?: string;
  providerName?: string;
  /** Whether this endpoint accepts OpenAI-style tool/function definitions. */
  supportsTools?: boolean;
  /** Optional allow-list so a gateway does not advertise unrelated models. */
  modelFilter?: RegExp;
}

/**
 * OpenAI-shaped gateways (OpenRouter, xAI, LM Studio, vLLM, any custom
 * endpoint) share one implementation. Only the base URL, credential env name
 * and the capability flags differ, and those come from the provider catalog.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly id: string;
  override readonly name: string;

  private readonly toolsEnabled: boolean;
  private readonly filter?: RegExp;

  constructor(opts: OpenAICompatibleProviderOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey ?? (opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : "no-key-required"),
      defaultModel: opts.defaultModel || "local-model",
    });

    this.id = opts.providerId || "openai-compatible";
    this.name = opts.providerName || "OpenAI Compatible";
    this.toolsEnabled = opts.supportsTools ?? true;
    this.filter = opts.modelFilter;
  }

  override supportsTools(): boolean {
    return this.toolsEnabled;
  }

  override async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await (this as any).fetchImpl(`${(this as any).baseUrl}/models`, {
        headers: (this as any).getApiKey?.()
          ? { Authorization: `Bearer ${(this as any).getApiKey()}` }
          : undefined,
        signal: AbortSignal.timeout(4000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { data?: unknown[] };
        return {
          providerId: this.id,
          status: "ok",
          latencyMs,
          modelsCount: Array.isArray(data.data) ? data.data.length : undefined,
        };
      }
      return {
        providerId: this.id,
        status: res.status === 401 || res.status === 403 ? "error" : "degraded",
        message: `HTTP ${res.status}`,
        latencyMs,
      };
    } catch (err) {
      return {
        providerId: this.id,
        status: "unreachable",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const key = (this as any).getApiKey?.();
      const res = await (this as any).fetchImpl(`${(this as any).baseUrl}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string; name?: string; context_length?: number; context_window?: number }>;
      };
      if (!Array.isArray(data.data)) return [];
      return data.data
        .filter((model) => !this.filter || this.filter.test(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          provider: this.id,
          supportsTools: this.toolsEnabled,
          supportsStreaming: true,
          contextWindow: model.context_length ?? model.context_window,
        }));
    } catch {
      return [];
    }
  }
}
