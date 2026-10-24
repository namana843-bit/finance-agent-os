// ============================================================================
// Finance Agent OS — Coding Agent Workspace: sessions
//
// One coding conversation = one provider + one project + one CLI session.
// Switching provider or project always creates (or selects) a different
// record, so contexts can never silently merge.
//
// Every turn is recorded with its structured events so the desktop UI can
// replay history after a restart without re-running the provider.
// ============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../atomic.js";
import type { CliEvent, CliManager, CliSessionMode } from "../cli/index.js";
import type { CodingProjectStore } from "./projects.js";
import type { CodingProviderRegistry } from "./providers.js";
import {
  createSessionWorktree,
  removeSessionWorktree,
  type SessionWorktree,
} from "./worktrees.js";
import {
  CODING_SESSION_MAX_TURNS,
  CODING_TURN_MAX_CHARS,
  type CodingSessionRecord,
  type CodingSessionStatus,
  type CodingTurn,
  type CodingTurnEvent,
  deriveSessionTitle,
} from "./types.js";

/** Simple async queue so a CLI event stream can feed a request loop. */
class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *drain(): AsyncIterable<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

interface PersistedSessionFile {
  version: 1;
  sessions: CodingSessionRecord[];
}

export class CodingSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodingSessionError";
  }
}

export interface CreateSessionInput {
  providerId: string;
  projectId: string;
  model?: string;
  mode?: CliSessionMode;
  title?: string;
  /** Run in a dedicated git worktree instead of the project working tree. */
  isolate?: boolean;
}

export interface CodingSessionManagerOptions {
  cli: CliManager;
  providers: CodingProviderRegistry;
  projects: CodingProjectStore;
  /** Absolute path of the sessions JSON file. Omit for in-memory only. */
  storagePath?: string;
  /** Default timeout for a turn; the CLI layer clamps further. */
  defaultTimeoutMs?: number;
  /** Root directory for isolated session worktrees. */
  worktreeRoot?: string;
}

export class CodingSessionManager {
  private sessions = new Map<string, CodingSessionRecord>();
  private running = new Map<string, AbortController>();
  private loaded = false;

  constructor(private readonly opts: CodingSessionManagerOptions) {}

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const path = this.opts.storagePath;
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedSessionFile>;
      if (!Array.isArray(parsed.sessions)) return;
      for (const record of parsed.sessions) {
        if (
          record
          && typeof record.id === "string"
          && typeof record.providerId === "string"
          && typeof record.projectPath === "string"
        ) {
          // A process from a previous run is gone; never restore "running".
          this.sessions.set(record.id, {
            ...record,
            status: record.status === "running" ? "idle" : record.status,
          });
        }
      }
    } catch {
      // Corrupt history must not break the server.
    }
  }

  private persist(): void {
    const path = this.opts.storagePath;
    if (!path) return;
    const payload: PersistedSessionFile = { version: 1, sessions: [...this.sessions.values()] };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Persistence is best effort; the in-memory record remains authoritative.
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(filter: { providerId?: string; projectId?: string } = {}): CodingSessionRecord[] {
    this.load();
    return [...this.sessions.values()]
      .filter((session) => !filter.providerId || session.providerId === filter.providerId)
      .filter((session) => !filter.projectId || session.projectId === filter.projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): CodingSessionRecord | undefined {
    this.load();
    return this.sessions.get(id);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<CodingSessionRecord> {
    this.load();
    const descriptor = await this.opts.providers.describe(input.providerId);
    if (!descriptor) {
      throw new CodingSessionError("unknown_provider", `unknown coding provider '${input.providerId}'`);
    }
    if (!descriptor.status.installed) {
      throw new CodingSessionError(
        "provider_not_installed",
        `${descriptor.name} is not installed or not on PATH${descriptor.installHint ? ` — ${descriptor.installHint}` : ""}`,
      );
    }
    const project = this.opts.projects.get(input.projectId);
    if (!project) {
      throw new CodingSessionError("unknown_project", `unknown project '${input.projectId}'`);
    }
    const mode: CliSessionMode = input.mode ?? "one-shot";
    if (mode === "persistent" && !descriptor.capabilities.persistent_session.supported) {
      throw new CodingSessionError(
        "unsupported_capability",
        `${descriptor.name} does not support persistent sessions`,
      );
    }

    // Parallel agents must never share a working tree. A session that does not
    // ask for isolation is refused while another session on the same project
    // is running, instead of racing it on disk.
    if (!input.isolate) {
      const busy = this.list({ projectId: project.id }).find((entry) => entry.status === "running");
      if (busy) {
        throw new CodingSessionError(
          "project_busy",
          `session ${busy.id} is already running in this project; start an isolated worktree session to run concurrently`,
        );
      }
    }

    const sessionId = `cs-${randomUUID().slice(0, 8)}`;
    let worktree: SessionWorktree | undefined;
    if (input.isolate) {
      const rootDir = this.opts.worktreeRoot;
      if (!rootDir) {
        throw new CodingSessionError(
          "isolation_unavailable",
          "isolated worktrees are not configured on this server",
        );
      }
      const created = await createSessionWorktree({
        projectPath: project.path,
        sessionId,
        rootDir,
      });
      if (!created.ok) {
        throw new CodingSessionError("isolation_unavailable", created.error);
      }
      worktree = created.worktree;
    }

    let cliSessionId: string;
    try {
      const session = await this.opts.cli.start(input.providerId, {
        cwd: worktree ? worktree.path : project.path,
        ...(mode !== "one-shot" ? { mode } : {}),
      });
      cliSessionId = session.id;
    } catch (err) {
      if (worktree) {
        await removeSessionWorktree({
          projectPath: project.path,
          worktreePath: worktree.path,
          branch: worktree.branch,
          force: true,
        }).catch(() => undefined);
      }
      throw new CodingSessionError(
        "session_start_failed",
        err instanceof Error ? err.message : String(err),
      );
    }

    const now = Date.now();
    const record: CodingSessionRecord = {
      id: sessionId,
      providerId: input.providerId,
      cliSessionId,
      projectId: project.id,
      projectPath: project.path,
      status: "idle",
      title: input.title?.slice(0, 120) || "New session",
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    if (input.model) record.model = input.model;
    if (worktree) {
      record.isolated = true;
      record.worktreePath = worktree.path;
      record.worktreeBranch = worktree.branch;
    }
    this.sessions.set(record.id, record);
    this.persist();
    this.opts.projects.touch(project.id);
    return record;
  }

  /**
   * Run one turn. Yields structured events as they arrive and resolves the
   * final assistant turn through `result()`.
   *
   * `lastTurn()` returns the assistant turn after the generator completes.
   */
  async *streamTurn(
    sessionId: string,
    text: string,
    opts: { model?: string; timeoutMs?: number } = {},
  ): AsyncGenerator<CodingTurnEvent, CodingTurn, void> {
    this.load();
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new CodingSessionError("invalid_turn", "turn text is required");
    }
    if (text.length > CODING_TURN_MAX_CHARS) {
      throw new CodingSessionError("invalid_turn", `turn text allows at most ${CODING_TURN_MAX_CHARS} characters`);
    }
    const record = this.sessions.get(sessionId);
    if (!record) throw new CodingSessionError("unknown_session", `unknown coding session '${sessionId}'`);
    if (record.status === "running") {
      throw new CodingSessionError("session_busy", "this session already has a running turn");
    }
    if (record.status === "closed" || !record.cliSessionId) {
      throw new CodingSessionError("session_closed", "this session is closed; start a new one");
    }

    const cliSession = this.opts.cli.getSession(record.cliSessionId);
    if (!cliSession) {
      throw new CodingSessionError(
        "session_expired",
        "the underlying CLI session no longer exists; start a new session",
      );
    }
    if (cliSession.isStopped || cliSession.status === "failed") {
      throw new CodingSessionError("session_expired", `the underlying CLI session is ${cliSession.status}`);
    }

    const startedAt = Date.now();
    const userTurn: CodingTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      role: "user",
      content: text,
      createdAt: startedAt,
    };
    record.turns.push(userTurn);
    if (record.turns.length === 1) record.title = deriveSessionTitle(text);
    record.status = "running";
    record.updatedAt = startedAt;
    delete record.error;
    this.persist();

    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const queue = new AsyncEventQueue<CliEvent>();
    const stopEvents = this.attachEvents(record.cliSessionId, queue);

    const assistantTurn: CodingTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      events: [],
    };
    let fatalError: string | undefined;
    let cancelled = false;
    let exitCode: number | null = null;

    try {
      // The CLI task runs while the event stream feeds this generator.
      const taskPromise = this.opts.cli
        .sendTask(record.cliSessionId, {
          task: text,
          ...(opts.model ?? record.model ? { model: opts.model ?? record.model } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          signal: controller.signal,
        })
        .then((result) => ({ kind: "task" as const, result }))
        .catch((err: unknown) => ({ kind: "error" as const, error: err }));

      const eventIter = queue.drain()[Symbol.asyncIterator]();
      /** Yield events already buffered before the task settled. */
      const drainRemaining = async function* (
        self: CodingSessionManager,
      ): AsyncGenerator<CodingTurnEvent, void, void> {
        for (;;) {
          const drained = await eventIter.next();
          if (drained.done) break;
          const mapped = self.mapEvent(record, drained.value);
          if (mapped) yield mapped;
        }
      };
      let finished = false;
      while (!finished) {
        const next = await Promise.race([
          eventIter.next().then((value) => ({ kind: "event" as const, value })),
          taskPromise,
        ]);
        if (next.kind === "error") {
          queue.close();
          for await (const mapped of drainRemaining(this)) {
            assistantTurn.events?.push(mapped);
            this.applyText(assistantTurn, mapped);
            yield mapped;
          }
          throw next.error;
        }
        if (next.kind === "task") {
          // Surface any events already queued before the task resolved.
          queue.close();
          for await (const mapped of drainRemaining(this)) {
            assistantTurn.events?.push(mapped);
            this.applyText(assistantTurn, mapped);
            yield mapped;
            if (mapped.type === "error" && mapped.fatal) fatalError = mapped.message;
            if (mapped.type === "exit") exitCode = mapped.exitCode;
          }
          const result = next.result;
          if (!result.ok) {
            fatalError = fatalError ?? result.error ?? `provider exited with code ${result.exitCode ?? "unknown"}`;
            cancelled = result.cancelled;
          }
          if (result.cancelled) cancelled = true;
          if (result.output && assistantTurn.content.length === 0) {
            assistantTurn.content = result.output;
            const delta: CodingTurnEvent = { type: "text", content: result.output };
            assistantTurn.events?.push(delta);
            yield delta;
          }
          if (result.exitCode !== null && exitCode === null) {
            exitCode = result.exitCode;
            const exitEvent: CodingTurnEvent = {
              type: "exit",
              exitCode: result.exitCode,
              durationMs: result.durationMs,
            };
            assistantTurn.events?.push(exitEvent);
            yield exitEvent;
          }
          finished = true;
          break;
        }
        const event = next.value;
        if (event.done) break;
        const mapped = this.mapEvent(record, event.value);
        if (!mapped) continue;
        assistantTurn.events?.push(mapped);
        this.applyText(assistantTurn, mapped);
        if (mapped.type === "error" && mapped.fatal) fatalError = mapped.message;
        if (mapped.type === "exit") exitCode = mapped.exitCode;
        yield mapped;
      }
      void taskPromise;
    } catch (err) {
      fatalError = err instanceof Error ? err.message : String(err);
      const errorEvent: CodingTurnEvent = { type: "error", message: fatalError, fatal: true };
      assistantTurn.events?.push(errorEvent);
      yield errorEvent;
    } finally {
      stopEvents();
      queue.close();
      this.running.delete(sessionId);
    }

    assistantTurn.durationMs = Date.now() - startedAt;
    if (cancelled) assistantTurn.cancelled = true;
    record.turns.push(assistantTurn);
    if (record.turns.length > CODING_SESSION_MAX_TURNS) {
      record.turns = record.turns.slice(-CODING_SESSION_MAX_TURNS);
    }
    const nextStatus: CodingSessionStatus = cancelled
      ? "cancelled"
      : fatalError
        ? "failed"
        : "idle";
    record.status = nextStatus;
    record.updatedAt = Date.now();
    if (fatalError) record.error = fatalError;
    else delete record.error;
    this.persist();

    if (fatalError && !cancelled) {
      throw new CodingSessionError("turn_failed", fatalError);
    }
    return assistantTurn;
  }

  /** Cancel the running turn for one session. Never throws. */
  async cancel(sessionId: string): Promise<CodingSessionRecord | undefined> {
    this.load();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    this.running.get(sessionId)?.abort();
    if (record.cliSessionId) {
      try {
        await this.opts.cli.stop(record.cliSessionId, "cancelled by user");
      } catch {
        // Process may already be gone.
      }
    }
    record.status = "cancelled";
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  /** Close a session and release its process. */
  async close(sessionId: string): Promise<CodingSessionRecord | undefined> {
    this.load();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    if (record.cliSessionId) {
      try {
        await this.opts.cli.stop(record.cliSessionId, "session closed");
      } catch {
        // Already stopped.
      }
    }
    record.status = "closed";
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  /** Close every session (server shutdown). */
  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.close(id);
    }
  }

  /**
   * Remove the isolated worktree of a session. Requires `force` because git
   * refuses to drop a worktree that still holds uncommitted changes.
   */
  async removeWorktree(sessionId: string, force = false): Promise<CodingSessionRecord | undefined> {
    this.load();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    if (!record.isolated || !record.worktreePath) {
      throw new CodingSessionError("not_isolated", "this session does not run in an isolated worktree");
    }
    if (record.status === "running") {
      throw new CodingSessionError("session_busy", "stop the running turn before removing its worktree");
    }
    const removed = await removeSessionWorktree({
      projectPath: record.projectPath,
      worktreePath: record.worktreePath,
      ...(record.worktreeBranch ? { branch: record.worktreeBranch } : {}),
      force,
    });
    if (!removed.ok) {
      throw new CodingSessionError("worktree_remove_failed", removed.error ?? "could not remove the worktree");
    }
    delete record.worktreePath;
    delete record.worktreeBranch;
    delete record.isolated;
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private attachEvents(cliSessionId: string, queue: AsyncEventQueue<CliEvent>): () => void {
    let closed = false;
    const iterate = async () => {
      try {
        for await (const event of this.opts.cli.streamEvents(cliSessionId)) {
          if (closed) return;
          queue.push(event);
        }
      } catch {
        // Session ended; the task result carries the outcome.
      } finally {
        if (!closed) queue.close();
      }
    };
    void iterate();
    return () => {
      closed = true;
    };
  }

  /** Translate a CLI event into a workspace turn event (null = not surfaced). */
  private mapEvent(record: CodingSessionRecord, event: CliEvent): CodingTurnEvent | null {
    if (event.sessionId !== record.cliSessionId && event.sessionId !== undefined) {
      // Events from another session must never leak into this history.
      return null;
    }
    switch (event.type) {
      case "text_delta":
        return event.content.length > 0 ? { type: "text", content: event.content } : null;
      case "output":
        return event.chunk.length > 0 ? { type: "terminal", stream: event.stream, chunk: event.chunk } : null;
      case "tool_activity":
        return { type: "tool", name: event.name, arguments: event.arguments };
      case "status_changed":
        return { type: "status", status: event.status, ...(event.reason ? { reason: event.reason } : {}) };
      case "error":
        return { type: "error", message: event.message, fatal: event.fatal };
      case "session_finished":
        return { type: "exit", exitCode: event.exitCode, durationMs: event.durationMs };
      case "session_failed":
        return {
          type: "error",
          message: event.error || (event.cancelled ? "cancelled" : "provider failed"),
          fatal: !event.cancelled,
        };
      default:
        return null;
    }
  }

  private applyText(turn: CodingTurn, event: CodingTurnEvent): void {
    if (event.type !== "text") return;
    if (turn.content.length >= CODING_TURN_MAX_CHARS) return;
    turn.content += event.content;
  }
}
