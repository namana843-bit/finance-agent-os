// ============================================================================
// Finance Agent OS — Generic CLI Adapter Layer: shared types
// The core runtime + desktop UI only ever see these normalized shapes.
// CLI-specific protocol knowledge (paths, flags, parsers, daemons) lives
// inside each adapter implementation under cli/adapters/.
// ============================================================================

/** Normalized lifecycle state for a managed CLI session. */
export type CliSessionState = "starting" | "ready" | "busy" | "stopped" | "failed";

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
  error?: string;
}

export interface CliSessionSummary {
  id: string;
  adapterId: string;
  status: CliSessionState;
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
      type: "output";
      stream: "stdout" | "stderr";
      chunk: string;
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
}
