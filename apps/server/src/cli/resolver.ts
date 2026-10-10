import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * Robust cross-platform auto-resolver for CLI commands (generic — no CLI is
 * special-cased here). Automatically discovers executables in PATH and global
 * npm/cargo/system locations so users NEVER need to manually configure paths.
 *
 * Environment override convention: `<COMMAND>_CLI_PATH`
 * (e.g. `opencode` → `OPENCODE_CLI_PATH`), applied per command.
 *
 * Performance: results are cached in-memory (60s positive, 10s negative) so
 * per-chat resolution does not spawn `where/which` + dozens of `stat` calls.
 */
const resolveCache = new Map<string, { path: string | null; at: number }>();
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

export interface ResolveCliPathOptions {
  /** Additional adapter-specific candidates, checked before OS fallbacks. */
  extraCandidates?: string[];
  /** Explicit env var holding a path override (defaults to `<COMMAND>_CLI_PATH`). */
  envVar?: string;
}

export interface CliPathResolution {
  command: string;
  resolvedPath: string | null;
  envOverride: string | null;
  candidates: string[];
  platform: NodeJS.Platform;
  timestamp: number;
}

function envVarFor(command: string): string {
  return `${command.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CLI_PATH`;
}

function getCached(raw: string): string | null | undefined {
  const hit = resolveCache.get(raw);
  if (!hit) return undefined;
  const ttl = hit.path ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    resolveCache.delete(raw);
    return undefined;
  }
  return hit.path;
}

export function clearCliPathCache(): void {
  resolveCache.clear();
}

/** Read the per-command env override (e.g. OPENCODE_CLI_PATH). */
export function cliPathEnvOverride(command: string, envVar?: string): string | null {
  const raw = (process.env[envVar ?? envVarFor(command)] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function commonCandidates(command: string): string[] {
  const userHome = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(userHome, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(userHome, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [
      join(appData, "npm", "node_modules", command, "bin", `${command}.exe`),
      join(appData, "npm", `${command}.cmd`),
      join(appData, "npm", `${command}.exe`),
      join(appData, "npm", command),
      join(localAppData, "Programs", command, `${command}.exe`),
      join(programFiles, command, `${command}.exe`),
      join(userHome, ".cargo", "bin", `${command}.exe`),
    ];
  }
  return [
    `/usr/local/bin/${command}`,
    `/usr/bin/${command}`,
    `/opt/homebrew/bin/${command}`,
    `${userHome}/.cargo/bin/${command}`,
    `${userHome}/.local/bin/${command}`,
    `${userHome}/.npm-global/bin/${command}`,
  ];
}

async function probePath(command: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    execFile(probe, [command], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const lines = String(stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (process.platform === "win32") {
        // Prefer native .exe over .cmd/.bat/.ps1 shims: .exe runs via execFile
        // directly, shims need shell:true (cmd.exe startup overhead per chat).
        const exe = lines.find((l) => /\.exe$/i.test(l));
        if (exe) {
          resolve(exe);
          return;
        }
        const preferred = lines.find((l) => /\.(cmd|exe|bat|ps1)$/i.test(l));
        resolve(preferred ?? lines[0] ?? null);
      } else {
        resolve(lines[0] ?? null);
      }
    });
  });
}

async function scanPathEnv(command: string): Promise<string | null> {
  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathDirs) {
    if (!dir || dir.trim() === "") continue;
    for (const ext of extensions) {
      const fullPath = join(dir.trim(), `${command}${ext}`);
      try {
        const st = await stat(fullPath);
        if (st.isFile()) return fullPath;
      } catch {
        // Continue
      }
    }
  }
  return null;
}

/**
 * Full resolution trace (used by adapters for validation + `/api/cli/*` metadata).
 * Never throws — returns a resolution record with `resolvedPath: null` on miss.
 */
export async function resolveCliExecutable(
  command: string,
  opts?: ResolveCliPathOptions,
): Promise<CliPathResolution> {
  const base: Omit<CliPathResolution, "resolvedPath" | "envOverride" | "candidates"> = {
    command,
    platform: process.platform,
    timestamp: Date.now(),
  };
  if (!command || typeof command !== "string" || command.trim() === "") {
    return { ...base, resolvedPath: null, envOverride: null, candidates: [] };
  }

  const raw = command.trim().replace(/^"(.*)"$/, "$1");
  const envOverride = cliPathEnvOverride(raw, opts?.envVar);
  const candidates = [...(opts?.extraCandidates ?? []), ...commonCandidates(raw)];

  if (envOverride) {
    try {
      const st = await stat(resolvePath(envOverride));
      if (st.isFile()) {
        return { ...base, resolvedPath: resolvePath(envOverride), envOverride, candidates };
      }
    } catch {
      // Fall through to normal resolution
    }
  }

  if (isAbsolute(raw) || raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) {
    try {
      const st = await stat(resolvePath(raw));
      if (st.isFile()) return { ...base, resolvedPath: resolvePath(raw), envOverride, candidates };
    } catch {
      // Continue auto-discovery
    }
  }

  // On Windows, prefer candidate .exe binaries over .cmd/.bat/.ps1 shims
  if (process.platform === "win32") {
    for (const candidate of candidates) {
      if (candidate.toLowerCase().endsWith(".exe")) {
        try {
          const st = await stat(candidate);
          if (st.isFile()) return { ...base, resolvedPath: candidate, envOverride, candidates };
        } catch {}
      }
    }
  }

  const fromProbe = await probePath(raw);
  if (fromProbe) return { ...base, resolvedPath: fromProbe, envOverride, candidates };

  for (const candidate of candidates) {
    try {
      const st = await stat(candidate);
      if (st.isFile()) return { ...base, resolvedPath: candidate, envOverride, candidates };
    } catch {
      // Continue checking next candidate
    }
  }

  const fromPath = await scanPathEnv(raw);
  if (fromPath) return { ...base, resolvedPath: fromPath, envOverride, candidates };

  return { ...base, resolvedPath: null, envOverride, candidates };
}

/**
 * Backward-compatible thin wrapper: returns the resolved absolute path or null.
 * Cached for performance (60s positive / 10s negative).
 */
export async function autoResolveCliPath(
  command: string,
  opts?: ResolveCliPathOptions,
): Promise<string | null> {
  if (!command || typeof command !== "string" || command.trim() === "") {
    return null;
  }
  const raw = command.trim().replace(/^"(.*)"$/, "$1");
  const cached = getCached(raw);
  if (cached !== undefined) return cached;
  const resolution = await resolveCliExecutable(raw, opts);
  resolveCache.set(raw, { path: resolution.resolvedPath, at: Date.now() });
  return resolution.resolvedPath;
}
