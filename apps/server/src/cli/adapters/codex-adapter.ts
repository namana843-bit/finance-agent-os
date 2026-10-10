// ============================================================================
// Finance Agent OS — OpenAI Codex CLI Adapter
// argv one-shot (`exec <prompt>`). No model flag in Phase A — codex model
// selection is config-driven; verify `codex exec --help` before adding flags.
// ============================================================================

import type { CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import { autoResolveCliPath } from "../resolver.js";

export class CodexAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "codex",
      name: "Codex",
      description: "OpenAI Codex CLI",
      executable: "codex",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["exec", "{prompt}"],
      engineAliases: ["codex", "codex-cli", "openai-codex"],
      installHint: "npm install -g @openai/codex",
    });
  }

  protected override envVar(): string | undefined {
    return "CODEX_CLI_PATH";
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

export function createCodexAdapter(): CodexAdapter {
  return new CodexAdapter();
}
