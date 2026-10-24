// ============================================================================
// Finance Agent OS — Coding Agent Workspace: provider contract
//
// A *coding provider* is one independently installed coding agent (OpenCode,
// Claude Code, Gemini CLI, Codex, …) presented through a single shape the
// desktop workspace can render. Providers are built on top of the generic CLI
// adapter layer (`src/cli`) — this module adds the coding-specific concerns:
// capability discovery, honest status, model enumeration, project scoping.
//
// Rules encoded here:
//   1. Capabilities are explicit. A provider that cannot do something returns
//      `{ supported: false, reason }` — never a silent no-op.
//   2. Status is *observed*, never assumed. `installed` comes from an actual
//      executable probe; `auth` stays "unknown" when nothing can be verified.
//   3. No credential value ever appears in a descriptor. Only a verdict.
// ============================================================================

/** Everything a coding workspace may need from a provider. */
export type CodingCapabilityId =
  | "install_detection"
  | "version_probe"
  | "auth_check"
  | "model_selection"
  | "streaming"
  | "cancellation"
  | "session_resume"
  | "persistent_session"
  | "tool_events"
  | "permission_requests"
  | "file_diffs"
  | "terminal_output";

export const CODING_CAPABILITY_IDS: readonly CodingCapabilityId[] = [
  "install_detection",
  "version_probe",
  "auth_check",
  "model_selection",
  "streaming",
  "cancellation",
  "session_resume",
  "persistent_session",
  "tool_events",
  "permission_requests",
  "file_diffs",
  "terminal_output",
] as const;

/** A capability is on or off — and when off it must say why. */
export type Capability =
  | { supported: true }
  | { supported: false; reason: string };

export type CodingAuthState = "unknown" | "authenticated" | "unauthenticated";

export interface CodingProviderStatus {
  /** True only after an executable probe actually succeeded. */
  installed: boolean;
  /** Reported version string when the provider exposes one, else null. */
  version: string | null;
  /** Verdict only. Never a token, key, or credential value. */
  auth: CodingAuthState;
  /** Absolute path of the resolved executable, or null when unresolved. */
  resolvedPath: string | null;
  /** Human-readable failure from the last probe (sanitized upstream). */
  error?: string;
  checkedAt: number;
}

export interface CodingProviderDescriptor {
  providerId: string;
  name: string;
  description: string;
  /** Executable name as declared by the adapter (not a resolved path). */
  executable: string;
  /** Backing CLI adapter id, so callers can reconnect sessions later. */
  adapterId: string;
  status: CodingProviderStatus;
  capabilities: Record<CodingCapabilityId, Capability>;
  installHint?: string;
  /** Actionable guidance when `status.auth` is "unauthenticated". */
  authHint?: string;
}

export interface CodingModel {
  id: string;
  label: string;
  providerId: string;
}

/** Result of an operation a provider may not support at all. */
export type CapabilityResult<T> =
  | { supported: true; value: T }
  | { supported: false; reason: string };

export function unsupported<T = never>(reason: string): CapabilityResult<T> {
  return { supported: false, reason };
}

export function supported<T>(value: T): CapabilityResult<T> {
  return { supported: true, value };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface CodingProjectGit {
  isRepo: boolean;
  branch?: string;
  /** True when the working tree has uncommitted changes (best effort). */
  dirty?: boolean;
}

export interface CodingProject {
  id: string;
  name: string;
  /** Absolute, normalized path. Never a relative or traversing path. */
  path: string;
  createdAt: number;
  lastOpenedAt: number;
  git?: CodingProjectGit;
}

export type ProjectPathErrorCode =
  | "not_absolute"
  | "too_long"
  | "traversal"
  | "missing"
  | "not_a_directory"
  | "blocked_location"
  | "outside_allowed_root";

export type ProjectPathValidation =
  | { ok: true; path: string }
  | { ok: false; code: ProjectPathErrorCode; error: string };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type CodingSessionStatus =
  | "idle"
  | "running"
  | "cancelled"
  | "failed"
  | "closed";

/**
 * One coding conversation. The provider/session/project triple is carried on
 * every session so switching providers in the UI can never merge contexts.
 */
export interface CodingSessionRecord {
  id: string;
  providerId: string;
  /** Underlying CLI session id at the adapter layer. */
  cliSessionId: string | null;
  projectId: string;
  projectPath: string;
  model?: string;
  status: CodingSessionStatus;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: CodingTurn[];
  /** Provider-reported continuation token (resume), when supported. */
  resumeToken?: string;
  /**
   * When true the session runs in its own git worktree, so two sessions on the
   * same project never share (and overwrite) one working tree.
   */
  isolated?: boolean;
  /** Absolute path of the isolated worktree, when `isolated` is true. */
  worktreePath?: string;
  /** Branch checked out in the isolated worktree. */
  worktreeBranch?: string;
  error?: string;
}

export interface CodingTurn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  /** Structured events observed while producing this turn. */
  events?: CodingTurnEvent[];
  cancelled?: boolean;
  durationMs?: number;
}

export type CodingTurnEvent =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; arguments: Record<string, unknown> }
  | { type: "terminal"; stream: "stdout" | "stderr"; chunk: string }
  | { type: "status"; status: string; reason?: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "exit"; exitCode: number | null; durationMs: number };

/** A permission request the user must answer before work continues. */
export interface CodingPermissionRequest {
  id: string;
  sessionId: string;
  providerId: string;
  kind: "file_write" | "file_delete" | "command" | "install" | "deploy" | "unknown";
  /** Human-readable action ("write package.json", "run pnpm install"). */
  summary: string;
  /** Structured detail for the UI; never contains secrets. */
  detail?: Record<string, unknown>;
  createdAt: number;
  status: "pending" | "approved" | "denied";
  decidedAt?: number;
}

export const CODING_SESSION_MAX_TURNS = 500;
export const CODING_TURN_MAX_CHARS = 200_000;
export const CODING_TITLE_MAX_CHARS = 120;

/** Build a session title from the first user message (no secrets, no markup). */
export function deriveSessionTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length === 0) return "New session";
  return collapsed.length > CODING_TITLE_MAX_CHARS
    ? `${collapsed.slice(0, CODING_TITLE_MAX_CHARS - 1)}…`
    : collapsed;
}
