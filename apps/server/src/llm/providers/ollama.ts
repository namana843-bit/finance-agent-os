import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";

export interface OllamaProviderOptions {
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  readonly id: string = "ollama";
  readonly name: string = "Ollama";

  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "qwen2.5-coder";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supportsTools(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        const models = await this.listModels();
        return {
          providerId: this.id,
          status: "ok",
          latencyMs,
          modelsCount: models.length,
        };
      }
      return {
        providerId: this.id,
        status: "degraded",
        message: `HTTP ${res.status}: ${res.statusText}`,
        latencyMs,
      };
    } catch {
      return {
        providerId: this.id,
        status: "unreachable",
        message: `Ollama is not running at ${this.baseUrl}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{ name: string; model?: string; details?: { parameter_size?: string } }>;
      };
      if (!Array.isArray(data.models)) return [];
      return data.models.map((m) => ({
        id: m.name,
        name: m.name,
        provider: this.id,
        supportsTools: true,
        description: m.details?.parameter_size ? `Size: ${m.details.parameter_size}` : undefined,
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
          content: msg.content,
        });
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        formattedMessages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.toolCalls.map((tc: { id?: string; name: string; arguments: Record<string, unknown> }) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
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
    };

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
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: opts?.signal,
      });
    } catch (err) {
      yield {
        type: "error",
        messageId,
        error: `Ollama unavailable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
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
        error: `Ollama error ${response.status}: ${errText.slice(0, 300)}`,
        timestamp: Date.now(),
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        messageId,
        error: "Ollama response body is null",
        timestamp: Date.now(),
      };
      return;
    }

    let fullText = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

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
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as {
              message?: {
                content?: string;
                tool_calls?: Array<{
                  function?: { name?: string; arguments?: Record<string, unknown> | string };
                }>;
              };
              done?: boolean;
              prompt_eval_count?: number;
              eval_count?: number;
            };

            if (parsed.prompt_eval_count !== undefined) promptTokens = parsed.prompt_eval_count;
            if (parsed.eval_count !== undefined) completionTokens = parsed.eval_count;

            const msg = parsed.message;
            if (msg) {
              if (msg.content) {
                fullText += msg.content;
                yield {
                  type: "text_delta",
                  messageId,
                  delta: msg.content,
                  timestamp: Date.now(),
                };
              }

              if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                  if (tc.function?.name) {
                    let argsObj: Record<string, unknown> = {};
                    if (typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
                      argsObj = tc.function.arguments;
                    } else if (typeof tc.function.arguments === "string") {
                      try {
                        argsObj = JSON.parse(tc.function.arguments);
                      } catch {
                        argsObj = { raw: tc.function.arguments };
                      }
                    }
                    yield {
                      type: "tool_call",
                      messageId,
                      toolCallId: `call_ollama_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      name: tc.function.name,
                      arguments: argsObj,
                      timestamp: Date.now(),
                    };
                  }
                }
              }
            }
          } catch {
            // Ignore parse errors on raw chunk boundaries
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

    yield {
      type: "message_complete",
      messageId,
      text: fullText,
      usage: promptTokens || completionTokens ? { promptTokens, completionTokens } : undefined,
      timestamp: Date.now(),
    };
  }
}
