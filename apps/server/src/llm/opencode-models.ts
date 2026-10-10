import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface OpencodeAgentModelConfig {
  model: string;
  small_model: string;
  model_available: boolean;
  small_model_available: boolean;
}

export interface OpencodeProjectConfig {
  exists: boolean;
  path?: string;
  default_model?: string;
  default_model_available?: boolean;
  small_model?: string;
  small_model_available?: boolean;
  agents?: Record<string, OpencodeAgentModelConfig>;
  error?: string;
}

export interface OpencodeModelsResponse {
  available: boolean;
  cliPath: string | null;
  total: number;
  models: string[];
  grouped: Record<string, string[]>;
  projectConfig?: OpencodeProjectConfig;
  cachedAt?: number;
  error?: string;
}

let inMemoryCache: OpencodeModelsResponse | null = null;
let inMemoryCacheTime = 0;
const CACHE_TTL_MS = 120_000; // 2 minutes in memory

function findWorkspaceRoot(): string {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, "list_opencode_models.py")) || existsSync(path.join(cur, "pnpm-workspace.yaml"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

/**
 * Executes list_opencode_models.py or reads the cached data to return
 * all available OpenCode models for Finance Agent OS.
 */
export async function getOpencodeModels(options: { refresh?: boolean } = {}): Promise<OpencodeModelsResponse> {
  const now = Date.now();
  if (!options.refresh && inMemoryCache && now - inMemoryCacheTime < CACHE_TTL_MS) {
    return inMemoryCache;
  }

  const workspaceRoot = findWorkspaceRoot();
  const cacheFilePath = path.join(workspaceRoot, ".data", "opencode-models-cache.json");
  const scriptPath = path.join(workspaceRoot, "list_opencode_models.py");

  // If not forcing refresh, check existing on-disk cache first
  if (!options.refresh && existsSync(cacheFilePath)) {
    try {
      const raw = readFileSync(cacheFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        const response: OpencodeModelsResponse = {
          available: Boolean(parsed.available),
          cliPath: parsed.cliPath ?? null,
          total: parsed.total ?? parsed.models.length,
          models: parsed.models,
          grouped: parsed.grouped ?? {},
          projectConfig: parsed.projectConfig,
          cachedAt: parsed.cached_at ? Math.round(parsed.cached_at * 1000) : now,
        };
        inMemoryCache = response;
        inMemoryCacheTime = now;
        return response;
      }
    } catch {
      // Fall through to script execution
    }
  }

  // Execute python list_opencode_models.py --json
  try {
    const args = [scriptPath, "--json"];
    if (options.refresh) {
      args.push("--refresh");
    }

    const { stdout } = await execFileAsync("python", args, {
      cwd: workspaceRoot,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout.trim());
    const response: OpencodeModelsResponse = {
      available: Boolean(parsed.available),
      cliPath: parsed.cliPath ?? null,
      total: parsed.total ?? (Array.isArray(parsed.models) ? parsed.models.length : 0),
      models: Array.isArray(parsed.models) ? parsed.models : [],
      grouped: parsed.grouped ?? {},
      projectConfig: parsed.projectConfig,
      cachedAt: now,
    };

    inMemoryCache = response;
    inMemoryCacheTime = now;
    return response;
  } catch (err) {
    // If execution fails but disk cache exists, fallback to disk cache
    if (existsSync(cacheFilePath)) {
      try {
        const raw = readFileSync(cacheFilePath, "utf8");
        const parsed = JSON.parse(raw);
        return {
          available: Boolean(parsed.available),
          cliPath: parsed.cliPath ?? null,
          total: parsed.total ?? (parsed.models ? parsed.models.length : 0),
          models: parsed.models ?? [],
          grouped: parsed.grouped ?? {},
          projectConfig: parsed.projectConfig,
          cachedAt: parsed.cached_at ? Math.round(parsed.cached_at * 1000) : now,
        };
      } catch {
        // Fall through
      }
    }

    return {
      available: false,
      cliPath: null,
      total: 0,
      models: [],
      grouped: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Updates opencode.json directly on disk and busts model caches so the change
 * immediately propagates across all OpenCode agent sessions and CLI invocations.
 */
export async function updateOpencodeProjectModel(opts: {
  model: string;
  agentId?: string;
  applyToAll?: boolean;
}): Promise<OpencodeModelsResponse> {
  const workspaceRoot = findWorkspaceRoot();
  const configPath = path.join(workspaceRoot, "opencode.json");
  const cacheFilePath = path.join(workspaceRoot, ".data", "opencode-models-cache.json");

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const config = JSON.parse(raw);

      if (opts.applyToAll || !opts.agentId) {
        config.model = opts.model;
        for (const key of ["agent", "agents"]) {
          const section = (config as Record<string, unknown>)[key];
          if (section && typeof section === "object") {
            for (const name of Object.keys(section as Record<string, unknown>)) {
              const entry = (section as Record<string, unknown>)[name];
              if (entry && typeof entry === "object") {
                (entry as Record<string, unknown>).model = opts.model;
              }
            }
          }
        }
      } else if (opts.agentId) {
        const section =
          (config.agent as Record<string, unknown> | undefined) ??
          (config.agents as Record<string, unknown> | undefined);
        if (section?.[opts.agentId] && typeof section[opts.agentId] === "object") {
          (section[opts.agentId] as Record<string, unknown>).model = opts.model;
        }
      }

      const { writeFileSync } = await import("node:fs");
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    } catch (e) {
      console.error("[opencode-models] failed to update opencode.json:", e);
    }
  }

  // Bust caches
  inMemoryCache = null;
  inMemoryCacheTime = 0;
  if (existsSync(cacheFilePath)) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(cacheFilePath);
    } catch {
      // ignore
    }
  }

  return getOpencodeModels({ refresh: true });
}

