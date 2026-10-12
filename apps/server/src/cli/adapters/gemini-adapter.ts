// ============================================================================
// Finance Agent OS — Gemini CLI Adapter
// Docs: https://geminicli.com/docs/cli/headless
//       https://github.com/google-gemini/gemini-cli (packages/cli/src/config)
//
// Headless protocol (verified against official docs + yargs source):
//   gemini -p <prompt> --output-format stream-json [-m model]
// Stdout is JSONL: init, message (user/assistant chunks), tool_use,
// tool_result, error, result (final outcome + stats). Exit codes: 0 ok,
// 1 general/API failure, 42 input error, 53 turn limit exceeded.
// Auth is reused from the local Gemini setup (Google sign-in / API key);
// credentials are never copied.
// ============================================================================

import type { CliStreamChunk, CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export const GEMINI_DEFAULT_ARGS = ["-p", "{prompt}", "--output-format", "stream-json"] as const;

interface GeminiToolUse {
  name?: unknown;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
}

/**
 * Parse one `gemini --output-format stream-json` JSONL line. Unknown event
 * shapes return `[]` (plain-text fallback) — never throw.
 */
export function parseGeminiStreamLine(line: string): CliStreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  let event: {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    message?: unknown;
    response?: unknown;
    name?: unknown;
    args?: unknown;
    arguments?: unknown;
    input?: unknown;
  };
  try {
    event = JSON.parse(trimmed) as typeof event;
  } catch {
    return [];
  }
  if (typeof event.type !== "string") {
    // Tolerate bare payloads that still carry text.
    return typeof event.text === "string" && event.text.length > 0
      ? [{ type: "delta", content: event.text }]
      : [];
  }
  switch (event.type) {
    case "message": {
      const text =
        typeof event.text === "string"
          ? event.text
          : typeof event.content === "string"
            ? event.content
            : typeof event.message === "string"
              ? event.message
              : null;
      return text && text.length > 0 ? [{ type: "delta", content: text }] : [];
    }
    case "tool_use": {
      const tool = event as GeminiToolUse & { type: unknown };
      if (typeof tool.name !== "string" || tool.name.length === 0) return [];
      const args = tool.args ?? tool.arguments ?? tool.input;
      return [
        {
          type: "tool_call",
          name: tool.name,
          arguments:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        },
      ];
    }
    case "result": {
      // Final outcome: {type:"result", response:"...", stats:{...}}.
      return typeof event.response === "string" && event.response.length > 0
        ? [{ type: "delta", content: event.response }]
        : [];
    }
    default:
      // init / tool_result / error carry no new assistant content — the exit
      // code and stderr surface failures. error text stays visible as text.
      return [];
  }
}

export class GeminiAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "gemini",
      name: "Gemini",
      description: "Google Gemini CLI (headless prompt mode)",
      executable: "gemini",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...GEMINI_DEFAULT_ARGS],
      engineAliases: ["gemini", "gemini-cli", "google-gemini"],
      installHint: "npm install -g @google/gemini-cli",
      authHint:
        "Run `gemini` once interactively to sign in with Google, or set GEMINI_API_KEY.",
      // One-shot only: every task is a short-lived `gemini -p` process.
      sessionModes: ["one-shot"],
    });
  }

  protected override envVar(): string | undefined {
    return "GEMINI_CLI_PATH";
  }

  /** Insert `-m <model>` after `-p` (only when set and absent). */
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
      const at = next.indexOf("-p");
      next.splice(at === -1 ? next.length : at + 1, 0, "-m", ctx.model);
    }
    return next;
  }

  override parseLine(line: string): CliStreamChunk | null {
    const chunks = parseGeminiStreamLine(line);
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

/** Convenience singleton-free factory used by the registration layer. */
export function createGeminiAdapter(): GeminiAdapter {
  return new GeminiAdapter();
}

/** Alias kept for backward compatibility with pre-merge provider work. */
export const createGeminiCliAdapter = createGeminiAdapter;
export type GeminiCliAdapter = GeminiAdapter;
