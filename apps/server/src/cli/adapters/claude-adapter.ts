// ============================================================================
// Finance Agent OS — Claude Code CLI Adapter
// Docs: https://code.claude.com/docs/en/cli-reference
//       https://docs.anthropic.com/en/docs/claude-code/headless
//
// Headless protocol (verified against official docs):
//   claude -p <prompt> --output-format stream-json --verbose
// Stdout is NDJSON: assistant messages (content blocks), `result` (final),
// `stream_event` partials (with --include-partial-messages), system/init.
// Tool use arrives as content blocks {type:"tool_use",name,input}.
// Auth is reused from the local Claude Code setup (subscription / API key);
// credentials are never copied — the child inherits the user environment.
// ============================================================================

import type { CliStreamChunk, CliValidationResult } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export const CLAUDE_DEFAULT_ARGS = [
  "-p",
  "{prompt}",
  "--output-format",
  "stream-json",
  "--verbose",
] as const;

interface ClaudeContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  delta?: unknown;
}

/** Extract text/tool calls from a Claude Code content-block array. */
function chunksFromBlocks(blocks: unknown): CliStreamChunk[] {
  if (!Array.isArray(blocks)) return [];
  const out: CliStreamChunk[] = [];
  for (const raw of blocks) {
    const block = raw as ClaudeContentBlock;
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && typeof block.name === "string" && block.name.length > 0) {
      const args = block.input;
      out.push({
        type: "tool_call",
        name: block.name,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      });
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      out.push({ type: "delta", content: block.text });
      continue;
    }
    // Partial-message deltas: {type:"...", delta:{text_delta|input_json_delta}}.
    const delta = block.delta as { text_delta?: { text?: unknown } } | undefined;
    const partial = delta?.text_delta?.text;
    if (typeof partial === "string" && partial.length > 0) {
      out.push({ type: "delta", content: partial });
    }
  }
  return out;
}

/**
 * Parse one Claude Code `--output-format stream-json` NDJSON line.
 * Unknown / version-drifted shapes return `[]` (plain text fallback) —
 * never throw, never misreport capabilities.
 */
export function parseClaudeStreamLine(line: string): CliStreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  let event: {
    type?: unknown;
    message?: { content?: unknown };
    result?: unknown;
    event?: { delta?: unknown };
  };
  try {
    event = JSON.parse(trimmed) as typeof event;
  } catch {
    return [];
  }
  // Final result: {type:"result", result:"..."}.
  if (event.type === "result") {
    return typeof event.result === "string" && event.result.length > 0
      ? [{ type: "delta", content: event.result }]
      : [];
  }
  // Assistant message with content blocks.
  if (event.message && typeof event.message === "object") {
    return chunksFromBlocks(event.message.content);
  }
  // Partial streaming wrapper: {type:"stream_event", event:{delta:{...}}}.
  if (event.type === "stream_event" && event.event && typeof event.event === "object") {
    return chunksFromBlocks([event.event]);
  }
  return [];
}

export class ClaudeAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "claude",
      name: "Claude Code",
      description: "Anthropic Claude Code CLI (headless print mode)",
      executable: "claude",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: [...CLAUDE_DEFAULT_ARGS],
      engineAliases: ["claude", "claude-code", "claude-cli"],
      installHint: "npm install -g @anthropic-ai/claude-code",
      authHint: "Run `claude` once interactively to sign in, or set ANTHROPIC_API_KEY.",
      // One-shot only: `--resume` reuses server-side session state but every
      // task is still a short-lived process (no multiplexed connection).
      sessionModes: ["one-shot"],
    });
  }

  protected override envVar(): string | undefined {
    return "CLAUDE_CLI_PATH";
  }

  /**
   * Insert `--model <model>` / `--agent <agentId>` after `-p` (only when set
   * and not already present). Prompt itself stays a single argv element.
   */
  override decorateTaskArgs(
    args: string[],
    ctx: { model?: string; agentId?: string },
  ): string[] {
    const next = [...args];
    const anchor = next.indexOf("-p");
    const at = anchor === -1 ? next.length : anchor + 1;
    const agent = ctx.agentId?.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (agent && !next.includes("--agent")) {
      next.splice(at, 0, "--agent", agent);
    }
    if (
      ctx.model !== undefined &&
      ctx.model !== "" &&
      ctx.model !== "default" &&
      !next.includes("--model")
    ) {
      next.splice(at, 0, "--model", ctx.model);
    }
    return next;
  }

  override parseLine(line: string): CliStreamChunk | null {
    const chunks = parseClaudeStreamLine(line);
    if (chunks.length === 0) return super.parseLine(line);
    // The manager consumes one chunk per line; merge text deltas so no
    // content is lost, and prefer surfacing tool calls.
    const tool = chunks.find((chunk) => chunk.type === "tool_call");
    if (tool) return tool;
    const text = chunks
      .filter((chunk) => chunk.type === "delta")
      .map((chunk) => (chunk as { content: string }).content)
      .join("");
    return text.length > 0 ? { type: "delta", content: text } : super.parseLine(line);
  }

  /** Persistent sessions resume via `--resume`; capability only, no daemon. */
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
export function createClaudeAdapter(): ClaudeAdapter {
  return new ClaudeAdapter();
}

/** Alias kept for backward compatibility with pre-merge provider work. */
export const createClaudeCodeAdapter = createClaudeAdapter;
export type ClaudeCodeAdapter = ClaudeAdapter;
