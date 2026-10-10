// ============================================================================
// Backward-compatible re-export.
// The generic cross-platform CLI resolver now lives in the CLI adapter layer:
//   apps/server/src/cli/resolver.ts
// Existing imports (`../llm/cli-resolver.js`) keep working unchanged.
// ============================================================================

export {
  autoResolveCliPath,
  resolveCliExecutable,
  clearCliPathCache,
  cliPathEnvOverride,
} from "../cli/resolver.js";
export type { CliPathResolution, ResolveCliPathOptions } from "../cli/resolver.js";
