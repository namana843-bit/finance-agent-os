import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * Robust cross-platform auto-resolver for CLI commands.
 * Automatically discovers executables in PATH and global npm/cargo/system locations
 * so users NEVER need to manually configure CLI paths.
 *
 * Performance: results are cached in-memory (60s positive, 10s negative) so
 * per-chat resolution does not spawn `where/which` + dozens of `stat` calls.
 */
const resolveCache = new Map<string, { path: string | null; at: number }>();
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

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

export async function autoResolveCliPath(command: string): Promise<string | null> {
  if (!command || typeof command !== "string" || command.trim() === "") {
    return null;
  }

  const raw = command.trim().replace(/^"(.*)"$/, "$1");
  const cached = getCached(raw);
  if (cached !== undefined) return cached;
  const cacheAndReturn = (p: string | null): string | null => {
    resolveCache.set(raw, { path: p, at: Date.now() });
    return p;
  };

  // 0. Environment variable override check for opencode
  if (raw.toLowerCase().includes("opencode")) {
    const envPath = process.env.OPENCODE_CLI_PATH?.trim();
    if (envPath) {
      const absEnv = resolvePath(envPath);
      try {
        const st = await stat(absEnv);
        if (st.isFile()) return absEnv;
      } catch {
        // Fall through to normal resolution
      }
    }
  }

  // 1. Direct absolute/relative file check
  if (isAbsolute(raw) || raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) {
    const abs = resolvePath(raw);
    try {
      const st = await stat(abs);
      if (st.isFile()) return cacheAndReturn(abs);
    } catch {
      // Continue auto-discovery
    }
  }

  // 2. Primary OS PATH probe via `where` (Windows) or `which` (Unix)
  const pathFromProbe = await new Promise<string | null>((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    execFile(probe, [raw], (error, stdout) => {
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
        if (exe) resolve(exe);
        else {
          const preferred = lines.find((l) =>
            /\.(cmd|exe|bat|ps1)$/i.test(l),
          );
          resolve(preferred ?? lines[0] ?? null);
        }
      } else {
        resolve(lines[0] ?? null);
      }
    });
  });

  if (pathFromProbe) {
    return cacheAndReturn(pathFromProbe);
  }

  // 3. Fallback discovery in common global binary locations
  const candidates: string[] = [];
  const userHome = homedir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(userHome, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(userHome, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";

    candidates.push(
      join(appData, "npm", "node_modules", "opencode-ai", "bin", `${raw}.exe`),
      join(appData, "npm", "node_modules", raw, "bin", `${raw}.exe`),
      join(appData, "npm", `${raw}.cmd`),
      join(appData, "npm", `${raw}.exe`),
      join(appData, "npm", raw),
      join(localAppData, "Programs", raw, `${raw}.exe`),
      join(localAppData, "Programs", "opencode", `${raw}.exe`),
      join(programFiles, raw, `${raw}.exe`),
      join(userHome, ".cargo", "bin", `${raw}.exe`),
      join(userHome, ".opencode", "bin", `${raw}.exe`),
      join(userHome, ".opencode", "bin", `${raw}.cmd`),
    );
  } else {
    candidates.push(
      `/usr/local/bin/${raw}`,
      `/usr/bin/${raw}`,
      `/opt/homebrew/bin/${raw}`,
      `${userHome}/.cargo/bin/${raw}`,
      `${userHome}/.local/bin/${raw}`,
      `${userHome}/.npm-global/bin/${raw}`,
      `${userHome}/.opencode/bin/${raw}`,
    );
  }

  // Check common candidates
  for (const candidate of candidates) {
    try {
      const st = await stat(candidate);
      if (st.isFile()) return cacheAndReturn(candidate);
    } catch {
      // Continue checking next candidate
    }
  }

  // 4. Fallback search through PATH environment variable directories
  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of pathDirs) {
    if (!dir || dir.trim() === "") continue;
    for (const ext of extensions) {
      const fullPath = join(dir.trim(), `${raw}${ext}`);
      try {
        const st = await stat(fullPath);
        if (st.isFile()) return cacheAndReturn(fullPath);
      } catch {
        // Continue
      }
    }
  }

  return cacheAndReturn(null);
}
