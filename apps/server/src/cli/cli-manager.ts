// ============================================================================
// Finance Agent OS — CLI Manager
// Central registry + session lifecycle for every CLI adapter.
//
//   Desktop UI / Runtime → CliManager → CliAdapter → adapter implementation
//
// The manager owns: registration, lookup, validation, session start/stop,
// task dispatch, normalized event streaming and process cleanup. It contains
// zero CLI-specific logic.
// ============================================================================

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TypedEventBus } from "@finance/core";
import type {
  CliAdapter,
  CliEvent,
  CliMetadata,
  CliSessionState,
  CliSessionSummary,
  CliStartOptions,
  CliTaskRequest,
  CliTaskResult,
  CliToolActivity,
  CliValidationResult,
} from "./types.js";
import { runCliProcess, type CliProcessResult } from "./process-runner.js";
import { splitLines } from "./parsing.js";

export interface CliManagerOptions {
  /** Optional event bus bridge — every normalized event is re-published as `cli.<type>`. */
  bus?: TypedEventBus;
  /** Injectable process runner (tests); production default is the real spawner. */
  runProcessImpl?: typeof runCliProcess;
  defaultTimeoutMs?: number;
  validationTtlMs?: number;
}

type RunProcessFn = typeof runCliProcess;

/** Buffered async event stream for one session (UI/TUI consumption). */
class CliEventStream implements AsyncIterable<CliEvent> {
  private queue: CliEvent[] = [];
  private waiter: ((value: IteratorResult<CliEvent>) => void) | null = null;
  private closed = false;

  push(event: CliEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CliEvent> {
    return {
      next: (): Promise<IteratorResult<CliEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<CliEvent>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/**
 * One managed CLI session: an adapter + explicit spawn options + lifecycle.
 * Tasks are dispatched sequentially; each task spawns a CLI process (one-shot
 * argv or stdin delivery, optionally attached to the adapter daemon) and
 * streams normalized events.
 */
export class CliManagedSession {
  readonly id: string;
  readonly adapterId: string;
  readonly createdAt: number;
  lastActivityAt: number;
  tasks = 0;

  private readonly adapter: CliAdapter;
  private readonly options: CliStartOptions;
  private readonly emit: (event: CliEvent) => void;
  private readonly stream = new CliEventStream();
  private readonly runProcessImpl: RunProcessFn;
  private readonly defaultTimeoutMs: number;
  private statusValue: CliSessionState = "starting";
  private resolvedExecutable: string | null = null;
  private activeAbort: AbortController | null = null;
  private stopped = false;

  constructor(opts: {
    id: string;
    adapter: CliAdapter;
    options: CliStartOptions;
    emit: (event: CliEvent) => void;
    runProcessImpl: RunProcessFn;
    defaultTimeoutMs: number;
  }) {
    this.id = opts.id;
    this.adapter = opts.adapter;
    this.adapterId = opts.adapter.getMetadata().id;
    this.options = opts.options;
    this.emit = opts.emit;
    this.runProcessImpl = opts.runProcessImpl;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
  }

  get status(): CliSessionState {
    return this.statusValue;
  }

  get command(): string {
    return this.adapter.getMetadata().executable;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  getSummary(): CliSessionSummary {
    return {
      id: this.id,
      adapterId: this.adapterId,
      status: this.statusValue,
      command: this.command,
      cwd: this.options.cwd ?? this.adapter.defaultCwd?.(),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      tasks: this.tasks,
      runningTask: this.statusValue === "busy",
    };
  }

  /** Normalized event stream for this session (UI / TUI consumption). */
  subscribe(): AsyncIterable<CliEvent> {
    return this.stream;
  }

  async runTask(request: CliTaskRequest): Promise<CliTaskResult> {
    if (this.stopped) {
      throw new Error(`CLI session '${this.id}' is stopped`);
    }
    if (this.statusValue === "failed") {
      throw new Error(`CLI session '${this.id}' failed — start a new session`);
    }

    const meta = this.adapter.getMetadata();
    const taskId = `t-${randomUUID().slice(0, 8)}`;
    const base = { sessionId: this.id, adapterId: this.adapterId, taskId };
    this.tasks += 1;
    this.setStatus("busy", "task dispatched", taskId);

    if (this.resolvedExecutable === null) {
      this.resolvedExecutable =
        (await this.adapter.resolveExecutable(meta.executable)) ?? null;
    }
    if (this.resolvedExecutable === null) {
      const message = `CLI executable '${meta.executable}' not found. Please verify executable path or installation.`;
      this.setStatus("failed", message, taskId);
      this.emitEvent({ ...base, type: "error", message, fatal: true, timestamp: Date.now() });
      this.emitEvent({
        ...base,
        type: "session_failed",
        error: message,
        exitCode: null,
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        timestamp: Date.now(),
      });
      return {
        ok: false,
        sessionId: this.id,
        adapterId: this.adapterId,
        taskId,
        output: "",
        toolActivities: [],
        exitCode: null,
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        error: message,
      };
    }

    const templates =
      this.options.args && this.options.args.length > 0
        ? this.options.args
        : this.adapter.buildSessionArgs({ model: request.model, agentId: request.agentId });
    const daemonUrl = this.adapter.daemon?.getUrl() ?? null;
    const args = this.adapter.buildOneShotArgs(templates, request.task, { daemonUrl });
    const cwd = this.options.cwd ?? this.adapter.defaultCwd?.();
    const env = this.adapter.buildEnv(this.options.env);
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? this.defaultTimeoutMs;

    const abort = new AbortController();
    this.activeAbort = abort;
    if (request.signal) {
      if (request.signal.aborted) abort.abort();
      else request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    this.emitEvent({
      ...base,
      type: "session_started",
      command: this.resolvedExecutable,
      args,
      cwd,
      timestamp: Date.now(),
    });

    const textParts: string[] = [];
    const toolActivities: CliToolActivity[] = [];
    let stdoutBuffer = "";

    const handleLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) return;
      const chunk = this.adapter.parseLine(trimmed);
      if (chunk && chunk.type === "tool_call") {
        toolActivities.push({ name: chunk.name, arguments: chunk.arguments });
        this.emitEvent({
          ...base,
          type: "tool_activity",
          name: chunk.name,
          arguments: chunk.arguments,
          timestamp: Date.now(),
        });
        return;
      }
      if (chunk && chunk.type === "delta") {
        textParts.push(chunk.content);
        return;
      }
      textParts.push(rawLine + "\n");
    };

    const result: CliProcessResult = await this.runProcessImpl(
      {
        command: this.resolvedExecutable,
        args,
        cwd,
        env,
        shell: this.adapter.requiresShell(this.resolvedExecutable),
        timeoutMs,
        signal: abort.signal,
        stdinPayload: meta.taskDelivery === "stdin" ? request.task : undefined,
      },
      {
        onStdoutChunk: (chunk) => {
          this.emitEvent({ ...base, type: "output", stream: "stdout", chunk, timestamp: Date.now() });
          stdoutBuffer += chunk;
          const { lines, rest } = splitLines(stdoutBuffer);
          stdoutBuffer = rest;
          for (const line of lines) handleLine(line);
        },
        onStderrChunk: (chunk) => {
          this.emitEvent({ ...base, type: "output", stream: "stderr", chunk, timestamp: Date.now() });
        },
      },
    );

    this.activeAbort = null;
    if (stdoutBuffer.length > 0) {
      handleLine(stdoutBuffer);
      stdoutBuffer = "";
    }

    const ok =
      result.spawnError === undefined &&
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled;
    const errorMessage = ok
      ? undefined
      : result.spawnError ??
        (result.timedOut
          ? `CLI task timed out after ${timeoutMs}ms`
          : result.cancelled
            ? "CLI task cancelled"
            : `CLI process exited with code ${result.exitCode}`);

    if (ok) {
      this.setStatus("ready", "task finished", taskId);
      this.emitEvent({
        ...base,
        type: "session_finished",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timestamp: Date.now(),
      });
    } else {
      if (result.spawnError) this.setStatus("failed", errorMessage, taskId);
      else this.setStatus("ready", "task failed", taskId);
      this.emitEvent({
        ...base,
        type: "error",
        message: errorMessage ?? "CLI task failed",
        fatal: Boolean(result.spawnError),
        timestamp: Date.now(),
      });
      this.emitEvent({
        ...base,
        type: "session_failed",
        error: errorMessage ?? "CLI task failed",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        timestamp: Date.now(),
      });
    }

    return {
      ok,
      sessionId: this.id,
      adapterId: this.adapterId,
      taskId,
      output: textParts.join("").trim(),
      toolActivities,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    };
  }

  /** Stop the session: cancel in-flight task + release event stream. */
  async stop(reason = "session stopped"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.activeAbort?.abort();
    this.setStatus("stopped", reason);
    // Let an in-flight task emit its cancelled/failed result before closing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.stream.close();
  }

  private setStatus(status: CliSessionState, reason?: string, taskId?: string): void {
    if (this.statusValue === status) return;
    if (this.statusValue === "stopped") return;
    this.statusValue = status;
    this.emitEvent({
      sessionId: this.id,
      adapterId: this.adapterId,
      ...(taskId !== undefined ? { taskId } : {}),
      type: "status_changed",
      status,
      ...(reason !== undefined ? { reason } : {}),
      timestamp: Date.now(),
    });
  }

  private emitEvent(event: CliEvent): void {
    this.lastActivityAt = Date.now();
    this.stream.push(event);
    this.emit(event);
  }
}

/**
 * Central CLI manager — the single entry point for the runtime + desktop UI.
 *
 *   register(adapter) · unregister(id) · get(id) · list() · listMetadata()
 *   validate(id) · start(id, opts) · sendTask(sessionId, req) · stop(sessionId)
 *   streamEvents(sessionId) · getStatus(sessionId) · listSessions()
 */
export class CliManager extends EventEmitter {
  private readonly adapters = new Map<string, CliAdapter>();
  private readonly sessions = new Map<string, CliManagedSession>();
  private readonly validationCache = new Map<string, { result: CliValidationResult; at: number }>();
  private bus?: TypedEventBus;
  private readonly runProcessImpl: RunProcessFn;
  private readonly defaultTimeoutMs: number;
  private readonly validationTtlMs: number;

  constructor(opts?: CliManagerOptions) {
    super();
    this.bus = opts?.bus;
    this.runProcessImpl = opts?.runProcessImpl ?? runCliProcess;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 300_000;
    this.validationTtlMs = opts?.validationTtlMs ?? 30_000;
  }

  /** Attach/refresh the event-bus bridge (runtime composition root). */
  setBus(bus: TypedEventBus): void {
    this.bus = bus;
  }

  // -------------------------------------------------------------------------
  // Registration + lookup
  // -------------------------------------------------------------------------

  register(adapter: CliAdapter): void {
    if (!adapter || typeof adapter.getMetadata !== "function") {
      throw new Error("Cannot register invalid CLI adapter");
    }
    const meta = adapter.getMetadata();
    if (!meta || typeof meta.id !== "string" || meta.id.trim() === "") {
      throw new Error("Cannot register CLI adapter without id");
    }
    this.adapters.set(meta.id, adapter);
    this.validationCache.delete(meta.id);
    this.emit("registered", meta);
  }

  unregister(id: string): boolean {
    const existed = this.adapters.delete(id);
    if (existed) {
      this.validationCache.delete(id);
      this.emit("unregistered", id);
    }
    return existed;
  }

  get(id: string): CliAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): CliAdapter[] {
    return [...this.adapters.values()];
  }

  listMetadata(): CliMetadata[] {
    return this.list().map((adapter) => adapter.getMetadata());
  }

  /** Adapter that owns a configured command path (used by the LLM layer). */
  findByExecutable(command: string, resolvedPath?: string | null): CliAdapter | undefined {
    return this.list().find((adapter) => adapter.matchesExecutable(command, resolvedPath));
  }

  /** Resolve engine ids/aliases (`opencode-cli` → OpenCodeAdapter). */
  findByEngineId(engineId: string): CliAdapter | undefined {
    const needle = engineId.trim().toLowerCase();
    if (needle.length === 0) return undefined;
    const idsOf = (adapter: CliAdapter): string[] => {
      const meta = adapter.getMetadata();
      return [meta.id, ...meta.engineAliases].map((value) => value.toLowerCase());
    };
    const exact = this.list().find((adapter) => idsOf(adapter).includes(needle));
    if (exact) return exact;
    return this.list().find((adapter) =>
      idsOf(adapter).some((value) => value.length > 0 && needle.includes(value)),
    );
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Validate installation of one adapter (cached briefly). Never throws. */
  async validate(id: string, opts?: { force?: boolean }): Promise<CliValidationResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      return {
        adapterId: id,
        ok: false,
        executable: "",
        resolvedPath: null,
        version: null,
        error: `Unknown CLI adapter '${id}'`,
        checkedAt: Date.now(),
      };
    }
    if (!opts?.force) {
      const hit = this.validationCache.get(id);
      if (hit && Date.now() - hit.at < this.validationTtlMs) return hit.result;
    }
    let result: CliValidationResult;
    try {
      result = await adapter.validateInstallation();
    } catch (err) {
      result = {
        adapterId: id,
        ok: false,
        executable: adapter.getMetadata().executable,
        resolvedPath: null,
        version: null,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    }
    this.validationCache.set(id, { result, at: Date.now() });
    return result;
  }

  async validateAll(): Promise<CliValidationResult[]> {
    return Promise.all(this.list().map((adapter) => this.validate(adapter.getMetadata().id)));
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async start(adapterId: string, opts?: CliStartOptions): Promise<CliManagedSession> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`Unknown CLI adapter '${adapterId}'`);
    }
    const session = new CliManagedSession({
      id: `cli-${adapterId}-${randomUUID().slice(0, 8)}`,
      adapter,
      options: opts ?? {},
      emit: (event) => this.emitEvent(event),
      runProcessImpl: this.runProcessImpl,
      defaultTimeoutMs: this.defaultTimeoutMs,
    });
    this.sessions.set(session.id, session);
    this.emit("session", session.getSummary());
    return session;
  }

  getSession(id: string): CliManagedSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): CliSessionSummary[] {
    return [...this.sessions.values()].map((session) => session.getSummary());
  }

  getStatus(sessionId: string): CliSessionState | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  async sendTask(sessionId: string, request: CliTaskRequest): Promise<CliTaskResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown CLI session '${sessionId}'`);
    }
    return session.runTask(request);
  }

  /** Normalized event stream for one session. */
  streamEvents(sessionId: string): AsyncIterable<CliEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown CLI session '${sessionId}'`);
    }
    return session.subscribe();
  }

  async stop(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.stop(reason);
    this.emit("session", session.getSummary());
  }

  /** Stop every managed session (runtime shutdown / process-safety cleanup). */
  async stopAll(): Promise<void> {
    for (const summary of this.listSessions()) {
      await this.stop(summary.id, "shutdown");
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Event bridge — every normalized event is emitted locally and published on
  // the platform event bus as `cli.<event.type>` for SSE/telemetry consumers.
  // -------------------------------------------------------------------------

  private emitEvent(event: CliEvent): void {
    this.emit("event", event);
    try {
      this.bus?.publish({
        type: `cli.${event.type}`,
        data: event,
        source: "cli-manager",
        ...(event.taskId !== undefined ? { metadata: { taskId: event.taskId } } : {}),
      });
    } catch {
      // Event bridge is best-effort — never breaks task execution.
    }
  }
}
