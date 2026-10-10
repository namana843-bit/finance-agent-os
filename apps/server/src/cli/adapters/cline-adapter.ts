// ============================================================================
// Finance Agent OS — Cline CLI Adapter
// Docs: https://github.com/cline/cline/blob/main/apps/cli/README.md
//       https://github.com/cline/cline/blob/main/cli/man/cline.1.md
//       https://docs.cline.bot/usage/cli-overview
//
// Headless protocol (verified against official docs + man page):
//   cline --json "<prompt>" [-m model] [-c cwd] [-T taskId]
// `--json` streams NDJSON messages: {type:"ask"|"say", text, ts, ...}.
// `say` carries assistant text; `ask` carries approval/tool requests, which
// surface as normalized tool calls (name "ask", subtype in arguments).
// Auth: `cline auth <provider>` (OAuth/API key) is reused from local setup;
// credentials are never copied. Non-interactive runs fail fast with an
// actionable auth message when no credentials exist.
// ============================================================================

import type { CliStreamChunk, CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export const CLINE_DEFAULT_ARGS = ["--json", "{prompt}"] as const;

/**
 * Parse one `cline --json` NDJSON line. `say` text becomes a delta;
 * `ask` becomes a tool call (approval-gated work). Unknown shapes return
 * `[]` (plain-text fallback) — never throw.
 */
export function parseClineJsonLine(line: string): CliStreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  let message: {
    type?: unknown;
    text?: unknown;
    ask?: unknown;
    say?: unknown;
  };
  try {
    message = JSON.parse(trimmed) as typeof message;
  } catch {
    return [];
  }
  if (message.type === "say") {
    return typeof message.text === "string" && message.text.length > 0
      ? [{ type: "delta", content: message.text }]
      : [];
  }
  if (message.type === "ask") {
    const subtype =
      typeof message.ask === "string"
        ? message.ask
        : typeof message.say === "string"
          ? message.say
          : "unknown";
    return [
      {
        type: "tool_call",
        name: "ask",
        arguments: {
          ask_type: subtype,
          ...(typeof message.text === "string" ? { text: message.text } : {}),
        },
      },
    ];
  }
  return [];
}

export class ClineCliAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "cline-cli",
      name: "Cline CLI",
      description: "Cline CLI (headless JSON mode)",
      executable: "cline",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...CLINE_DEFAULT_ARGS],
      engineAliases: ["cline", "cline-code"],
      installHint: "npm install -g cline",
      authHint:
        "Run `cline auth <provider>` once to sign in; headless runs fail fast without saved credentials.",
      // One-shot only: every task is a short-lived `cline --json` process
      // (`-T` resumes server-side task state, not a live connection).
      sessionModes: ["one-shot"],
    });
  }

  protected override envVar(): string | undefined {
    return "CLINE_CLI_PATH";
  }

  /** Insert `-m <model>` before the prompt (only when set and absent). */
  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    void ctx.agentId;
    const next = [...args];
    if (
      ctx.model !== undefined &&
      ctx.model !== "" &&
      ctx.model !== "default" &&
      !next.includes("-m") &&
      !next.includes("--model")
    ) {
      const at = next.indexOf("{prompt}");
      next.splice(at === -1 ? next.length : at, 0, "-m", ctx.model);
    }
    return next;
  }

  override parseLine(line: string): CliStreamChunk | null {
    const chunks = parseClineJsonLine(line);
    if (chunks.length === 0) return super.parseLine(line);
    const tool = chunks.find((chunk) => chunk.type === "tool_call");
    if (tool) return tool;
    const text = chunks
      .filter((chunk) => chunk.type === "delta")
      .map((chunk) => (chunk as { content: string }).content)
      .join("");
    return text.length > 0 ? { type: "delta", content: text } : super.parseLine(line);
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

export function createClineCliAdapter(): ClineCliAdapter {
  return new ClineCliAdapter();
}
