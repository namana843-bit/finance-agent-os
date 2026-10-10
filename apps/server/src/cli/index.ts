// ============================================================================
// Finance Agent OS — CLI Adapter Layer (public entry point)
//
//   Desktop UI / Runtime → CliManager → CliAdapter → OpenCodeAdapter | …
//
// This is the ONLY module allowed to know which concrete adapters exist.
// Everything else depends on the CliAdapter interface + CliManager API.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import { CliManager } from "./cli-manager.js";
import { OpenCodeAdapter, createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
import { ClaudeAdapter, createClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter, createCodexAdapter } from "./adapters/codex-adapter.js";
import { GeminiAdapter, createGeminiAdapter } from "./adapters/gemini-adapter.js";

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
export { CliAdapterBase, defaultOneShotArgs } from "./adapter-base.js";
export { CliManager, CliManagedSession } from "./cli-manager.js";
export type { CliManagerOptions } from "./cli-manager.js";
export { JsonLineTransport } from "./protocol-transport.js";
export type { JsonLineTransportStreams } from "./protocol-transport.js";
export { OpenCodeAdapter, createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
export { ClaudeAdapter, createClaudeAdapter } from "./adapters/claude-adapter.js";
export { CodexAdapter, createCodexAdapter } from "./adapters/codex-adapter.js";
export { GeminiAdapter, createGeminiAdapter } from "./adapters/gemini-adapter.js";
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

/** Build a manager with the platform's default adapters registered. */
export function createDefaultCliManager(opts?: { bus?: TypedEventBus }): CliManager {
  const manager = new CliManager(opts);
  // --- Adapter registration layer (add future CLIs here only) -------------
  manager.register(createOpenCodeAdapter());
  manager.register(createClaudeAdapter());
  manager.register(createCodexAdapter());
  manager.register(createGeminiAdapter());
  // Future adapters: custom descriptors via createCustomCliAdapter() etc.
  return manager;
}

let defaultManager: CliManager | null = null;

/**
 * Shared CLI manager — one instance so that adapter state (e.g. the OpenCode
 * daemon URL) is consistent between the gateway, the LLM layer and the API.
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
