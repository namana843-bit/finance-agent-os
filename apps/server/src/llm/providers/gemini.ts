import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";
import { redactText } from "../redact.js";

export interface GeminiProviderOptions {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Gemini tool calling exists from 1.5 onward. Older 1.0 models must not be
 * advertised as tool-capable — the capability flag drives whether the runtime
 * attaches tools, so overstating it would break those models at runtime.
 */
function modelSupportsTools(modelId: string): boolean {
  if (/gemini-1\.0/i.test(modelId)) return false;
  return /gemini-(1\.5|2|2\.5|3|4)/i.test(modelId);
}

function mergeSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  external.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export class GeminiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyEnv: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GeminiProviderOptions = {}) {
    this.id = opts.providerId ?? "gemini";
    this.name = opts.providerName ?? "Google Gemini";
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.apiKeyOverride = opts.apiKey;
    this.apiKeyEnv = opts.apiKeyEnv ?? "GEMINI_API_KEY";
    this.defaultModel = opts.defaultModel ?? "gemini-2.0-flash";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** Header auth only — a key in the query string would leak into logs. */
  private getApiKey(): string | undefined {
    return this.apiKeyOverride || process.env[this.apiKeyEnv] || process.env.GOOGLE_API_KEY;
  }

  private headers(apiKey: string): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
  }

  supportsTools(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        providerId: this.id,
        status: "error",
        message: `API key missing: ${this.apiKeyEnv} (or GOOGLE_API_KEY)`,
      };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1beta/models?pageSize=1`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) return { providerId: this.id, status: "ok", latencyMs };
      const body = await res.text().catch(() => "");
      return {
        providerId: this.id,
        status: res.status === 400 || res.status === 401 || res.status === 403 ? "error" : "degraded",
        message: redactText(`HTTP ${res.status}: ${body.slice(0, 200)}`),
        latencyMs,
      };
    } catch (err) {
      return {
        providerId: this.id,
        status: "unreachable",
        message: redactText(err instanceof Error ? err.message : String(err)),
        latencyMs: Date.now() - start,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1beta/models?pageSize=200`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          description?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      if (!Array.isArray(data.models)) return [];
      return data.models
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => {
          const id = (model.name ?? "").replace(/^models\//, "");
          return {
            id,
            name: model.displayName || id,
            provider: this.id,
            contextWindow: model.inputTokenLimit,
            supportsTools: modelSupportsTools(id),
            supportsStreaming: true,
            supportsReasoning: /gemini-(2\.5|3)/i.test(id),
            description: model.description,
          };
        })
        .filter((model) => model.id.length > 0);
    } catch {
      return [];
    }
  }

  async *chat(request: ChatRequest, opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const model = (request.model || this.defaultModel).replace(/^models\//, "");
    const apiKey = this.getApiKey();

    if (!apiKey) {
      yield {
        type: "error",
        messageId,
        error: `API key missing for environment variable '${this.apiKeyEnv}'`,
        timestamp: Date.now(),
      };
      return;
    }

    yield { type: "message_start", messageId, model, timestamp: Date.now() };

    type GeminiPart =
      | { text: string }
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | { functionResponse: { name: string; response: Record<string, unknown> } };

    const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
    const push = (role: "user" | "model", parts: GeminiPart[]) => {
      if (parts.length === 0) return;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    };

    const systemParts: string[] = [];
    if (request.systemPrompt) systemParts.push(request.systemPrompt);

    for (const message of request.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
      } else if (message.role === "tool") {
        push("user", [
          {
            functionResponse: {
              name: message.name ?? "tool",
              response: { result: message.content },
            },
          },
        ]);
      } else if (message.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
        push("model", parts);
      } else {
        push("user", [{ text: message.content }]);
      }
    }

    const payload: Record<string, unknown> = { contents };
    const system = systemParts.filter(Boolean).join("\n\n");
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;

    // Tools are only attached when the model is known to accept them.
    if (request.tools && request.tools.length > 0 && modelSupportsTools(model)) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
    }

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify(payload),
        signal: mergeSignals(this.timeoutMs, opts?.signal),
      });
    } catch (err) {
      yield {
        type: "error",
        messageId,
        error: redactText(err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      };
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        type: "error",
        messageId,
        error: redactText(`Gemini API returned ${response.status}: ${body.slice(0, 400)}`),
        timestamp: Date.now(),
      };
      return;
    }
    if (!response.body) {
      yield { type: "error", messageId, error: "Gemini response body is null", timestamp: Date.now() };
      return;
    }

    let fullText = "";
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let toolIndex = 0;

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          let parsed: {
            candidates?: Array<{
              content?: { parts?: Array<Record<string, any>> };
              finishReason?: string;
            }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          };
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          if (parsed.usageMetadata) {
            usage = {
              promptTokens: parsed.usageMetadata.promptTokenCount,
              completionTokens: parsed.usageMetadata.candidatesTokenCount,
            };
          }

          const candidate = parsed.candidates?.[0];
          if (!candidate) continue;
          if (candidate.finishReason) finishReason = candidate.finishReason;

          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text) {
              fullText += part.text;
              yield { type: "text_delta", messageId, delta: part.text, timestamp: Date.now() };
            } else if (part.functionCall) {
              toolCalls.push({
                name: String(part.functionCall.name ?? "tool"),
                args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              });
            }
          }
        }
      }
    } catch (err) {
      yield {
        type: "error",
        messageId,
        error: redactText(err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      };
      return;
    }

    for (const call of toolCalls) {
      yield {
        type: "tool_call",
        messageId,
        toolCallId: `call_${toolIndex++}`,
        name: call.name,
        arguments: call.args,
        timestamp: Date.now(),
      };
    }

    yield {
      type: "message_complete",
      messageId,
      text: fullText,
      finishReason,
      usage,
      timestamp: Date.now(),
    };
  }
}
