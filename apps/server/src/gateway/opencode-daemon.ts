// ============================================================================
// Backward-compatible re-export.
// The OpenCode daemon manager moved into the CLI adapter layer:
//   apps/server/src/cli/adapters/opencode-daemon.ts
// Existing imports (`../gateway/opencode-daemon.js`) keep working unchanged.
// ============================================================================

export { OpencodeDaemonManager } from "../cli/adapters/opencode-daemon.js";
export type { OpencodeDaemonConfig } from "../cli/adapters/opencode-daemon.js";
