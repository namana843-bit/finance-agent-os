// ============================================================================
// Finance Agent OS — Cline CLI Adapter (PRIMARY agent CLI)
// The ONLY place that knows how Cline is executed:
//   • executable discovery (CLINE_CLI_PATH + cross-platform candidates)
//   • one-shot argv (`cline --json [--model <id>] <prompt>`)
//   • stdout protocol parsing (NDJSON: {type:"say",text} → delta; tolerant)
// The core runtime, CLI manager and desktop UI never import this file except
// through the adapter registration layer (cli/index.ts).
//
// Two classes share this module (merged history):
//   • ClineAdapter     (id "cline")     — primary adapter, rich validation
//     via cline-paths.ts, gateway allowlist.
//   • ClineCliAdapter  (id "cline-cli") — metadata-driven variant kept for
//     backward compatibility with existing providers/tests.
// Both are one-shot only: persistent/core-instance modes are out of scope
// until the gRPC surface is verified live, so they are NOT advertised.
//
// Authentication is reused from the local CLI (`cline auth`) — credentials
// are never copied into argv, env, or logs.
// Flags per https://docs.cline.bot/cli (`cline --help` is source of truth).
// Docs: https://github.com/cline/cline/blob/main/apps/cli/README.md
//       https://github.com/cline/cline/blob/main/cli/man/cline.1.md
//       https://docs.cline.bot/usage/cli-overview
//
// Headless protocol:
//   cline --json "<prompt>" [-m model] [-c cwd] [-T taskId]
// `--json` streams NDJSON messages: {type:"ask"|"say", text, ts, ...}.
// `say` carries assistant text; `ask` carries approval/tool requests, which
// surface as normalized tool calls (name "ask", subtype in arguments).
// Non-interactive runs fail fast with an actionable auth message when no
// credentials exist.
// ============================================================================

import type { CliStreamChunk, CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import {
  CLINE_ALLOWED_COMMANDS,
  CLINE_DEFAULT_RUN_ARGS,
  clineCandidatePaths,
  probeClineVersion,
} from "./cline-paths.js";

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

export class ClineAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "cline",
      name: "Cline",
      description: "Cline AI coding agent CLI (primary agent engine)",
      executable: "cline",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...CLINE_DEFAULT_RUN_ARGS],
      engineAliases: ["cline", "cline-cli"],
      installHint: "npm install -g cline, then run `cline auth`",
      sessionModes: ["one-shot"],
    });
  }

  /** Commands allowed through the permissioned gateway. */
  static allowedCommands(): string[] {
    return [...CLINE_ALLOWED_COMMANDS];
  }

  protected override extraCandidates(): string[] {
    return clineCandidatePaths();
  }

  protected override envVar(): string | undefined {
    return "CLINE_CLI_PATH";
  }

  /**
   * Insert `-m <model>` when a non-default model is set (only once, and
   * never with an empty value). Mirrors the documented
   * `cline -m <model-id> "<prompt>"` shape.
   */
  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    const next = [...args];
    if (
      ctx.model !== undefined &&
      ctx.model !== "" &&
      ctx.model !== "default" &&
      !next.includes("-m") &&
      !next.includes("--model")
    ) {
      next.splice(next.length - 1, 0, "-m", ctx.model);
    }
    return next;
  }

  /** Cline streams NDJSON (`{type,text}`) under `--json`; tolerant fallback. */
  override parseLine(line: string): ReturnType<CliAdapterBase["parseLine"]> {
    const direct = super.parseLine(line);
    if (direct) return direct;
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown; say?: unknown };
        const text =
          typeof parsed.text === "string"
            ? parsed.text
            : typeof parsed.say === "string"
              ? parsed.say
              : null;
        if (text !== null) return { type: "delta", content: text };
      } catch {
        // Malformed JSON → plain text (handled by caller).
      }
    }
    return null;
  }

  /** Rich validation: resolver candidates + `--version` via PATH fallback. */
  override async validateInstallation(): Promise<CliValidationResult> {
    const meta = this.getMetadata();
    const resolved = await this.resolveExecutable();
    const version = await probeClineVersion(resolved ?? meta.executable, 2500);
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
export function createClineAdapter(): ClineAdapter {
  return new ClineAdapter();
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
