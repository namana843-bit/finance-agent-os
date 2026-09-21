import type { ModelInfo, ProviderHealth } from "@finance/shared";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIProviderOptions } from "./openai.js";

export interface OpenAICompatibleProviderOptions extends OpenAIProviderOptions {
  providerId?: string;
  providerName?: string;
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly id: string;
  override readonly name: string;

  constructor(opts: OpenAICompatibleProviderOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey ?? (opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : "no-key-required"),
      defaultModel: opts.defaultModel || "local-model",
    });

    this.id = opts.providerId || "openai-compatible";
    this.name = opts.providerName || "OpenAI Compatible";
  }

  override async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await (this as any).fetchImpl(`${(this as any).baseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          providerId: this.id,
          status: "ok",
          latencyMs,
        };
      }
      return {
        providerId: this.id,
        status: "degraded",
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
      const res = await (this as any).fetchImpl(`${(this as any).baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      if (!Array.isArray(data.data)) return [];
      return data.data.map((m) => ({
        id: m.id,
        name: m.id,
        provider: this.id,
        supportsTools: true,
      }));
    } catch {
      return [];
    }
  }
}
