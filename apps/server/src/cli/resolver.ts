import { execFile } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
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
 *
 * VPS hardening (per root-cause fix):
 *   • Resolves symlinks to their actual executable path (never trusts a
 *     symlink alone).
   • Validates executable permissions (must be executable by the service user).
 *   • Searches the PATH inherited by the running service (systemd may inherit
     a restricted PATH).
 *   • Supports custom provider-runtime directories
     (`/home/ubuntu/.config/OpenBot/provider-runtimes/<cli>/bin/<cli>`).
 *   • Never reports installed=true based only on a symlink existing — must
     stat the resolved target and confirm it's an executable file.
 */
const resolveCache = new Map<string, { path: string | null; at: number }>();
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

export interface ResolveCliPathOptions {
  /** Additional adapter-specific candidates, checked before OS fallbacks. */
  extraCandidates?: string[];
  /** Explicit env var holding a path override (defaults to `<COMMAND>_CLI_PATH`). */
  envVar?: string;
  /** Extra directories to search for provider-runtime installations. */
  providerRuntimeDirs?: string[];
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
    // Custom provider-runtime directories (VPS deployments)
    `${userHome}/.config/OpenBot/provider-runtimes/${command}/bin/${command}`,
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

/** Verify a path resolves to a real, executable file (symlink-safe). */
async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
    // Check execute permission for owner/group/other
    const mode = st.mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Resolve symlinks to their actual target path, validating it exists. */
async function resolveSymlinkSafe(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath);
  } catch {
    return null;
  }
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
  const extraCandidates = opts?.extraCandidates ?? [];
  const runtimeDirs = opts?.providerRuntimeDirs ?? [];
  const candidates = [...extraCandidates, ...commonCandidates(raw)];

  // 1. Env override first — must resolve to a real executable file
  if (envOverride) {
    try {
      const st = await stat(resolvePath(envOverride));
      if (st.isFile()) {
        const resolved = await resolveSymlinkSafe(envOverride);
        const finalPath = resolved ?? envOverride;
        if (await isExecutableFile(finalPath)) {
          return { ...base, resolvedPath: finalPath, envOverride, candidates };
        }
      }
    } catch {
      // Fall through to normal resolution
    }
  }

  // 2. Absolute or relative path specified directly
  if (isAbsolute(raw) || raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) {
    try {
      const st = await stat(resolvePath(raw));
      if (st.isFile()) {
        const resolved = await resolveSymlinkSafe(resolvePath(raw));
        const finalPath = resolved ?? resolvePath(raw);
        if (await isExecutableFile(finalPath)) {
          return { ...base, resolvedPath: finalPath, envOverride, candidates };
        }
      }
    } catch {
      // Continue auto-discovery
    }
  }

  // 3. On Windows, prefer candidate .exe binaries over .cmd/.bat/.ps1 shims
  if (process.platform === "win32") {
    for (const candidate of candidates) {
      if (candidate.toLowerCase().endsWith(".exe")) {
        try {
          const st = await stat(candidate);
          if (st.isFile()) {
            const resolved = await resolveSymlinkSafe(candidate);
            const finalPath = resolved ?? candidate;
            if (await isExecutableFile(finalPath)) {
              return { ...base, resolvedPath: finalPath, envOverride, candidates };
            }
          }
        } catch {}
      }
    }
  }

  // 4. Custom provider-runtime directories (VPS deployments)
  for (const runtimeDir of runtimeDirs) {
    const runtimeBin = join(runtimeDir, raw, "bin", raw);
    try {
      const st = await stat(runtimeBin);
      if (st.isFile()) {
        const resolved = await resolveSymlinkSafe(runtimeBin);
        const finalPath = resolved ?? runtimeBin;
        if (await isExecutableFile(finalPath)) {
          return { ...base, resolvedPath: finalPath, envOverride, candidates };
        }
      }
    } catch {
      // Continue checking next runtime dir
    }
  }

  // 5. PATH probe (where/which)
  const fromProbe = await probePath(raw);
  if (fromProbe) {
    const resolved = await resolveSymlinkSafe(fromProbe);
    const finalPath = resolved ?? fromProbe;
    if (await isExecutableFile(finalPath)) {
      return { ...base, resolvedPath: finalPath, envOverride, candidates };
    }
  }

  // 6. Candidate stat scan
  for (const candidate of candidates) {
    try {
      const st = await stat(candidate);
      if (st.isFile()) {
        const resolved = await resolveSymlinkSafe(candidate);
        const finalPath = resolved ?? candidate;
        if (await isExecutableFile(finalPath)) {
          return { ...base, resolvedPath: finalPath, envOverride, candidates };
        }
      }
    } catch {
      // Continue checking next candidate
    }
  }

  // 7. PATH env fallback (direct stat per directory)
  const fromPath = await scanPathEnv(raw);
  if (fromPath) {
    const resolved = await resolveSymlinkSafe(fromPath);
    const finalPath = resolved ?? fromPath;
    if (await isExecutableFile(finalPath)) {
      return { ...base, resolvedPath: finalPath, envOverride, candidates };
    }
  }

  return { ...base, resolvedPath: null, envOverride, candidates };
}

/** Scan PATH directories directly for the executable. */
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
