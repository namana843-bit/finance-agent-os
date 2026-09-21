import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string = "openai";
  readonly name: string = "OpenAI";

  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly apiKeyOverride?: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKeyEnv = opts.apiKeyEnv ?? "OPENAI_API_KEY";
    this.apiKeyOverride = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? "gpt-4o";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private getApiKey(): string | undefined {
    return this.apiKeyOverride || process.env[this.apiKeyEnv];
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
        message: `API key missing: ${this.apiKeyEnv}`,
      };
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        const modelsCount = Array.isArray(data.data) ? data.data.length : 0;
        return {
          providerId: this.id,
          status: "ok",
          latencyMs,
          modelsCount,
        };
      }
      return {
        providerId: this.id,
        status: "degraded",
        message: `HTTP ${res.status}: ${res.statusText}`,
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

  async listModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string; object?: string }> };
      if (!Array.isArray(data.data)) return [];
      return data.data
        .filter((m) => m.id.includes("gpt") || m.id.includes("o1") || m.id.includes("o3"))
        .map((m) => ({
          id: m.id,
          name: m.id,
          provider: this.id,
          supportsTools: true,
          supportsReasoning: m.id.startsWith("o1") || m.id.startsWith("o3"),
        }));
    } catch {
      return [];
    }
  }

  async *chat(
    request: ChatRequest,
    opts?: LLMProviderOptions,
  ): AsyncIterable<LLMEvent> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const model = request.model || this.defaultModel;
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

    yield {
      type: "message_start",
      messageId,
      model,
      timestamp: Date.now(),
    };

    const formattedMessages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt) {
      formattedMessages.push({ role: "system", content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      if (msg.role === "tool") {
        formattedMessages.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        formattedMessages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc: { id?: string; name: string; arguments: Record<string, unknown> }) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    const payload: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t: { name: string; description: string; inputSchema: Record<string, unknown> }) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: opts?.signal,
      });
    } catch (err) {
      yield {
        type: "error",
        messageId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      return;
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {
        errText = response.statusText;
      }
      yield {
        type: "error",
        messageId,
        error: `OpenAI API returned ${response.status}: ${errText.slice(0, 300)}`,
        timestamp: Date.now(),
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        messageId,
        error: "OpenAI response body is null",
        timestamp: Date.now(),
      };
      return;
    }

    let fullText = "";
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;

    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

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
          if (!trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  thinking?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };

            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
              };
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;
            if (!delta) continue;

            // Reasoning / thinking deltas (DeepSeek / o1 / o3)
            const reasoning = delta.reasoning_content || delta.thinking;
            if (reasoning) {
              yield {
                type: "reasoning_delta",
                messageId,
                delta: reasoning,
                timestamp: Date.now(),
              };
            }

            // Text deltas
            if (delta.content) {
              fullText += delta.content;
              yield {
                type: "text_delta",
                messageId,
                delta: delta.content,
                timestamp: Date.now(),
              };
            }

            // Tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                let existing = pendingToolCalls.get(idx);
                if (!existing) {
                  existing = { id: tc.id || `call_${idx}`, name: "", args: "" };
                  pendingToolCalls.set(idx, existing);
                }
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    } catch (err) {
      yield {
        type: "error",
        messageId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      return;
    }

    // Process completed tool calls
    for (const tc of pendingToolCalls.values()) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.args || "{}");
      } catch {
        parsedArgs = { raw: tc.args };
      }

      yield {
        type: "tool_call",
        messageId,
        toolCallId: tc.id,
        name: tc.name,
        arguments: parsedArgs,
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
