// ============================================================================
// Finance Agent OS — CLI Adapter Layer (public entry point)
//
//   Desktop UI / Runtime → CliManager → CliAdapter → ClineAdapter | …
// (OpenCodeAdapter is retained as a deprecated fallback.)
//
// This is the ONLY module allowed to know which concrete adapters exist.
// Everything else depends on the CliAdapter interface + CliManager API.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import { CliManager } from "./cli-manager.js";
import { ClineAdapter, createClineAdapter } from "./adapters/cline-adapter.js";
import { OpenCodeAdapter, createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
import { ClaudeAdapter, createClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter, createCodexAdapter } from "./adapters/codex-adapter.js";
import { GeminiAdapter, createGeminiAdapter } from "./adapters/gemini-adapter.js";
import { createCursorCliAdapter } from "./adapters/cursor-adapter.js";
import { createClineCliAdapter } from "./adapters/cline-adapter.js";

export * from "./types.js";
export {
  autoResolveCliPath,
  resolveCliExecutable,
  clearCliPathCache,
  cliPathEnvOverride,
} from "./resolver.js";
export type { CliPathResolution, ResolveCliPathOptions } from "./resolver.js";
export { parseJsonLineChunk, splitLines } from "./parsing.js";
export { runCliProcess, killProcessTree, filterEnvOverrides } from "./process-runner.js";
export type {
  CliProcessSpec,
  CliProcessHandlers,
  CliProcessResult,
} from "./process-runner.js";
export { CliAdapterBase, defaultOneShotArgs, requiresShellForExecutable } from "./adapter-base.js";
export { CliManager, CliManagedSession } from "./cli-manager.js";
export type { CliManagerOptions } from "./cli-manager.js";
export { JsonLineTransport } from "./protocol-transport.js";
export type { JsonLineTransportStreams } from "./protocol-transport.js";
export { ClineAdapter, createClineAdapter } from "./adapters/cline-adapter.js";
export { OpenCodeAdapter, createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
export { ClaudeAdapter, createClaudeAdapter, createClaudeCodeAdapter } from "./adapters/claude-adapter.js";
export type { ClaudeCodeAdapter } from "./adapters/claude-adapter.js";
export { parseClaudeStreamLine, CLAUDE_DEFAULT_ARGS } from "./adapters/claude-adapter.js";
export { CodexAdapter, createCodexAdapter, createCodexCliAdapter } from "./adapters/codex-adapter.js";
export type { CodexCliAdapter } from "./adapters/codex-adapter.js";
export { parseCodexJsonLine, CODEX_DEFAULT_ARGS } from "./adapters/codex-adapter.js";
export { GeminiAdapter, createGeminiAdapter, createGeminiCliAdapter } from "./adapters/gemini-adapter.js";
export type { GeminiCliAdapter } from "./adapters/gemini-adapter.js";
export { parseGeminiStreamLine, GEMINI_DEFAULT_ARGS } from "./adapters/gemini-adapter.js";
export { CursorCliAdapter, createCursorCliAdapter } from "./adapters/cursor-adapter.js";
export { CURSOR_DEFAULT_ARGS } from "./adapters/cursor-adapter.js";
export { ClineCliAdapter, createClineCliAdapter } from "./adapters/cline-adapter.js";
export { parseClineJsonLine, CLINE_DEFAULT_ARGS } from "./adapters/cline-adapter.js";
export { AcpConnection } from "./acp-transport.js";
export type { AcpStreams } from "./acp-transport.js";
export { OpencodeDaemonManager } from "./adapters/opencode-daemon.js";
export type { OpencodeDaemonConfig } from "./adapters/opencode-daemon.js";
export { CustomCliAdapter, createCustomCliAdapter } from "./adapters/custom-adapter.js";
export type { CustomCliDescriptor } from "./adapters/custom-adapter.js";
export {
  OPENCODE_ALLOWED_COMMANDS,
  OPENCODE_DEFAULT_RUN_ARGS,
  OPENCODE_DAEMON_DEFAULT_PORT,
  OPENCODE_DAEMON_DEFAULT_HOSTNAME,
  buildOpencodeDaemonArgs,
  insertOpencodeDaemonAttach,
  insertOpencodeOneShotDaemonAttach,
  opencodeCandidatePaths,
  opencodeEnvCliPath,
  opencodeNeedsShell,
  probeOpencodeVersion,
  resolveOpencodeCliPath,
} from "./adapters/opencode-paths.js";
export type { OpencodeCliInfo } from "./adapters/opencode-paths.js";
export {
  CLINE_ALLOWED_COMMANDS,
  CLINE_DEFAULT_RUN_ARGS,
  clineCandidatePaths,
  clineEnvCliPath,
  clineNeedsShell,
  probeClineVersion,
  resolveClineCliPath,
} from "./adapters/cline-paths.js";
export type { ClineCliInfo } from "./adapters/cline-paths.js";

/** Build a manager with the platform's default adapters registered. */
export function createDefaultCliManager(opts?: { bus?: TypedEventBus }): CliManager {
  const manager = new CliManager(opts);
  // --- Adapter registration layer (add future CLIs here only) -------------
  // Cline is the PRIMARY agent CLI; OpenCode stays registered as a
  // deprecated fallback so existing consumers keep working.
  manager.register(createClineAdapter());
  manager.register(createOpenCodeAdapter());
  manager.register(createClaudeAdapter());
  manager.register(createCodexAdapter());
  manager.register(createGeminiAdapter());
  manager.register(createCursorCliAdapter());
  manager.register(createClineCliAdapter());
  // Future adapters: custom descriptors via createCustomCliAdapter() etc.
  return manager;
}

let defaultManager: CliManager | null = null;

/**
 * Shared CLI manager — one instance so that adapter state is consistent
 * between the gateway, the LLM layer and the API.
 */
export function getDefaultCliManager(): CliManager {
  if (!defaultManager) {
    defaultManager = createDefaultCliManager();
  }
  return defaultManager;
}

/** Test helper — drops the shared manager instance. */
export function resetDefaultCliManager(): void {
  defaultManager = null;
}

/**
 * Test helper — installs a preconfigured manager (e.g. with an injected
 * process runner) as the shared instance. Production code must not call this.
 */
export function setDefaultCliManager(manager: CliManager): void {
  defaultManager = manager;
}
