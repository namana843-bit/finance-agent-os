import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { DATA_DIR } from "../config.js";
import { autoResolveCliPath } from "./cli-resolver.js";

export interface DetectedEngine {
  name: string;
  command: string;
  found: boolean;
  path?: string;
  suggestedArgs?: string[];
}

interface KnownEngine {
  name: string;
  command: string;
  suggestedArgs: string[];
}

const KNOWN_ENGINES: KnownEngine[] = [
  {
    name: "claude",
    command: "claude",
    suggestedArgs: ["-p", "{prompt}", "--model", "{model}"],
  },
  { name: "codex", command: "codex", suggestedArgs: ["exec", "{prompt}"] },
  { name: "gemini", command: "gemini", suggestedArgs: ["-p", "{prompt}"] },
  { name: "grok", command: "grok", suggestedArgs: ["-p", "{prompt}"] },
  {
    name: "ollama",
    command: "ollama",
    suggestedArgs: ["run", "{model}", "{prompt}"],
  },
  { name: "hermes", command: "hermes", suggestedArgs: ["-z", "{prompt}"] },
  { name: "agy", command: "agy", suggestedArgs: ["exec", "{prompt}"] },
  { name: "opencode", command: "opencode", suggestedArgs: ["run", "{prompt}"] },
  { name: "qwen", command: "qwen", suggestedArgs: ["-p", "{prompt}"] },
  { name: "pi", command: "pi", suggestedArgs: ["-p", "{prompt}"] },
];

function defaultExecImpl(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    execFile(probe, [cmd], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const first = String(stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      resolve(first ?? null);
    });
  });
}

export async function detectCliEngines(
  execImpl: (cmd: string) => Promise<string | null> = defaultExecImpl,
): Promise<DetectedEngine[]> {
  const results: DetectedEngine[] = [];
  for (const known of KNOWN_ENGINES) {
    let path: string | null = null;
    try {
      path = await execImpl(known.command);
    } catch {
      path = null;
    }
    if (path !== null && path.trim().length > 0) {
      results.push({
        name: known.name,
        command: known.command,
        found: true,
        path: path.trim(),
        suggestedArgs: [...known.suggestedArgs],
      });
    } else {
      results.push({
        name: known.name,
        command: known.command,
        found: false,
        suggestedArgs: [...known.suggestedArgs],
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Engine catalog + statuses + command overrides
// ---------------------------------------------------------------------------

export interface EngineCatalogEntry {
  id: string;
  name: string;
  group: "cloud" | "local";
  kind: "cli" | "openai-compat";
  command: string;
  install?: string;
  suggestedArgs?: string[];
}

export const ENGINE_CATALOG: EngineCatalogEntry[] = [
  {
    id: "claude",
    name: "Claude",
    group: "cloud",
    kind: "cli",
    command: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    suggestedArgs: ["-p", "{prompt}", "--model", "{model}"],
  },
  {
    id: "codex",
    name: "Codex",
    group: "cloud",
    kind: "cli",
    command: "codex",
    install: "npm install -g @openai/codex",
    suggestedArgs: ["exec", "{prompt}"],
  },
  {
    id: "gemini",
    name: "Gemini",
    group: "cloud",
    kind: "cli",
    command: "gemini",
    suggestedArgs: ["-p", "{prompt}"],
  },
  {
    id: "grok",
    name: "Grok",
    group: "cloud",
    kind: "cli",
    command: "grok",
    suggestedArgs: ["-p", "{prompt}"],
  },
  {
    id: "cursor-agent",
    name: "Cursor",
    group: "cloud",
    kind: "cli",
    command: "cursor-agent",
    suggestedArgs: ["exec", "{prompt}"],
  },
  {
    id: "droid",
    name: "Droid",
    group: "cloud",
    kind: "cli",
    command: "droid",
    suggestedArgs: ["exec", "{prompt}"],
  },
  {
    id: "kimi",
    name: "Kimi",
    group: "cloud",
    kind: "cli",
    command: "kimi",
    suggestedArgs: ["-p", "{prompt}"],
  },
  {
    id: "agy",
    name: "Antigravity",
    group: "cloud",
    kind: "cli",
    command: "agy",
    suggestedArgs: ["exec", "{prompt}"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    group: "cloud",
    kind: "cli",
    command: "opencode",
    suggestedArgs: ["run", "{prompt}"],
  },
  {
    id: "qwen",
    name: "Qwen",
    group: "cloud",
    kind: "cli",
    command: "qwen",
    suggestedArgs: ["-p", "{prompt}"],
  },
  {
    id: "hermes",
    name: "Hermes",
    group: "cloud",
    kind: "cli",
    command: "hermes",
    suggestedArgs: ["-z", "{prompt}"],
  },
  {
    id: "pi",
    name: "pi",
    group: "cloud",
    kind: "cli",
    command: "pi",
    suggestedArgs: ["-p", "{prompt}"],
  },
  {
    id: "openai-compat",
    name: "OpenAI-compatible (OpenRouter / Groq)",
    group: "local",
    kind: "openai-compat",
    command: "",
  },
];

export interface EngineStatus extends EngineCatalogEntry {
  found: boolean;
  path?: string;
  overridden: boolean;
  effectiveCommand: string;
  version?: string;
}

function defaultDataDir(): string {
  return process.env.FINANCE_DATA_DIR || DATA_DIR;
}

function enginesFile(dataDir?: string): string {
  return join(dataDir ?? defaultDataDir(), "engines.json");
}

export function resolveEngineCommand(
  entry: EngineCatalogEntry,
  overrides: Record<string, string>,
): string {
  const override = overrides[entry.id];
  if (typeof override === "string" && override.trim() !== "") {
    return override;
  }
  return entry.command;
}

export async function loadEngineOverrides(
  dataDir?: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(enginesFile(dataDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const overrides: unknown =
      (parsed as { overrides?: unknown } | null)?.overrides ?? {};
    if (typeof overrides !== "object" || overrides === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      overrides as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.trim() !== "") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveEngineOverride(
  dataDir: string | undefined,
  id: string,
  command: string | undefined,
): Promise<void> {
  try {
    const dir = dataDir ?? defaultDataDir();
    const overrides = await loadEngineOverrides(dir);
    if (command === undefined) {
      delete overrides[id];
    } else {
      overrides[id] = command;
    }
    await mkdir(dir, { recursive: true });
    const file = join(dir, "engines.json");
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ overrides }, null, 2), "utf-8");
    await rename(tmp, file);
  } catch {
    // Never throws — persistence is best-effort.
  }
}

function resolveCommandPath(command: string): Promise<string | null> {
  return autoResolveCliPath(command);
}

export function probeVersion(
  command: string,
  timeoutMs = 2500,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        ["--version"],
        { timeout: timeoutMs },
        (error, stdout) => {
          try {
            if (error) {
              resolve(undefined);
              return;
            }
            const first = String(stdout ?? "")
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line.length > 0);
            if (!first) {
              resolve(undefined);
              return;
            }
            resolve(first.slice(0, 24));
          } catch {
            resolve(undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

export async function getEngineStatuses(
  probe = true,
): Promise<EngineStatus[]> {
  try {
    const overrides = await loadEngineOverrides();
    const base: EngineStatus[] = await Promise.all(
      ENGINE_CATALOG.map(async (entry) => {
        try {
          const effectiveCommand = resolveEngineCommand(entry, overrides);
          const overridden =
            typeof overrides[entry.id] === "string" &&
            overrides[entry.id]!.trim() !== "";
          if (entry.kind === "openai-compat") {
            return {
              ...entry,
              suggestedArgs: entry.suggestedArgs
                ? [...entry.suggestedArgs]
                : undefined,
              found: true,
              path: undefined,
              overridden,
              effectiveCommand,
              version: undefined,
            } satisfies EngineStatus;
          }
          if (!effectiveCommand || effectiveCommand.trim() === "") {
            return {
              ...entry,
              suggestedArgs: entry.suggestedArgs
                ? [...entry.suggestedArgs]
                : undefined,
              found: false,
              path: undefined,
              overridden,
              effectiveCommand,
              version: undefined,
            } satisfies EngineStatus;
          }
          let foundPath: string | null = null;
          try {
            foundPath = await resolveCommandPath(effectiveCommand);
          } catch {
            foundPath = null;
          }
          const found =
            foundPath !== null && foundPath.trim().length > 0;
          return {
            ...entry,
            suggestedArgs: entry.suggestedArgs
              ? [...entry.suggestedArgs]
              : undefined,
            found,
            path: found && foundPath ? foundPath.trim() : undefined,
            overridden,
            effectiveCommand,
            version: undefined,
          } satisfies EngineStatus;
        } catch {
          return {
            ...entry,
            found: entry.kind === "openai-compat",
            path: undefined,
            overridden: false,
            effectiveCommand: entry.command,
            version: undefined,
          } satisfies EngineStatus;
        }
      }),
    );

    if (!probe) return base;

    await Promise.all(
      base.map(async (status) => {
        try {
          if (!probe || !status.found || status.kind !== "cli") return;
          const version = await probeVersion(status.effectiveCommand);
          if (version !== undefined) {
            status.version = version;
          }
        } catch {
          // Per-engine guard — never rejects.
        }
      }),
    );
    return base;
  } catch {
    // Never rejects — return unprobed fallback statuses.
    return ENGINE_CATALOG.map((entry) => ({
      ...entry,
      found: entry.kind === "openai-compat",
      path: undefined,
      overridden: false,
      effectiveCommand: entry.command,
      version: undefined,
    }));
  }
}
