// ============================================================================
// Finance Agent OS — OpenAI Codex CLI Adapter
// Docs: https://developers.openai.com/codex/noninteractive
//       https://developers.openai.com/codex/cli/reference
//
// Headless protocol (verified against official docs):
//   codex exec --json --sandbox workspace-write [-m model] [-C dir] <prompt>
// Stdout is JSONL: thread.started, turn.started, item.* (agent_message,
// reasoning, command_execution, file_change, mcp_tool_call, web_search),
// turn.completed / turn.failed, error.
// Auth is reused from the local Codex setup (ChatGPT sign-in, CODEX_API_KEY
// or ~/.codex/auth.json); credentials are never copied.
// ============================================================================

import type { CliStreamChunk, CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export const CODEX_DEFAULT_ARGS = ["exec", "--json", "{prompt}"] as const;

interface CodexItem {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  command?: unknown;
  path?: unknown;
  arguments?: unknown;
  call?: unknown;
}

/** Map one Codex item payload to normalized chunks (tolerant of drift). */
function chunksFromItem(item: unknown): CliStreamChunk[] {
  if (!item || typeof item !== "object") return [];
  const entry = item as CodexItem;
  const kind = entry.type;
  if (typeof kind !== "string") {
    // agent_message shapes without an explicit type still carry text.
    return typeof entry.text === "string" && entry.text.length > 0
      ? [{ type: "delta", content: entry.text }]
      : [];
  }
  switch (kind) {
    case "agent_message":
      return typeof entry.text === "string" && entry.text.length > 0
        ? [{ type: "delta", content: entry.text }]
        : [];
    case "reasoning":
      return typeof entry.text === "string" && entry.text.length > 0
        ? [{ type: "delta", content: entry.text }]
        : [];
    case "command_execution":
      return typeof entry.command === "string" && entry.command.length > 0
        ? [{ type: "tool_call", name: "command_execution", arguments: { command: entry.command } }]
        : [];
    case "file_change":
      return typeof entry.path === "string" && entry.path.length > 0
        ? [{ type: "tool_call", name: "file_change", arguments: { path: entry.path } }]
        : [];
    case "mcp_tool_call":
      return typeof entry.name === "string" && entry.name.length > 0
        ? [
            {
              type: "tool_call",
              name: `mcp.${entry.name}`,
              arguments:
                entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
                  ? (entry.arguments as Record<string, unknown>)
                  : {},
            },
          ]
        : [];
    case "web_search":
      return [{ type: "tool_call", name: "web_search", arguments: {} }];
    default:
      return [];
  }
}

/**
 * Parse one `codex exec --json` JSONL line. Unknown event shapes return `[]`
 * (the caller falls back to plain text) — never throw.
 */
export function parseCodexJsonLine(line: string): CliStreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  let event: { type?: unknown; item?: unknown; message?: unknown; error?: unknown };
  try {
    event = JSON.parse(trimmed) as typeof event;
  } catch {
    return [];
  }
  if (typeof event.type !== "string") return [];
  if (event.type.startsWith("item.")) {
    return chunksFromItem(event.item);
  }
  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : null;
    return message ? [{ type: "delta", content: message }] : [];
  }
  // thread.started / turn.started / turn.completed / turn.failed carry no
  // user-visible content — completion status comes from the exit code.
  return [];
}

export class CodexAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "codex",
      name: "Codex",
      description: "OpenAI Codex CLI (non-interactive exec mode)",
      executable: "codex",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...CODEX_DEFAULT_ARGS],
      engineAliases: ["codex", "codex-cli", "openai-codex"],
      installHint: "npm install -g @openai/codex",
      authHint:
        "Run `codex` once interactively to sign in, or set CODEX_API_KEY. " +
        "Existing ~/.codex/auth.json credentials are reused automatically.",
      // One-shot only: `exec resume` reuses server-side threads but every
      // task is still a short-lived process (no multiplexed connection).
      sessionModes: ["one-shot"],
    });
  }

  protected override envVar(): string | undefined {
    return "CODEX_CLI_PATH";
  }

  /**
   * Insert `-m <model>` after `exec` (only when set and absent). The prompt
   * stays the final argv element; sandbox policy is left to user config
   * (automation should pass explicit args via the session template).
   */
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
      const at = next.indexOf("exec");
      next.splice(at === -1 ? next.length : at + 1, 0, "-m", ctx.model);
    }
    return next;
  }

  override parseLine(line: string): CliStreamChunk | null {
    const chunks = parseCodexJsonLine(line);
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
export function createCodexAdapter(): CodexAdapter {
  return new CodexAdapter();
}

/** Alias kept for backward compatibility with pre-merge provider work. */
export const createCodexCliAdapter = createCodexAdapter;
export type CodexCliAdapter = CodexAdapter;
