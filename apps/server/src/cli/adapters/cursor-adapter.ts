// ============================================================================
// Finance Agent OS — Cursor CLI Adapter
// Docs: https://cursor.com/docs/cli/overview, https://cursor.com/docs/cli/using
//
// Headless protocol (verified against official docs):
//   agent -p <prompt> [--output-format text] [--model <model>] [--mode ...]
// Print mode emits plain text (no structured JSON stream is documented —
// streaming/tool-events are NOT claimed). Sessions can resume
// (`--resume`/`--continue`) but every task is a short-lived process.
// Persistent ACP: `agent acp` runs Cursor as an ACP server over stdio
// (documented in "Using Agent in CLI"). The shared framing lives in
// `acp-transport.ts`; wiring it into managed persistent sessions is planned,
// not yet done — this adapter stays one-shot until the handshake is
// verified against a live binary.
// Auth is reused from the local Cursor sign-in; credentials are never copied.
// ============================================================================

import type { CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export const CURSOR_DEFAULT_ARGS = ["-p", "{prompt}", "--output-format", "text"] as const;

export class CursorCliAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "cursor-cli",
      name: "Cursor CLI",
      description: "Cursor CLI agent (non-interactive print mode)",
      executable: "agent",
      // Raw text streams to stdout, but no structured streaming protocol is
      // documented — report streaming as unsupported to avoid over-claiming.
      supportsStreaming: false,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...CURSOR_DEFAULT_ARGS],
      engineAliases: ["cursor", "cursor-agent", "cursor-cli"],
      installHint: "curl https://cursor.com/install -fsS | bash",
      authHint: "Run `agent` once interactively to sign in to Cursor.",
      // One-shot only. Persistent ACP (`agent acp`) is planned once the
      // shared acp-transport handshake is verified against a live binary.
      sessionModes: ["one-shot"],
    });
  }

  protected override envVar(): string | undefined {
    return "CURSOR_AGENT_CLI_PATH";
  }

  /**
   * Insert `--model <model>` / `--mode <agentId>` after `-p` (only when set
   * and absent). The prompt stays a single argv element.
   */
  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    const next = [...args];
    const anchor = next.indexOf("-p");
    const at = anchor === -1 ? next.length : anchor + 1;
    if (
      ctx.model !== undefined &&
      ctx.model !== "" &&
      ctx.model !== "default" &&
      !next.includes("--model")
    ) {
      next.splice(at, 0, "--model", ctx.model);
    }
    const mode = ctx.agentId?.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (mode && !next.includes("--mode")) {
      next.splice(at, 0, "--mode", mode);
    }
    return next;
  }

  override supportsDaemonMode(_daemonUrl: string | null): boolean {
    return false;
  }

  override async validateInstallation(): Promise<CliValidationResult> {
    const base = await super.validateInstallation();
    if (!base.ok && base.error) {
      return { ...base, error: `${base.error}. ${this.getMetadata().authHint ?? ""}`.trim() };
    }
    return base;
  }
}

export function createCursorCliAdapter(): CursorCliAdapter {
  return new CursorCliAdapter();
}
