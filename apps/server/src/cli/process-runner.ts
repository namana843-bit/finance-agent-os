// ============================================================================
// Finance Agent OS — CLI Process Runner
// The only module in the platform that spawns agent CLI processes.
//
// Safety model (preserved from the original OpenCode gateway/session code):
//   • direct process spawning — no shell parsing of user task input
//   • `shell: true` ONLY when an adapter explicitly declares an OS wrapper
//     (.cmd/.bat/.ps1 on Windows); task text always travels as argv/stdin data
//   • explicit env merge (`process.env` + adapter/session overrides)
//   • hard timeout + AbortSignal cancellation with process-tree cleanup
//   • bounded in-memory output buffers
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { CLI_DENIED_ENV_KEYS } from "./types.js";

export interface CliProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Adapter-declared shell requirement — never derived from user input. */
  shell?: boolean;
  timeoutMs?: number;
  /** Payload for CLIs that read the task from stdin (taskDelivery: "stdin"). */
  stdinPayload?: string;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface CliProcessHandlers {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onSpawn?: (pid: number | undefined) => void;
}

export interface CliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  durationMs: number;
  /** True when stdout/stderr were truncated at `maxBufferBytes`. */
  truncated?: boolean;
}

/** Drop denied env keys from per-session overrides (case-insensitive). */
export function filterEnvOverrides(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  const denied = new Set(CLI_DENIED_ENV_KEYS.map((key) => key.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (denied.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Kill a process and its children (Windows: taskkill /T; POSIX: SIGTERM→SIGKILL). */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      });
      killer.unref();
      return;
    } catch {
      // fall through to plain kill
    }
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  const grace = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 1_500);
  grace.unref?.();
}

function appendBounded(buffer: string, chunk: string, maxBytes: number): { text: string; truncated: boolean } {
  const next = buffer + chunk;
  if (next.length <= maxBytes) return { text: next, truncated: false };
  return { text: next.slice(next.length - maxBytes), truncated: true };
}

/**
 * Run a CLI process to completion, streaming stdout/stderr chunks to handlers.
 * Never rejects — failures are reported in the result (spawnError/exitCode).
 */
export function runCliProcess(
  spec: CliProcessSpec,
  handlers: CliProcessHandlers = {},
): Promise<CliProcessResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = spec.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const started = Date.now();

  return new Promise<CliProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let truncated = false;

    let child: ChildProcess;
    try {
      const overrides = filterEnvOverrides(spec.env);
      const env =
        overrides && Object.keys(overrides).length > 0
          ? { ...process.env, ...overrides }
          : undefined;
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        shell: spec.shell === true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        spawnError: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      });
      return;
    }

    handlers.onSpawn?.(child.pid);

    const settle = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        cancelled,
        spawnError,
        durationMs: Date.now() - started,
        ...(truncated ? { truncated: true as const } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killProcessTree(child);
    };
    if (spec.signal) {
      if (spec.signal.aborted) onAbort();
      else spec.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const next = appendBounded(stdout, text, maxBuffer);
      stdout = next.text;
      truncated = truncated || next.truncated;
      handlers.onStdoutChunk?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const next = appendBounded(stderr, text, maxBuffer);
      stderr = next.text;
      truncated = truncated || next.truncated;
      handlers.onStderrChunk?.(text);
    });

    child.on("error", (err) => {
      settle(null, err.message);
    });

    child.on("close", (code) => {
      settle(code ?? null);
    });

    try {
      if (spec.stdinPayload !== undefined) {
        child.stdin?.write(spec.stdinPayload);
      }
      child.stdin?.end();
    } catch {
      // stdin closed by the CLI — not fatal
    }

    // If cancellation raced the spawn, make sure we still terminate.
    if (cancelled) killProcessTree(child);
  });
}
