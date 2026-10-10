// ============================================================================
// Finance Agent OS — Gemini CLI Adapter
// argv one-shot (`-p <prompt>`). No model flag in Phase A; verify
// `gemini --help` before adding model/agent flags.
// ============================================================================

import type { CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import { autoResolveCliPath } from "../resolver.js";

export class GeminiAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "gemini",
      name: "Gemini",
      description: "Google Gemini CLI",
      executable: "gemini",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["-p", "{prompt}"],
      engineAliases: ["gemini", "gemini-cli", "google-gemini"],
    });
  }

  protected override envVar(): string | undefined {
    return "GEMINI_CLI_PATH";
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
        error: `Executable '${meta.executable}' not found (install the CLI)`,
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

export function createGeminiAdapter(): GeminiAdapter {
  return new GeminiAdapter();
}
