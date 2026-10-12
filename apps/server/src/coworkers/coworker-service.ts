/**
 * Shared server-side helpers for custom bot (coworker) APIs.
 *
 * Security contract:
 * - Bot configs NEVER carry executable material (no command/argv/cwd/env).
 *   Anything resembling process-spawning configuration is rejected with 400.
 * - Bot ids are slug-shaped (`COWORKER_ID_PATTERN`), so path traversal via
 *   ids is impossible; workspace paths are never accepted at all.
 * - The app is single-user localhost (see docs/API.md trust model): there is
 *   no multi-user ownership layer. Authorization here means protecting the
 *   built-in system agents from archive/delete.
 */
import type { AgentRuntime } from "../llm/agent-runtime.js";
import type { EngineManager } from "../llm/registry.js";
import type { FinanceToolRegistry } from "../llm/finance-tool-registry.js";
import type { CoworkerValidationDeps } from "./coworker-validation.js";

/**
 * Fields that must never appear in bot create/update payloads. They would
 * let a caller smuggle process-spawning configuration past validation.
 */
export const FORBIDDEN_BOT_FIELDS = [
  "command",
  "args",
  "cwd",
  "executable",
  "executablePath",
  "workingDirectory",
  "workingDir",
  "env",
  "shell",
  "spawn",
  "binary",
  "entrypoint",
  "path",
  "interpreter",
] as const;

/** Keys the bot APIs accept (everything else is ignored, never persisted). */
export const ALLOWED_BOT_FIELDS = [
  "id",
  "name",
  "description",
  "role",
  "engine",
  "model",
  "systemPrompt",
  "tools",
  "permissions",
  "riskPermissions",
  "responsibilities",
  "constraints",
] as const;

export interface SanitizeResult {
  ok: boolean;
  errors: string[];
}

/**
 * Reject payloads carrying executable material. Unknown non-forbidden keys
 * are tolerated but never persisted (validation normalizes to known fields).
 */
export function sanitizeBotInput(raw: unknown): SanitizeResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const record = raw as Record<string, unknown>;
  const forbidden = FORBIDDEN_BOT_FIELDS.filter((f) => record[f] !== undefined);
  if (forbidden.length > 0) {
    return {
      ok: false,
      errors: [
        `forbidden fields rejected (bots never carry executable config): ${forbidden.join(", ")}`,
      ],
    };
  }
  return { ok: true, errors: [] };
}

/**
 * Wire Step-1 validation (`validateCoworkerInput`) to the live runtime:
 * provider ids are checked against the real EngineManager (which resolves
 * through the registered CLI adapters), tools against the real tool
 * registry, ids against the agent store.
 */
export function buildCoworkerValidationDeps(
  runtime: AgentRuntime,
  engineManager: EngineManager,
  toolRegistry: FinanceToolRegistry,
  ignoreId?: string,
): CoworkerValidationDeps {
  return {
    engineExists: async (engineId: string) => {
      try {
        await engineManager.getProviderForEngine(engineId);
        return true;
      } catch {
        return false;
      }
    },
    validTools: toolRegistry.getDefinitions().map((d) => d.name),
    idTaken: (id: string) => {
      if (ignoreId !== undefined && id === ignoreId) return false;
      return runtime.getAgent(id) !== undefined;
    },
  };
}
