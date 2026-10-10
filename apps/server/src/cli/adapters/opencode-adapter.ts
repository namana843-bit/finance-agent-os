// ============================================================================
// Finance Agent OS — OpenCode CLI Adapter
// The ONLY place that knows how OpenCode is executed:
//   • executable discovery (OPENCODE_CLI_PATH + cross-platform candidates)
//   • one-shot argv (`run --auto {prompt}`, `--agent/--model` flags)
//   • daemon/server mode (`opencode serve`, `--attach`, `--pure`)
//   • stdout protocol parsing (JSON-lines: tool_call / delta)
// The core runtime, CLI manager and desktop UI never import this file except
// through the adapter registration layer (cli/index.ts).
// ============================================================================

import type {
  CliDaemonController,
  CliMetadata,
  CliStreamChunk,
  CliValidationResult,
} from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import {
  OPENCODE_ALLOWED_COMMANDS,
  OPENCODE_DEFAULT_RUN_ARGS,
  insertOpencodeDaemonAttach,
  opencodeCandidatePaths,
  probeOpencodeVersion,
} from "./opencode-paths.js";
import { OpencodeDaemonManager } from "./opencode-daemon.js";

export class OpenCodeAdapter extends CliAdapterBase {
  /** Daemon/server-mode owner (`opencode serve`) — process + protocol specific. */
  readonly daemon: CliDaemonController = new OpencodeDaemonManager();

  constructor() {
    super({
      id: "opencode",
      name: "OpenCode",
      description: "AI coding agent CLI",
      executable: "opencode",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...OPENCODE_DEFAULT_RUN_ARGS],
      engineAliases: ["opencode", "opencode-cli"],
      installHint: "npm install -g opencode-ai",
    });
  }

  /** Commands allowed through the permissioned gateway. */
  static allowedCommands(): string[] {
    return [...OPENCODE_ALLOWED_COMMANDS];
  }

  protected override extraCandidates(): string[] {
    return opencodeCandidatePaths();
  }

  protected override envVar(): string | undefined {
    return "OPENCODE_CLI_PATH";
  }

  /**
   * Legacy behaviour: insert `--agent <agentId> --model <model>` after `run`
   * (only when the agent name is non-empty and no `--agent` flag is present).
   */
  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    const next = [...args];
    const runIndex = next.indexOf("run");
    const agent = ctx.agentId?.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (runIndex !== -1 && agent && !next.includes("--agent")) {
      const flags = ["--agent", agent];
      if (
        ctx.model !== undefined &&
        ctx.model !== "" &&
        ctx.model !== "default"
      ) {
        flags.push("--model", ctx.model);
      }
      next.splice(runIndex + 1, 0, ...flags);
    }
    return next;
  }

  /**
   * Legacy one-shot ordering: `run --attach <url> --pure --auto <prompt>`
   * when a daemon is running, otherwise the plain template.
   */
  override buildOneShotArgs(
    templates: string[],
    task: string,
    ctx: { daemonUrl: string | null },
  ): string[] {
    const out: string[] = [];
    for (const template of templates) {
      if (template.includes("{model}")) continue;
      out.push(template.split("{prompt}").join(task));
      if (template === "run" && ctx.daemonUrl) {
        out.push("--attach", ctx.daemonUrl, "--pure");
      }
    }
    return out;
  }

  /** Persistent (daemon-connected) sessions: `run --attach <url> …`. */
  override decorateDaemonArgs(args: string[], daemonUrl: string): string[] {
    return insertOpencodeDaemonAttach(args, daemonUrl);
  }

  /** OpenCode streams JSON-lines (`tool_call` / `delta`). */
  override parseLine(line: string): CliStreamChunk | null {
    return super.parseLine(line);
  }

  /** Rich validation: resolver candidates + `--version` (incl. `npx` fallback). */
  override async validateInstallation(): Promise<CliValidationResult> {
    const meta = this.getMetadata();
    const resolved = await this.resolveExecutable();
    const version = await probeOpencodeVersion(
      resolved ?? meta.executable,
      2500,
    );
    const ok = resolved !== null || version !== null;
    return {
      adapterId: meta.id,
      ok,
      executable: meta.executable,
      resolvedPath: resolved,
      version,
      ...(ok
        ? {}
        : {
            error: `Executable '${meta.executable}' not found (${meta.installHint ?? "install the CLI"})`,
          }),
      checkedAt: Date.now(),
    };
  }
}

/** Convenience singleton-free factory used by the registration layer. */
export function createOpenCodeAdapter(): OpenCodeAdapter {
  return new OpenCodeAdapter();
}
