// ============================================================================
// Finance Agent OS — CLI stdout protocol parsing helpers
// Extracted from the duplicated JSON-line probes that previously lived in
// llm/cli-session.ts and llm/providers/cli-engine.ts. Adapters own their
// protocol; this module provides the shared JSON-lines implementation.
// ============================================================================

import type { CliStreamChunk } from "./types.js";

/**
 * Parse one stdout line produced by JSON-line agent CLIs:
 *   {"tool_call":{"name":"...","arguments":{...}}}
 *   {"delta":"..."} | {"content":"..."} | {"text":"..."}
 * Returns `null` when the line is not a protocol line — the caller then treats
 * it as plain text (`line + "\n"`).
 */
export function parseJsonLineChunk(line: string): CliStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      tool_call?: { name?: unknown; arguments?: unknown };
      delta?: unknown;
      content?: unknown;
      text?: unknown;
    };
    const toolCall = parsed.tool_call;
    if (toolCall && typeof toolCall.name === "string" && toolCall.name.length > 0) {
      const args = toolCall.arguments;
      return {
        type: "tool_call",
        name: toolCall.name,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      };
    }
    const delta = parsed.delta ?? parsed.content ?? parsed.text;
    if (typeof delta === "string") {
      return { type: "delta", content: delta };
    }
  } catch {
    // Malformed JSON is treated as plain text by the caller.
  }
  return null;
}

/** Split an accumulated stdout buffer into complete lines and the remainder. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
