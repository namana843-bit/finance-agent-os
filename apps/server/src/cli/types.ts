// ============================================================================
// Finance Agent OS — Generic CLI Adapter Layer: shared types
// The core runtime + desktop UI only ever see these normalized shapes.
// CLI-specific protocol knowledge (paths, flags, parsers, daemons) lives
// inside each adapter implementation under cli/adapters/.
// ============================================================================

/** Normalized lifecycle state for a managed CLI session. */
export type CliSessionState = "starting" | "ready" | "busy" | "stopped" | "failed";

/** How a managed session executes tasks. */
export type CliSessionMode = "one-shot" | "persistent";

/** One-shot: each task spawns a short-lived process. Persistent: tasks are
 * multiplexed over a long-lived connection owned by the adapter (e.g. a
 * daemon). Adapters declare what they support; the manager dispatches. */
export const CLI_SESSION_MODES: readonly CliSessionMode[] = ["one-shot", "persistent"] as const;

/** How a task reaches the CLI process — not every CLI reads stdin. */
export type CliTaskDelivery = "argv" | "stdin" | "rpc";

/** Adapter metadata surfaced through the backend (never hard-coded in the UI). */
export interface CliMetadata {
  id: string;
  name: string;
  description: string;
  /** Executable name resolved through PATH / adapter-specific discovery. */
  executable: string;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  taskDelivery: CliTaskDelivery;
  /** Default argv template used when a session has no explicit args. */
  defaultArgs: string[];
  /** Engine ids this adapter serves (engines.json ids / agent engine ids). */
  engineAliases: string[];
  /** Optional install hint shown by the desktop UI. */
  installHint?: string;
  /** Actionable auth guidance when the CLI reports missing credentials. */
  authHint?: string;
  /**
   * Session modes this adapter supports. Defaults to `["one-shot"]` when
   * absent (backward compatible). Adapters with a daemon / persistent
   * transport declare `["one-shot", "persistent"]`.
   */
  sessionModes?: CliSessionMode[];
}

export interface CliToolActivity {
  name: string;
  arguments: Record<string, unknown>;
}

/** One parsed stdout protocol chunk. `null` means "plain text line". */
export type CliStreamChunk =
  | { type: "delta"; content: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> };

export interface CliValidationResult {
  adapterId: string;
  ok: boolean;
  executable: string;
  resolvedPath: string | null;
  version: string | null;
  error?: string;
  checkedAt: number;
}

export interface CliStartOptions {
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
  timeoutMs?: number;
}

export interface CliTaskRequest {
  task: string;
  model?: string;
  agentId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface CliTaskResult {
  ok: boolean;
  sessionId: string;
  adapterId: string;
  taskId: string;
  output: string;
  toolActivities: CliToolActivity[];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** True when `output` was truncated at the session output limit. */
  outputTruncated?: boolean;
  error?: string;
}

export interface CliSessionSummary {
  id: string;
  adapterId: string;
  status: CliSessionState;
  /** Session execution mode negotiated at start (default: "one-shot"). */
  mode: CliSessionMode;
  command: string;
  cwd?: string;
  createdAt: number;
  lastActivityAt: number;
  tasks: number;
  runningTask: boolean;
}

// ---------------------------------------------------------------------------
// Normalized event model — produced by every adapter/session
// ---------------------------------------------------------------------------

interface CliEventBase {
  sessionId: string;
  adapterId: string;
  taskId?: string;
  timestamp: number;
}

export type CliEvent =
  | (CliEventBase & {
      type: "session_started";
      command: string;
      args: string[];
      cwd?: string;
    })
  | (CliEventBase & {
      type: "task_started";
      /** Session execution mode for this task. */
      mode: CliSessionMode;
    })
  | (CliEventBase & {
      type: "output";
      stream: "stdout" | "stderr";
      chunk: string;
    })
  | (CliEventBase & {
      /** One parsed text delta (JSON-line `delta`/`content`/`text` chunk). */
      type: "text_delta";
      content: string;
    })
  | (CliEventBase & {
      type: "tool_activity";
      name: string;
      arguments: Record<string, unknown>;
    })
  | (CliEventBase & {
      type: "status_changed";
      status: CliSessionState;
      reason?: string;
    })
  | (CliEventBase & {
      type: "error";
      message: string;
      fatal: boolean;
    })
  | (CliEventBase & {
      type: "session_finished";
      exitCode: number | null;
      durationMs: number;
    })
  | (CliEventBase & {
      type: "session_failed";
      error: string;
      exitCode: number | null;
      timedOut: boolean;
      cancelled: boolean;
      durationMs: number;
    });

/** Optional daemon / server-mode controller (e.g. `opencode serve`). */
export interface CliDaemonController {
  start(): Promise<void>;
  stop(): void;
  getUrl(): string | null;
  isRunning(): boolean;
}

/**
 * Hooks consumed by the LLM session manager + CLI provider so that
 * CLI-specific decisions never leak into the core streaming code.
 */
export interface CliAdapterHooks {
  /** Does this adapter own `command` (id, executable name or resolved path)? */
  matchesExecutable(command: string, resolvedPath?: string | null): boolean;
  /** Insert adapter-specific task flags (model/agent) into an argv template. */
  decorateTaskArgs(args: string[], ctx: { model?: string; agentId?: string }): string[];
  /** Build one-shot argv: `{prompt}` substitution + transport-specific flags. */
  buildOneShotArgs(
    templates: string[],
    task: string,
    ctx: { daemonUrl: string | null },
  ): string[];
  /** Extra flags when attaching to a daemon / server-mode process. */
  decorateDaemonArgs(args: string[], daemonUrl: string): string[];
  /** Parse one stdout line into a streaming chunk (null = plain text). */
  parseLine(line: string): CliStreamChunk | null;
  /** Transport this adapter speaks (`argv` default). Callers must honor it:
   *  `stdin` tasks travel via stdin, `rpc` requires an RPC transport and must
   *  fail explicitly when none is implemented. */
  getTaskDelivery?(): CliTaskDelivery;
  /** Can this adapter keep a persistent session against `daemonUrl`? */
  supportsDaemonMode(daemonUrl: string | null): boolean;
}

/** Contract every CLI integration must implement. */
export interface CliAdapter extends CliAdapterHooks {
  getMetadata(): CliMetadata;
  /** Validate installation: executable present + optional version probe. */
  validateInstallation(): Promise<CliValidationResult>;
  /** Resolve the executable to an absolute path when possible. */
  resolveExecutable(command?: string): Promise<string | null>;
  /** Base argv for a managed session (before per-task prompt substitution). */
  buildSessionArgs(opts?: { model?: string; agentId?: string }): string[];
  /** Explicit environment overrides for spawned processes. */
  buildEnv(extra?: Record<string, string>): Record<string, string>;
  /** Optional default working directory (e.g. custom CLI descriptor). */
  defaultCwd?(): string | undefined;
  /**
   * Some CLIs ship OS wrappers (.cmd/.bat/.ps1) that require a shell on
   * Windows. Adapters declare this explicitly so the process runner never
   * guesses — and never routes user task input through a shell command string.
   */
  requiresShell(executable: string): boolean;
  /** Optional daemon / server-mode lifecycle owner. */
  readonly daemon?: CliDaemonController;
  /**
   * Optional framed transport for `rpc`-delivery adapters (persistent mode).
   * `argv`/`stdin` adapters leave this undefined — no CLI is forced into one
   * protocol. The manager uses it only when the session runs in
   * `persistent` mode.
   */
  createTransport?(session: { sessionId: string; adapterId: string }): ProtocolTransport | null;
}

// ---------------------------------------------------------------------------
// Environment policy + spawn limits (centralized in process-runner / manager)
// ---------------------------------------------------------------------------

/**
 * Environment variable names that session/adapters must never override.
 * The process runner drops these keys (case-insensitively on Windows) from
 * per-session overrides — the child always inherits the server's own values.
 */
export const CLI_DENIED_ENV_KEYS: readonly string[] = [
  "PATH",
  "PATHEXT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "COMSPEC",
  "SYSTEMROOT",
] as const;

/** Keys whose values are secrets — redacted from logs and error strings. */
export const CLI_SECRET_ENV_PATTERN = /api[_-]?key|secret|token|password|credential/i;

/** Replace secret-looking values with `[REDACTED]` for logging. */
export function redactCliEnvForLog(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = CLI_SECRET_ENV_PATTERN.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

/** Central spawn/output limits. */
export interface CliSpawnLimits {
  /** Hard per-process timeout (ms). */
  timeoutMs: number;
  /** Max buffered stdout+stderr bytes kept per process. */
  maxBufferBytes: number;
  /** Max accumulated task output characters surfaced to callers. */
  maxOutputChars: number;
}

export const DEFAULT_CLI_SPAWN_LIMITS: CliSpawnLimits = {
  timeoutMs: 300_000,
  maxBufferBytes: 4 * 1024 * 1024,
  maxOutputChars: 256_000,
};

// ---------------------------------------------------------------------------
// Protocol transport abstraction (opt-in, for persistent/rpc adapters only)
// ---------------------------------------------------------------------------

/** Framed message handler for a persistent CLI connection. */
export type ProtocolMessageHandler = (message: unknown) => void;

/**
 * Minimal transport for CLIs that speak a structured protocol over a
 * long-lived connection (daemon socket, stdio JSON-RPC, …). Plain
 * argv/stdin CLIs never implement this — the one-shot process path in
 * `process-runner.ts` remains their only transport.
 */
export interface ProtocolTransport {
  /** Transport kind for diagnostics (e.g. "jsonrpc-stdio", "daemon-socket"). */
  readonly kind: string;
  /** True while the underlying connection is usable. */
  isConnected(): boolean;
  /** Send one framed message. Queued or throws when disconnected. */
  send(message: unknown): void;
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(handler: ProtocolMessageHandler): () => void;
  /** Close the connection and release resources. Idempotent. */
  close(): void;
}
