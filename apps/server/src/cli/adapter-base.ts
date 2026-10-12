// ============================================================================
// Finance Agent OS — CLI Adapter base class
// Provides the default (and legacy-compatible) behaviour shared by adapters:
// argv templating, JSON-line parsing, path resolution, version probing and
// declarative shell policy. Adapters override only what their CLI differs on.
// ============================================================================

import { execFile } from "node:child_process";
import type {
  CliAdapter,
  CliDaemonController,
  CliMetadata,
  CliSessionMode,
  CliStreamChunk,
  CliTaskDelivery,
  CliValidationResult,
  ProtocolTransport,
} from "./types.js";
import { parseJsonLineChunk } from "./parsing.js";
import { autoResolveCliPath } from "./resolver.js";

/**
 * Legacy-compatible one-shot argv builder:
 *  - templates containing `{model}` are dropped (model is only meaningful for
 *    persistent/daemon-backed sessions)
 *  - `{prompt}` is substituted with the task text
 * Adapters with different transports (stdin/rpc) override `buildOneShotArgs`.
 */
export function defaultOneShotArgs(templates: string[], task: string): string[] {
  const out: string[] = [];
  for (const template of templates) {
    if (template.includes("{model}")) continue;
    out.push(template.split("{prompt}").join(task));
  }
  return out;
}

/**
 * Shared shell policy: Windows OS wrappers (.cmd/.bat/.ps1) require a shell;
 * everything else spawns directly. Single source of truth — process runners
 * and session managers must call this instead of re-implementing the check.
 */
export function requiresShellForExecutable(executable: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(executable);
}

export abstract class CliAdapterBase implements CliAdapter {
  private readonly metadata: CliMetadata;

  constructor(metadata: CliMetadata) {
    this.metadata = metadata;
  }

  getMetadata(): CliMetadata {
    return {
      ...this.metadata,
      defaultArgs: [...this.metadata.defaultArgs],
      engineAliases: [...this.metadata.engineAliases],
      sessionModes: [...(this.metadata.sessionModes ?? (["one-shot"] as CliSessionMode[]))],
    };
  }

  /** Session modes this adapter supports (default: one-shot only). */
  supportsMode(mode: CliSessionMode): boolean {
    return (this.metadata.sessionModes ?? (["one-shot"] as CliSessionMode[])).includes(mode);
  }

  /** Match by adapter id, executable name or resolved path. */
  matchesExecutable(command: string, resolvedPath?: string | null): boolean {
    const meta = this.metadata;
    const needles = [meta.id, meta.executable, ...meta.engineAliases].filter(
      (needle) => needle.length > 0,
    );
    const haystacks = [command, resolvedPath ?? ""];
    return needles.some((needle) =>
      haystacks.some((haystack) => haystack.length > 0 && haystack.includes(needle)),
    );
  }

  /** Default: no adapter-specific flags. */
  decorateTaskArgs(args: string[], _ctx: { model?: string; agentId?: string }): string[] {
    return args;
  }

  /**
   * Legacy-compatible one-shot argv building:
   *  - templates containing `{model}` are dropped (model is only meaningful
   *    for persistent/daemon-backed sessions)
   *  - `{prompt}` is substituted with the task text
   * Adapters with different transports override this method.
   */
  buildOneShotArgs(
    templates: string[],
    task: string,
    _ctx: { daemonUrl: string | null },
  ): string[] {
    return defaultOneShotArgs(templates, task);
  }

  /** Default: no daemon-attach flags. */
  decorateDaemonArgs(args: string[], _daemonUrl: string): string[] {
    return args;
  }

  parseLine(line: string): CliStreamChunk | null {
    return parseJsonLineChunk(line);
  }

  getTaskDelivery(): CliTaskDelivery {
    return this.metadata.taskDelivery;
  }

  /** Only daemon-owned adapters can run persistent sessions. */
  supportsDaemonMode(daemonUrl: string | null): boolean {
    return daemonUrl !== null && daemonUrl.length > 0 && this.daemon !== undefined;
  }

  buildSessionArgs(opts?: { model?: string; agentId?: string }): string[] {
    // Legacy-compatible: `{model}` placeholders are filled from the resolved
    // model (may be ""), then adapter-specific flags are inserted.
    const model = opts?.model ?? "";
    const withModel = this.metadata.defaultArgs.map((arg) =>
      arg.split("{model}").join(model),
    );
    return this.decorateTaskArgs(withModel, opts ?? {});
  }

  buildEnv(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra ?? {}) };
  }

  /** Windows OS wrappers need a shell; everything else spawns directly. */
  requiresShell(executable: string): boolean {
    return requiresShellForExecutable(executable);
  }

  async resolveExecutable(command?: string): Promise<string | null> {
    return autoResolveCliPath(command ?? this.metadata.executable, {
      extraCandidates: this.extraCandidates(),
      envVar: this.envVar(),
    });
  }

  async validateInstallation(): Promise<CliValidationResult> {
    const meta = this.metadata;
    const resolved = await this.resolveExecutable();
    if (!resolved) {
      return {
        adapterId: meta.id,
        ok: false,
        executable: meta.executable,
        resolvedPath: null,
        version: null,
        error: `Executable '${meta.executable}' not found (PATH, env override, or adapter candidates)`,
        checkedAt: Date.now(),
      };
    }
    const version = await this.probeVersion(resolved);
    return {
      adapterId: meta.id,
      ok: true,
      executable: meta.executable,
      resolvedPath: resolved,
      version,
      checkedAt: Date.now(),
    };
  }

  /** Adapter-specific executable candidates (checked before OS fallbacks). */
  protected extraCandidates(): string[] {
    return [];
  }

  /** Adapter-specific env override variable name. */
  protected envVar(): string | undefined {
    return undefined;
  }

  /** Probe `--version`; never throws. */
  protected probeVersion(
    executable: string,
    args: string[] = ["--version"],
    timeoutMs = 2500,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      execFile(
        executable,
        args,
        { timeout: timeoutMs, windowsHide: true, shell: this.requiresShell(executable) },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const first = String(stdout ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
          resolve(first ?? null);
        },
      );
    });
  }

  /** Optional daemon / server-mode owner — undefined for one-shot CLIs. */
  readonly daemon?: CliDaemonController;

  /**
   * Optional framed transport for persistent-mode sessions. One-shot
   * argv/stdin adapters inherit `undefined` — they are never forced into a
   * protocol. The manager calls this only for `persistent`-mode sessions.
   */
  createTransport?(_session: { sessionId: string; adapterId: string }): ProtocolTransport | null;
}
