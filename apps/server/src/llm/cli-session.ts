import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { autoResolveCliPath } from "./cli-resolver.js";
import type { SpawnFn } from "./cli-driver.js";
import { defaultSpawnImpl } from "./cli-driver.js";

export interface CliSessionOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  spawnImpl?: SpawnFn;
  sessionId: string;
  supportsPersistentMode: boolean;
  daemonUrl?: string;
}

export interface SessionMetrics {
  sessionId: string;
  spawnTime: number;
  timeToReady: number;
  firstOutputTime: number;
  firstTextDeltaTime: number;
  totalRequests: number;
  totalStreamDuration: number;
  lastActivity: number;
  createdAt: number;
  requestTimings: RequestTiming[];
}

export interface RequestTiming {
  requestId: number;
  promptSent: number;
  firstOutput: number;
  firstTextDelta: number;
  streamEnd: number;
  totalDuration: number;
  hadToolCall: boolean;
  error?: string;
}

export type SessionState = "starting" | "ready" | "busy" | "unhealthy" | "terminated";

export interface CliSession extends EventEmitter {
  readonly sessionId: string;
  readonly command: string;
  readonly supportsPersistentMode: boolean;
  state: SessionState;
  metrics: SessionMetrics;
  sendPrompt(prompt: string, signal?: AbortSignal): AsyncIterable<StreamingChunk>;
  healthCheck(): Promise<boolean>;
  terminate(): Promise<void>;
  initialize(): Promise<void>;
  on(event: "timing", listener: (timing: RequestTiming) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "stateChange", listener: (state: SessionState) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

export type StreamingChunk = {
  type: "delta" | "tool_call" | "error";
  content?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  error?: string;
};

class PersistentCliSession extends EventEmitter implements CliSession {
  readonly sessionId: string;
  readonly command: string;
  readonly supportsPersistentMode: boolean;
  readonly metrics: SessionMetrics;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly spawnImpl: SpawnFn;
  private readonly daemonUrl?: string;

  private process: ChildProcess | null = null;
  private _state: SessionState = "starting";
  private messageQueue: Array<{
    prompt: string;
    signal?: AbortSignal;
    resolve: (stream: AsyncIterable<StreamingChunk>) => void;
    reject: (err: Error) => void;
  }> = [];
  private isProcessing = false;

  constructor(opts: CliSessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.timeoutMs = opts.timeoutMs;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
    this.supportsPersistentMode = opts.supportsPersistentMode;
    this.daemonUrl = opts.daemonUrl;

    this.metrics = {
      sessionId: opts.sessionId,
      spawnTime: 0,
      timeToReady: 0,
      firstOutputTime: 0,
      firstTextDeltaTime: 0,
      totalRequests: 0,
      totalStreamDuration: 0,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      requestTimings: [],
    };
  }

  get state(): SessionState {
    return this._state;
  }

  set state(value: SessionState) {
    if (this._state !== value) {
      this._state = value;
      this.emit("stateChange", value);
    }
  }

  async initialize(): Promise<void> {
    if (this.supportsPersistentMode && this.daemonUrl) {
      await this.connectToDaemon();
    } else if (this.supportsPersistentMode) {
      await this.spawnProcess();
    } else {
      // In one-shot mode, do not spawn a background process with placeholder args.
      // Verify CLI executable path exists if using default spawn.
      if (!this.spawnImpl || this.spawnImpl === defaultSpawnImpl) {
        const resolved = (await autoResolveCliPath(this.command)) || this.command;
        if (!resolved) {
          throw new Error(`CLI executable '${this.command}' not found`);
        }
      }
      this.state = "ready";
    }
  }

  private async connectToDaemon(): Promise<void> {
    const startTime = Date.now();
    this.metrics.spawnTime = startTime;

    const resolved = (await autoResolveCliPath(this.command)) || this.command;
    const isOpencode = this.command.includes("opencode") || resolved.includes("opencode");
    const finalArgs = [...this.args];

    if (isOpencode && finalArgs.includes("run")) {
      const runIndex = finalArgs.indexOf("run");
      if (runIndex !== -1) {
        finalArgs.splice(runIndex + 1, 0, "--attach", this.daemonUrl!);
      }
    }

    const useShell =
      process.platform === "win32" &&
      (resolved.endsWith(".cmd") ||
        resolved.endsWith(".bat") ||
        resolved.endsWith(".ps1") ||
        !resolved.toLowerCase().endsWith(".exe"));

    return new Promise((resolve, reject) => {
      const child = spawn(resolved, finalArgs, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        shell: useShell,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process = child;

      let ready = false;
      const readinessTimeout = setTimeout(() => {
        if (!ready) {
          ready = true;
          this.metrics.timeToReady = Date.now() - startTime;
          this.state = "ready";
          resolve();
        }
      }, 2000);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!ready) {
          ready = true;
          clearTimeout(readinessTimeout);
          this.metrics.timeToReady = Date.now() - startTime;
          this.metrics.firstOutputTime = Date.now() - startTime;
          this.state = "ready";
          resolve();
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        // Daemon connection errors on stderr don't necessarily mean failure
      });

      child.on("error", (err) => {
        if (!ready) {
          ready = true;
          clearTimeout(readinessTimeout);
          reject(err);
        }
      });

      child.on("exit", (code) => {
        this.process = null;
        if (this._state !== "terminated") {
          this.state = "unhealthy";
          this.emit("exit", code);
        }
      });

      child.stdin?.end();
    });
  }

  private async spawnProcess(): Promise<void> {
    const startTime = Date.now();
    this.metrics.spawnTime = startTime;

    const resolved = (await autoResolveCliPath(this.command)) || this.command;
    const useShell =
      process.platform === "win32" &&
      (resolved.endsWith(".cmd") ||
        resolved.endsWith(".bat") ||
        resolved.endsWith(".ps1") ||
        !resolved.toLowerCase().endsWith(".exe"));

    return new Promise((resolve, reject) => {
      const child = spawn(resolved, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        shell: useShell,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process = child;

      let ready = false;
      const readinessTimeout = setTimeout(() => {
        if (!ready) {
          ready = true;
          this.metrics.timeToReady = Date.now() - startTime;
          this.state = "ready";
          resolve();
        }
      }, 2000);

      child.stdout?.on("data", () => {
        if (!ready) {
          ready = true;
          clearTimeout(readinessTimeout);
          this.metrics.timeToReady = Date.now() - startTime;
          this.metrics.firstOutputTime = Date.now() - startTime;
          this.state = "ready";
          resolve();
        }
      });

      child.on("error", (err) => {
        if (!ready) {
          ready = true;
          clearTimeout(readinessTimeout);
          reject(err);
        }
      });

      child.on("exit", (code) => {
        this.process = null;
        if (this._state !== "terminated") {
          this.state = "unhealthy";
          this.emit("exit", code);
        }
      });
    });
  }

  async *sendPrompt(prompt: string, signal?: AbortSignal): AsyncIterable<StreamingChunk> {
    this.metrics.totalRequests++;
    this.metrics.lastActivity = Date.now();

    if (this._state === "terminated") {
      throw new Error(`Session ${this.sessionId} is terminated`);
    }

    if (!this.supportsPersistentMode) {
      yield* this.oneShotPrompt(prompt, signal);
      return;
    }

    const streamPromise = new Promise<AsyncIterable<StreamingChunk>>((resolve, reject) => {
      this.messageQueue.push({ prompt, signal, resolve, reject });
      this.processQueue();
    });

    const stream = await streamPromise;
    yield* stream;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) return;
    if (this._state === "terminated" || this._state === "unhealthy") {
      const err = new Error(`Session ${this.sessionId} unhealthy`);
      while (this.messageQueue.length > 0) {
        this.messageQueue.shift()!.reject(err);
      }
      return;
    }

    this.isProcessing = true;
    const { prompt, signal, resolve, reject } = this.messageQueue.shift()!;

    try {
      const stream = this.createPromptStream(prompt, signal);
      resolve(stream);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isProcessing = false;
      if (this.messageQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  private async *createPromptStream(prompt: string, signal?: AbortSignal): AsyncIterable<StreamingChunk> {
    const streamStart = Date.now();
    let firstDelta = true;
    const requestId = this.metrics.totalRequests;
    let firstOutputRecorded = false;
    let firstTextDeltaRecorded = false;
    let hadToolCall = false;
    let streamError: Error | undefined;

    if (!this.process || this.process.killed) {
      if (this.supportsPersistentMode && this.daemonUrl) {
        await this.connectToDaemon();
      } else {
        await this.spawnProcess();
      }
    }

    if (!this.process || this.process.killed) {
      yield { type: "error", error: "CLI process not available" };
      return;
    }

    const child = this.process;
    const queue: StreamingChunk[] = [];
    let waiter: ((val: IteratorResult<StreamingChunk>) => void) | null = null;
    let done = false;
    let lineBuffer = "";
    let hasError = false;

    const push = (chunk: StreamingChunk) => {
      if (!firstOutputRecorded && chunk.type !== "error") {
        this.metrics.firstOutputTime = Date.now() - streamStart;
        firstOutputRecorded = true;
      }
      if (firstDelta && chunk.type === "delta") {
        this.metrics.firstTextDeltaTime = Date.now() - streamStart;
        firstTextDeltaRecorded = true;
        firstDelta = false;
      }
      if (chunk.type === "tool_call") {
        hadToolCall = true;
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    };

    const end = (err?: Error) => {
      done = true;
      const totalDuration = Date.now() - streamStart;
      this.metrics.totalStreamDuration += totalDuration;
      streamError = err;
      if (err) {
        push({ type: "error", error: err.message });
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as any, done: true });
      }

      // Emit timing event
      const timing: RequestTiming = {
        requestId,
        promptSent: streamStart,
        firstOutput: firstOutputRecorded ? streamStart + this.metrics.firstOutputTime : 0,
        firstTextDelta: firstTextDeltaRecorded ? streamStart + this.metrics.firstTextDeltaTime : 0,
        streamEnd: Date.now(),
        totalDuration,
        hadToolCall,
        error: err?.message,
      };
      this.emit("timing", timing);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
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
              push({
                type: "tool_call",
                content: trimmed,
                toolCall: {
                  name: parsed.tool_call.name,
                  arguments: parsed.tool_call.arguments || {},
                },
              });
              continue;
            }
            const delta = parsed.delta ?? parsed.content ?? parsed.text;
            if (typeof delta === "string") {
              push({ type: "delta", content: delta });
              continue;
            }
          } catch {}
        }

        push({ type: "delta", content: line + "\n" });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Ignore stderr for streaming, but could log
    });

    const onError = (err: Error) => {
      hasError = true;
      end(err);
    };

    const onExit = (code: number) => {
      if (!done) {
        if (code !== 0 && !hasError) {
          end(new Error(`CLI process exited with code ${code}`));
        } else {
          end();
        }
      }
    };

    child.on("error", onError);
    child.on("exit", onExit);

    if (signal) {
      signal.addEventListener("abort", () => {
        end(new Error("Aborted"));
      }, { once: true });
    }

    try {
      child.stdin?.write(prompt + "\n");
      child.stdin?.end();
    } catch (err) {
      end(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<IteratorResult<StreamingChunk>>((resolve) => {
            waiter = resolve;
          });
        }
      }
    } finally {
      child.off("error", onError);
      child.off("exit", onExit);
    }
  }

  private async *oneShotPrompt(prompt: string, signal?: AbortSignal): AsyncIterable<StreamingChunk> {
    const resolved = (await autoResolveCliPath(this.command)) || this.command;
    if (!resolved && (!this.spawnImpl || this.spawnImpl === defaultSpawnImpl)) {
      yield { type: "error", error: `CLI executable '${this.command}' not found` };
      return;
    }

    const isOpencode = this.command.includes("opencode") || (resolved && resolved.includes("opencode"));
    const finalArgs: string[] = [];
    for (const template of this.args) {
      if (template.includes("{model}")) continue;
      finalArgs.push(template.split("{prompt}").join(prompt));
      if (isOpencode && template === "run" && this.daemonUrl) {
        finalArgs.push("--attach", this.daemonUrl);
        finalArgs.push("--pure");
      }
    }

    // Support custom / mock spawnImpl if provided
    if (this.spawnImpl && this.spawnImpl !== defaultSpawnImpl) {
      try {
        const res = await this.spawnImpl(resolved || this.command, finalArgs, {
          cwd: this.cwd,
          env: this.env,
          timeoutMs: this.timeoutMs,
        });
        if (res.code !== 0 && !res.stdout) {
          yield { type: "error", error: res.stderr || `CLI process exited with code ${res.code}` };
        } else {
          yield { type: "delta", content: res.stdout };
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err.message : String(err) };
      }
      return;
    }

    const useShell =
      process.platform === "win32" &&
      (resolved.endsWith(".cmd") ||
        resolved.endsWith(".bat") ||
        resolved.endsWith(".ps1") ||
        !resolved.toLowerCase().endsWith(".exe"));

    const child = spawn(resolved, finalArgs, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let lineBuffer = "";
    let done = false;

    child.stdin?.end();

    const queue: StreamingChunk[] = [];
    let waiter: ((val: IteratorResult<StreamingChunk>) => void) | null = null;

    const push = (chunk: StreamingChunk) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    };

    const end = (err?: Error) => {
      done = true;
      if (err) {
        push({ type: "error", error: err.message });
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as any, done: true });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (done) return;
      const text = chunk.toString("utf-8");
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
              push({ type: "tool_call", content: trimmed, toolCall: { name: parsed.tool_call.name, arguments: parsed.tool_call.arguments || {} } });
              continue;
            }
            const delta = parsed.delta ?? parsed.content ?? parsed.text;
            if (typeof delta === "string") {
              push({ type: "delta", content: delta });
              continue;
            }
          } catch {}
        }
        push({ type: "delta", content: line + "\n" });
      }
    });

    child.stderr?.on("data", () => {});

    const onError = (err: Error) => {
      end(err);
    };

    const onClose = (code: number) => {
      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.tool_call?.name) {
              push({ type: "tool_call", content: trimmed, toolCall: { name: parsed.tool_call.name, arguments: parsed.tool_call.arguments || {} } });
            } else {
              const delta = parsed.delta ?? parsed.content ?? parsed.text;
              if (typeof delta === "string") {
                push({ type: "delta", content: delta });
              }
            }
          } catch {}
        }
      }
      end(code !== 0 ? new Error(`CLI process exited with code ${code}`) : undefined);
    };

    child.on("error", onError);
    child.on("close", onClose);

    if (signal) {
      signal.addEventListener("abort", () => {
        end(new Error("Aborted"));
      }, { once: true });
    }

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<IteratorResult<StreamingChunk>>((resolve) => {
            waiter = resolve;
          });
        }
      }
    } finally {
      child.off("error", onError);
      child.off("close", onClose);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.process || this.process.killed) return false;
    if (this._state === "terminated") return false;
    return this._state === "ready" || this._state === "busy";
  }

  async terminate(): Promise<void> {
    this._state = "terminated";
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
    this.emit("terminated");
  }
}

export class CliSessionManager {
  private readonly sessions = new Map<string, CliSession>();
  private readonly defaultTimeoutMs = 45_000;
  private readonly idleTimeoutMs = 5 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly daemonUrl: string | null = null;

  constructor(opts?: { daemonUrl?: string; idleTimeoutMs?: number }) {
    this.daemonUrl = opts?.daemonUrl ?? null;
    if (opts?.idleTimeoutMs) {
      this.idleTimeoutMs = opts.idleTimeoutMs;
    }
    this.startCleanupTimer();
  }

  private getSessionKey(botId: string, command: string): string {
    return `${botId}:${command}`;
  }

  async getOrCreateSession(
    botId: string,
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; spawnImpl?: SpawnFn }
  ): Promise<CliSession> {
    const key = this.getSessionKey(botId, command);
    let session = this.sessions.get(key);

    if (session) {
      const healthy = await session.healthCheck();
      if (healthy && session.state !== "terminated") {
        return session;
      }
      this.sessions.delete(key);
      try { await session.terminate(); } catch {}
    }

    const resolvedCommand = (await autoResolveCliPath(command)) || command;
    const isOpencode = command.includes("opencode") || resolvedCommand.includes("opencode");
    const supportsPersistent = isOpencode && Boolean(this.daemonUrl);

    session = new PersistentCliSession({
      sessionId: key,
      command: resolvedCommand,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
      spawnImpl: opts?.spawnImpl,
      supportsPersistentMode: supportsPersistent,
      daemonUrl: supportsPersistent ? this.daemonUrl! : undefined,
    });

    this.sessions.set(key, session);

    try {
      await session.initialize();
    } catch (err) {
      this.sessions.delete(key);
      try { await session.terminate(); } catch {}
      throw err;
    }

    session.on("exit", () => {
      this.sessions.delete(key);
    });

    return session;
  }

  getSession(botId: string, command: string): CliSession | undefined {
    return this.sessions.get(this.getSessionKey(botId, command));
  }

  async removeSession(botId: string, command: string): Promise<void> {
    const key = this.getSessionKey(botId, command);
    const session = this.sessions.get(key);
    if (session) {
      this.sessions.delete(key);
      await session.terminate();
    }
  }

  async terminateAll(): Promise<void> {
    for (const [, session] of this.sessions) {
      try { await session.terminate(); } catch {}
    }
    this.sessions.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  listSessions(): Array<{ botId: string; command: string; session: CliSession }> {
    const result: Array<{ botId: string; command: string; session: CliSession }> = [];
    for (const [key, session] of this.sessions) {
      const [botId, command] = key.split(":", 2);
      result.push({ botId, command, session });
    }
    return result;
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (session.state === "terminated") {
          this.sessions.delete(key);
          continue;
        }
        if (now - session.metrics.lastActivity > this.idleTimeoutMs) {
          if (session.state !== "busy") {
            session.terminate();
            this.sessions.delete(key);
          }
        }
      }
    }, 60_000);
    this.cleanupInterval.unref?.();
  }
}

export function createCliSessionManager(opts?: { daemonUrl?: string; idleTimeoutMs?: number }): CliSessionManager {
  return new CliSessionManager(opts);
}

export { PersistentCliSession };