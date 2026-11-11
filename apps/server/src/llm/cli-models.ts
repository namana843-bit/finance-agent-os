// ============================================================================
// Finance Agent OS — Generic CLI model discovery
//
// Enumerates the models a CLI coding agent can accept (`--model`/`-m`) so the
// desktop UI can show a real list for every engine, not just OpenCode.
//
// Three sources, in priority order:
//   1. dynamic  — the CLI (or its API) can list models itself:
//                 `opencode models` via list_opencode_models.py,
//                 `ollama list`, Gemini ListModels API (when a key is set).
//   2. curated  — a maintained, honest catalog of ids the CLI's --model flag
//                 accepts. Labeled as curated; never claimed to be live.
//   3. fallback — a single entry named after the executable (previous
//                 behaviour), so a selector is never empty for unknown CLIs.
//
// Never throws: failures degrade to the fallback entry with an error string.
// Results are cached in memory (5 min TTL) keyed by executable.
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getOpencodeModels } from "./opencode-models.js";

const execFileAsync = promisify(execFile);

export interface CliModelEntry {
  id: string;
  name: string;
  description?: string;
}

export type CliModelSource = "dynamic" | "curated" | "fallback" | "unavailable";

export interface CliModelsResult {
  executable: string;
  source: CliModelSource;
  models: CliModelEntry[];
  /** Present when discovery degraded or failed. */
  error?: string;
}

export interface CliModelsOptions {
  /** Force a fresh discovery instead of the in-memory cache. */
  refresh?: boolean;
  /** Provider id (e.g. "cli-gemini") used only for descriptions. */
  providerId?: string;
}

// ---------------------------------------------------------------------------
// Curated catalogs — ids each CLI's model flag actually accepts.
// Kept honest: entry descriptions say "curated" when the list is not live.
// ---------------------------------------------------------------------------

type CuratedEntry = [id: string, name: string, description: string];

const CURATED_CATALOGS: Record<string, CuratedEntry[]> = {
  gemini: [
    ["gemini-3-pro-preview", "Gemini 3 Pro (preview)", "Frontier multimodal model, preview channel"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro", "Strong reasoning + 1M context"],
    ["gemini-2.5-flash", "Gemini 2.5 Flash", "Fast, balanced everyday model"],
    ["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "Cheapest fast tier"],
    ["gemini-2.0-flash", "Gemini 2.0 Flash", "Legacy fast tier"],
  ],
  claude: [
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "Best coding model, latest Sonnet"],
    ["claude-opus-4-1-20250805", "Claude Opus 4.1", "Largest-context frontier Opus"],
    ["claude-sonnet-4-20250514", "Claude Sonnet 4", "Previous Sonnet generation"],
    ["claude-3-5-haiku-20241022", "Claude Haiku 3.5", "Fast, cheap tier"],
    ["sonnet", "Sonnet (alias)", "Claude Code short alias for the current Sonnet"],
    ["opus", "Opus (alias)", "Claude Code short alias for the current Opus"],
    ["haiku", "Haiku (alias)", "Claude Code short alias for the current Haiku"],
  ],
  codex: [
    ["gpt-5.1-codex", "GPT-5.1 Codex", "Codex-tuned flagship coding model"],
    ["gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", "Smaller, faster Codex model"],
    ["gpt-5.1", "GPT-5.1", "General-purpose flagship"],
    ["gpt-5-codex", "GPT-5 Codex", "Previous Codex generation"],
    ["gpt-5", "GPT-5", "Previous flagship"],
    ["o3", "o3", "Reasoning model"],
    ["o4-mini", "o4-mini", "Compact reasoning model"],
  ],
  "cursor-agent": [
    ["auto", "Auto", "Cursor picks the best model per request"],
    ["composer-1", "Composer 1", "Cursor's in-house fast coding model"],
    ["claude-sonnet-4.5", "Claude Sonnet 4.5", "Anthropic Sonnet via Cursor"],
    ["gpt-5", "GPT-5", "OpenAI flagship via Cursor"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro", "Google flagship via Cursor"],
    ["o3", "o3", "OpenAI reasoning via Cursor"],
  ],
  agent: [], // resolved below — cursor adapter's executable alias
  cline: [
    ["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "Anthropic via Cline"],
    ["anthropic/claude-opus-4.1", "Claude Opus 4.1", "Anthropic Opus via Cline"],
    ["openai/gpt-5", "GPT-5", "OpenAI via Cline"],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro", "Google via Cline"],
    ["x-ai/grok-code-fast-1", "Grok Code Fast 1", "Fast agentic coding model"],
    ["qwen/qwen3-coder", "Qwen3 Coder", "Open-weight coding model"],
    ["deepseek/deepseek-v3.1", "DeepSeek V3.1", "Open-weight coding model"],
  ],
  qwen: [
    ["qwen3-coder-plus", "Qwen3 Coder Plus", "Flagship Qwen coding model (API)"],
    ["qwen3-coder-flash", "Qwen3 Coder Flash", "Fast Qwen coding model (API)"],
    ["qwen3-max", "Qwen3 Max", "Largest general Qwen model (API)"],
  ],
  grok: [
    ["grok-4", "Grok 4", "Frontier xAI model"],
    ["grok-code-fast-1", "Grok Code Fast 1", "Fast agentic coding model"],
    ["grok-3", "Grok 3", "Previous generation"],
    ["grok-3-mini", "Grok 3 Mini", "Compact reasoning model"],
  ],
};

// Cursor's adapter exposes the binary as `agent` — same catalog as cursor-agent.
CURATED_CATALOGS.agent = CURATED_CATALOGS["cursor-agent"];

// ---------------------------------------------------------------------------
// Dynamic discovery per executable
// ---------------------------------------------------------------------------

async function discoverOllamaModels(executable: string): Promise<CliModelEntry[]> {
  const { stdout } = await execFileAsync(executable, ["list"], { timeout: 10_000, windowsHide: true });
  const models: CliModelEntry[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const name = line.trim().split(/\s{2,}/)[0]?.trim();
    if (name && !models.some((m) => m.id === name)) {
      models.push({ id: name, name, description: "Local Ollama model (`ollama list`)" });
    }
  }
  return models;
}

async function discoverGeminiModelsViaApi(): Promise<CliModelEntry[]> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return [];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Gemini ListModels HTTP ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }> };
  return (body.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => ({
      id: (m.name ?? "").replace(/^models\//, ""),
      name: m.displayName ?? (m.name ?? "").replace(/^models\//, ""),
      description: `Live from Gemini API: ${m.description ?? ""}`.trim(),
    }))
    .filter((m) => m.id.length > 0);
}

async function dynamicModels(executable: string): Promise<CliModelEntry[]> {
  switch (executable) {
    case "opencode": {
      const discovered = await getOpencodeModels({ refresh: false });
      return discovered.models.map((id) => ({ id, name: id, description: `OpenCode free model: ${id}` }));
    }
    case "ollama":
      return discoverOllamaModels(executable);
    case "gemini": {
      const viaApi = await discoverGeminiModelsViaApi().catch(() => [] as CliModelEntry[]);
      if (viaApi.length > 0) return viaApi;
      return []; // curated list serves as the fallback
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { result: CliModelsResult; at: number }>();

function fallbackEntry(executable: string, providerId?: string): CliModelEntry {
  return {
    id: executable,
    name: providerId ?? `CLI (${executable})`,
    description: `Local executable: ${executable} (no model list published by this CLI)`,
  };
}

/**
 * Discover the models a CLI executable can accept.
 *
 * Priority: dynamic source → curated catalog → single fallback entry.
 * Never throws; every failure degrades to the next tier.
 */
export async function discoverCliModels(
  executable: string,
  opts: CliModelsOptions = {},
): Promise<CliModelsResult> {
  const key = `${executable}`;
  const cached = cache.get(key);
  if (!opts.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await computeCliModels(executable, opts);
  cache.set(key, { result, at: Date.now() });
  return result;
}

async function computeCliModels(executable: string, opts: CliModelsOptions): Promise<CliModelsResult> {
  // 1) Dynamic source.
  try {
    const models = await dynamicModels(executable);
    if (models.length > 0) {
      return { executable, source: "dynamic", models };
    }
  } catch (err) {
    // Degrade to curated; remember why.
    const curated = CURATED_CATALOGS[executable] ?? [];
    if (curated.length > 0) {
      return {
        executable,
        source: "curated",
        models: curated.map(([id, name, description]) => ({ id, name, description })),
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      executable,
      source: "fallback",
      models: [fallbackEntry(executable, opts.providerId)],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2) Curated catalog.
  const curated = CURATED_CATALOGS[executable] ?? [];
  if (curated.length > 0) {
    return {
      executable,
      source: "curated",
      models: curated.map(([id, name, description]) => ({ id, name, description })),
    };
  }

  // 3) Fallback — single executable entry (previous behaviour).
  return { executable, source: "fallback", models: [fallbackEntry(executable, opts.providerId)] };
}

/** Test/ops hook: clear the in-memory cache. */
export function clearCliModelsCache(): void {
  cache.clear();
}
