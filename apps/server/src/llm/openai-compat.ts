import type { LlmCompletion, LlmDriver } from "./types.js";

export interface OpenAICompatDriverOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function extractContent(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? content : undefined;
}

function extractUsage(
  data: unknown,
): { promptTokens?: number; completionTokens?: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const usage = (data as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const promptTokens = u["prompt_tokens"];
  const completionTokens = u["completion_tokens"];
  if (typeof promptTokens !== "number" && typeof completionTokens !== "number") {
    return undefined;
  }
  return {
    ...(typeof promptTokens === "number" ? { promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completionTokens } : {}),
  };
}

export class OpenAICompatDriver implements LlmDriver {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatDriverOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(prompt: string, opts?: { model?: string }): Promise<string> {
    const result = await this.completeWithUsage(prompt, opts);
    return result.text;
  }

  async completeWithUsage(
    prompt: string,
    opts?: { model?: string },
  ): Promise<LlmCompletion> {
    const model = opts?.model ?? this.model;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM request failed: ${message}`);
    }
    if (!res.ok) {
      let snippet = "";
      try {
        const text = await res.text();
        snippet = text.slice(0, 500);
      } catch {
        snippet = "";
      }
      throw new Error(`LLM request failed: ${res.status} ${snippet}`.trimEnd());
    }
    const data: unknown = await res.json();
    const content = extractContent(data);
    if (content === undefined) {
      throw new Error("empty LLM response");
    }
    const usage = extractUsage(data);
    return usage === undefined ? { text: content } : { text: content, usage };
  }
}
