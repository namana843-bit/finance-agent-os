// ============================================================================
// Finance Agent OS — Cline CLI Adapter (PRIMARY agent CLI)
// The ONLY place that knows how Cline is executed:
//   • executable discovery (CLINE_CLI_PATH + cross-platform candidates)
//   • one-shot argv (`cline --json [--model <id>] <prompt>`)
//   • stdout protocol parsing (NDJSON: {type:"say",text} → delta; tolerant)
// The core runtime, CLI manager and desktop UI never import this file except
// through the adapter registration layer (cli/index.ts).
//
// Authentication is reused from the local CLI (`cline auth`) — credentials
// are never copied into argv, env, or logs. Deliberately one-shot only:
// persistent/core-instance modes are out of scope until the gRPC surface is
// verified live, so they are NOT advertised as supported.
// Flags per https://docs.cline.bot/cli (`cline --help` is source of truth).
// ============================================================================

import type { CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";
import {
  CLINE_ALLOWED_COMMANDS,
  CLINE_DEFAULT_RUN_ARGS,
  clineCandidatePaths,
  probeClineVersion,
} from "./cline-paths.js";

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
