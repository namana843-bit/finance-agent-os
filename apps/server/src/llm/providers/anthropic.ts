import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";
import { redactText } from "../redact.js";

export interface AnthropicProviderOptions {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  /** Per-request ceiling; a hung socket must not stall an agent run forever. */
  timeoutMs?: number;
}

const ANTHROPIC_VERSION = "2023-06-01";

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

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyEnv: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.id = opts.providerId ?? "anthropic";
    this.name = opts.providerName ?? "Anthropic Claude";
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKeyOverride = opts.apiKey;
    this.apiKeyEnv = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    this.defaultModel = opts.defaultModel ?? "claude-sonnet-4-20250514";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private getApiKey(): string | undefined {
    return this.apiKeyOverride || process.env[this.apiKeyEnv];
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
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
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models?limit=1`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { providerId: this.id, status: "ok", latencyMs };
      }
      const body = await res.text().catch(() => "");
      return {
        providerId: this.id,
        status: res.status === 401 || res.status === 403 ? "error" : "degraded",
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
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models?limit=100`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string; created_at?: string }>;
      };
      if (!Array.isArray(data.data)) return [];
      return data.data.map((model) => ({
        id: model.id,
        name: model.display_name || model.id,
        provider: this.id,
        // Every Claude model that is reachable through /v1/messages streams and
        // accepts tool definitions.
        supportsTools: true,
        supportsStreaming: true,
        supportsReasoning: /claude-(3-7|4|sonnet-4|opus-4)/i.test(model.id),
        contextWindow: 200_000,
      }));
    } catch {
      return [];
    }
  }

  async *chat(request: ChatRequest, opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
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

    yield { type: "message_start", messageId, model, timestamp: Date.now() };

    const systemParts: string[] = [];
    if (request.systemPrompt) systemParts.push(request.systemPrompt);

    type AnthropicBlock =
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | { type: "tool_result"; tool_use_id: string; content: string };

    const messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
    const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
      if (blocks.length === 0) return;
      const last = messages[messages.length - 1];
      // Anthropic requires alternating roles; merge consecutive turns.
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };

    for (const message of request.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.role === "tool") {
        push("user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "unknown",
            content: message.content,
          },
        ]);
        continue;
      }
      if (message.role === "assistant") {
        const blocks: AnthropicBlock[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        }
        push("assistant", blocks);
        continue;
      }
      push("user", [{ type: "text", text: message.content }]);
    }

    const payload: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
    };
    const system = systemParts.filter(Boolean).join("\n\n");
    if (system) payload.system = system;
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
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
        error: redactText(`Anthropic API returned ${response.status}: ${body.slice(0, 400)}`),
        timestamp: Date.now(),
      };
      return;
    }
    if (!response.body) {
      yield { type: "error", messageId, error: "Anthropic response body is null", timestamp: Date.now() };
      return;
    }

    let fullText = "";
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    const toolBlocks: Array<{ id: string; name: string; json: string }> = [];
    const openTools = new Map<number, { id: string; name: string; json: string }>();

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
          if (!dataStr) continue;

          let parsed: {
            type?: string;
            index?: number;
            message?: { usage?: { input_tokens?: number } };
            usage?: { output_tokens?: number };
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            content_block?: { type?: string; id?: string; name?: string };
          };
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          if (parsed.type === "message_start" && parsed.message?.usage?.input_tokens !== undefined) {
            usage = { promptTokens: parsed.message.usage.input_tokens };
          } else if (parsed.type === "content_block_start") {
            if (parsed.content_block?.type === "tool_use" && parsed.index !== undefined) {
              openTools.set(parsed.index, {
                id: parsed.content_block.id ?? `call_${parsed.index}`,
                name: parsed.content_block.name ?? "",
                json: "",
              });
            }
          } else if (parsed.type === "content_block_delta" && parsed.delta) {
            if (parsed.delta.type === "text_delta" && parsed.delta.text) {
              fullText += parsed.delta.text;
              yield {
                type: "text_delta",
                messageId,
                delta: parsed.delta.text,
                timestamp: Date.now(),
              };
            } else if (parsed.delta.type === "thinking_delta" && parsed.delta.text) {
              yield {
                type: "reasoning_delta",
                messageId,
                delta: parsed.delta.text,
                timestamp: Date.now(),
              };
            } else if (parsed.delta.type === "input_json_delta" && parsed.index !== undefined) {
              const entry = openTools.get(parsed.index);
              if (entry) entry.json += parsed.delta.partial_json ?? "";
            }
          } else if (parsed.type === "content_block_stop" && parsed.index !== undefined) {
            const entry = openTools.get(parsed.index);
            if (entry) {
              toolBlocks.push(entry);
              openTools.delete(parsed.index);
            }
          } else if (parsed.type === "message_delta") {
            if (parsed.delta?.stop_reason) finishReason = parsed.delta.stop_reason;
            if (parsed.usage?.output_tokens !== undefined) {
              usage = { ...(usage ?? {}), completionTokens: parsed.usage.output_tokens };
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

    for (const tool of toolBlocks) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tool.json || "{}") as Record<string, unknown>;
      } catch {
        args = { raw: tool.json };
      }
      yield {
        type: "tool_call",
        messageId,
        toolCallId: tool.id,
        name: tool.name,
        arguments: args,
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
