import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { autoResolveCliPath } from "../cli-resolver.js";
import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";
import type { SpawnFn } from "../cli-driver.js";
import { CliSessionManager, createCliSessionManager, CliSession } from "../cli-session.js";

export interface CliProviderOptions {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  spawnImpl?: SpawnFn;
  sessionManager?: CliSessionManager;
  botId?: string;
}

export type StreamingChunk = {
  type: "delta" | "tool_call";
  content: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
};

export type StreamingChunkCallback = (chunk: StreamingChunk) => void;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiter: ((val: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function defaultStreamingSpawnImpl(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
  onChunk: StreamingChunkCallback,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env };
    const useShell =
      process.platform === "win32" &&
      (cmd.endsWith(".cmd") || cmd.endsWith(".bat") || cmd.endsWith(".ps1") || !cmd.toLowerCase().endsWith(".exe"));
    let fullStdout = "";
    let fullStderr = "";
    let lineBuffer = "";
    const child = spawn(cmd, args, { cwd: opts.cwd, env, shell: useShell, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`CLI process killed (timeout ${opts.timeoutMs}ms)`));
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      fullStdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.tool_call?.name) {
              onChunk({ type: "tool_call", content: trimmed, toolCall: { name: parsed.tool_call.name, arguments: parsed.tool_call.arguments || {} } });
              continue;
            }
            const delta = parsed.delta ?? parsed.content ?? parsed.text;
            if (typeof delta === "string") {
              onChunk({ type: "delta", content: delta });
              continue;
            }
          } catch {}
        }
        onChunk({ type: "delta", content: line + "\n" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { fullStderr += chunk.toString("utf-8"); });
    child.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
    child.on("close", (code: number) => {
      clearTimeout(timer);
      if (lineBuffer.trim()) onChunk({ type: "delta", content: lineBuffer });
      resolve({ stdout: fullStdout, stderr: fullStderr, code: code ?? 0 });
    });
    child.stdin?.end();
  });
}

function defaultSpawnImpl(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number }) {
  return defaultStreamingSpawnImpl(cmd, args, opts, () => {});
}

export class CliProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private resolvedCache: string | null | undefined;
  private resolvedAt = 0;
  private static readonly RESOLVE_TTL_MS = 60_000;
  private readonly command: string;
  private readonly defaultArgs: string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly spawnImpl: SpawnFn;
  private readonly isDefaultSpawn: boolean;
  private readonly sessionManager: CliSessionManager;
  private readonly botId: string;

  constructor(opts: CliProviderOptions) {
    this.id = opts.id || `cli-${opts.command.replace(/[^a-zA-Z0-9]/g, "-")}`;
    this.name = opts.name || `CLI (${opts.command})`;
    this.command = opts.command;
    this.defaultArgs = opts.args ?? ["-p", "{prompt}"];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.isDefaultSpawn = !opts.spawnImpl;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
    this.botId = opts.botId ?? "default";
    this.sessionManager = opts.sessionManager ?? createCliSessionManager();
  }

  supportsTools(): boolean { return true; }

  private async resolvePath(cmd: string): Promise<string | null> {
    if (this.resolvedCache !== undefined && Date.now() - this.resolvedAt < CliProvider.RESOLVE_TTL_MS) return this.resolvedCache;
    try {
      const { loadEngineOverrides } = await import("../engines.js");
      const overrides = await loadEngineOverrides();
      let overriddenCmd = cmd;
      const baseId = this.id.startsWith("cli-") ? this.id.slice(4) : this.id;
      if (typeof overrides[baseId] === "string" && overrides[baseId].trim() !== "") overriddenCmd = overrides[baseId].trim();
      else if (typeof overrides[this.id] === "string" && overrides[this.id].trim() !== "") overriddenCmd = overrides[this.id].trim();
      const resolved = await autoResolveCliPath(overriddenCmd);
      this.resolvedCache = resolved;
      this.resolvedAt = Date.now();
      return resolved;
    } catch {
      const fallback = await autoResolveCliPath(cmd);
      this.resolvedCache = fallback;
      this.resolvedAt = Date.now();
      return fallback;
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    const resolved = await this.resolvePath(this.command);
    const latencyMs = Date.now() - start;
    return resolved
      ? { providerId: this.id, status: "ok", message: `Executable resolved: ${resolved}`, latencyMs, modelsCount: 1 }
      : { providerId: this.id, status: "unreachable", message: `CLI executable '${this.command}' not found on system PATH`, latencyMs };
  }

  async listModels(): Promise<ModelInfo[]> {
    const resolved = await this.resolvePath(this.command);
    return resolved ? [{ id: this.command, name: this.name, provider: this.id, supportsTools: true, description: `Local executable: ${resolved}` }] : [];
  }

  async *chat(request: ChatRequest, opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const model = request.model || this.command;
    const botId = opts?.botId ?? this.botId;
    yield { type: "message_start", messageId, model, timestamp: Date.now() };

    // Injected spawners are test doubles and should not require a real executable.
    const resolved = this.isDefaultSpawn ? await this.resolvePath(this.command) : this.command;
    if (!resolved) {
      yield { type: "error", messageId, error: `CLI executable '${this.command}' not found. Please verify executable path or installation.`, timestamp: Date.now() };
      return;
    }

    const prompt = this.buildPrompt(request.messages, request.tools, botId);
    const sessionArgs = this.defaultArgs.map((arg) => arg.split("{model}").join(model));
    const isOpencode = this.command.includes("opencode");
    if (isOpencode) {
      const runIndex = sessionArgs.indexOf("run");
      const opencodeAgent = botId?.replace(/[^a-zA-Z0-9_-]/g, "-");
      if (runIndex !== -1 && opencodeAgent && !sessionArgs.includes("--agent")) sessionArgs.splice(runIndex + 1, 0, "--agent", opencodeAgent, "--model", model);
    }

    let session: CliSession;
    try {
      session = await this.sessionManager.getOrCreateSession(botId ?? this.botId, resolved, sessionArgs, { cwd: this.cwd, env: this.env, timeoutMs: this.timeoutMs, spawnImpl: this.spawnImpl });
    } catch (err) {
      yield { type: "error", messageId, error: `Failed to create CLI session: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() };
      return;
    }

    let completeText = "";
    let hasToolCall = false;
    try {
      for await (const chunk of session.sendPrompt(prompt, opts?.signal)) {
        if (chunk.type === "tool_call" && chunk.toolCall) {
          hasToolCall = true;
          yield { type: "tool_call", messageId, toolCallId: `call_cli_${Date.now()}`, name: chunk.toolCall.name, arguments: chunk.toolCall.arguments, timestamp: Date.now() };
        } else if (chunk.type === "delta" && chunk.content) {
          completeText += chunk.content;
          yield { type: "text_delta", messageId, delta: chunk.content, timestamp: Date.now() };
        } else if (chunk.type === "error") {
          yield { type: "error", messageId, error: chunk.error ?? "Unknown error", timestamp: Date.now() };
          return;
        }
      }
    } catch (err) {
      yield { type: "error", messageId, error: err instanceof Error ? err.message : String(err), timestamp: Date.now() };
      return;
    }
    if (!hasToolCall && completeText.trim().length === 0) {
      yield { type: "error", messageId, error: "CLI engine returned empty response", timestamp: Date.now() };
      return;
    }
    yield { type: "message_complete", messageId, text: completeText.trim(), timestamp: Date.now() };
  }

  private buildPrompt(messages: ChatRequest["messages"], tools?: ChatRequest["tools"], agentId?: string): string {
    if (messages.length === 1 && messages[0]?.role === "user" && !agentId && (!tools || tools.length === 0)) return messages[0]?.content ?? "";
    const parts: string[] = [];
    if (agentId) parts.push(`Active Finance Agent OS agent: ${agentId}. Follow only this agent's role and tool policy.`);
    for (const m of messages) {
      if (m.role === "system") parts.push(`System: ${m.content}`);
      else if (m.role === "user") parts.push(`User: ${m.content}`);
      else if (m.role === "assistant") parts.push(`Assistant: ${m.content}`);
      else if (m.role === "tool") parts.push(`Tool result (${m.name ?? m.toolCallId ?? "tool"}): ${m.content}`);
    }
    if (tools?.length) parts.push(`\nAvailable tools (reply with one JSON line {"tool_call":{"name":"...","arguments":{}}} when you need a tool, else plain text):\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`);
    return parts.join("\n\n");
  }
}
