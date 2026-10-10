// ============================================================================
// Finance Agent OS — Claude Code CLI Adapter
// argv one-shot (`-p <prompt>`), optional `--model` only when a model is set.
// No daemon/server mode — persistent sessions are out of scope for Phase A.
// Flags per catalog (`llm/engines.ts`); verify against `claude --help`
// before changing argv shape.
// ============================================================================

import type { CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import { autoResolveCliPath } from "../resolver.js";

export class ClaudeAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "claude",
      name: "Claude Code",
      description: "Anthropic Claude Code CLI",
      executable: "claude",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["-p", "{prompt}"],
      engineAliases: ["claude", "claude-code", "claude-cli"],
      installHint: "npm install -g @anthropic-ai/claude-code",
    });
  }

  protected override envVar(): string | undefined {
    return "CLAUDE_CLI_PATH";
  }

  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    if (ctx.model !== undefined && ctx.model !== "" && ctx.model !== "default") {
      return [...args, "--model", ctx.model];
    }
    return [...args];
  }

  override async validateInstallation(): Promise<CliValidationResult> {
    const meta = this.getMetadata();
    const resolved = await autoResolveCliPath(meta.executable, { envVar: this.envVar() });
    if (!resolved) {
      return {
        adapterId: meta.id,
        ok: false,
        executable: meta.executable,
        resolvedPath: null,
        version: null,
        error: `Executable '${meta.executable}' not found (${meta.installHint ?? "install the CLI"})`,
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
}

export function createClaudeAdapter(): ClaudeAdapter {
  return new ClaudeAdapter();
}
