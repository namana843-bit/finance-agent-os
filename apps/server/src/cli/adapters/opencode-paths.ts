// ============================================================================
// Finance Agent OS — OpenCode executable discovery + protocol constants
// All OpenCode-specific path knowledge lives here (and only here):
// candidate locations, env override, version probe, allowlist, daemon flags.
// Consumed by OpenCodeAdapter, OpencodeDaemonManager and the CLI gateway.
// ============================================================================

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import { cliPathEnvOverride } from "../resolver.js";

const execFileAsync = promisify(execFile);

export interface OpencodeCliInfo {
  cliPath: string | null;
  resolvedPath: string | null;
  exists: boolean;
  version: string | null;
  platform: string;
  candidates: string[];
  envOverride: string | null;
  timestamp: number;
}

/** Command allowlist for the permissioned gateway (`opencode <command>`). */
export const OPENCODE_ALLOWED_COMMANDS = [
  "--help",
  "--version",
  "-v",
  "-h",
  "completion",
  "models",
  "providers",
  "stats",
  "export",
  "session",
  "agent",
  "run",
  "serve",
  "web",
  "debug",
] as const;

/** Default argv template for one-shot agent runs. */
export const OPENCODE_DEFAULT_RUN_ARGS = ["run", "--auto", "{prompt}"];

export const OPENCODE_DAEMON_DEFAULT_PORT = 4096;
export const OPENCODE_DAEMON_DEFAULT_HOSTNAME = "127.0.0.1";

/** Candidate locations — cross-platform (Windows npm/pnpm shims, Unix, workspace). */
export function opencodeCandidatePaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  const pnpmHome = process.env.PNPM_HOME || path.join(home, "AppData", "Local", "pnpm");
  // Prefer native .exe over .cmd wrapper on Windows for execFile without shell
  candidates.push(
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(home, "AppData", "Roaming", "npm", "opencode.cmd"),
    path.join(home, "AppData", "Roaming", "npm", "opencode"),
    path.join(home, "AppData", "Roaming", "npm", "opencode.ps1"),
    path.join(pnpmHome, "opencode.exe"),
    path.join(pnpmHome, "opencode.cmd"),
    path.join(home, ".opencode", "bin", "opencode.exe"),
    path.join(home, ".opencode", "bin", "opencode.cmd"),
    path.join(process.cwd(), "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(process.cwd(), "node_modules", ".bin", "opencode.cmd"),
  );
  // workspace-local
  candidates.push(
    path.resolve("node_modules/.bin/opencode"),
    path.resolve("node_modules/.bin/opencode.cmd"),
  );
  // Unix global
  candidates.push("/usr/local/bin/opencode", "/usr/bin/opencode", "/opt/homebrew/bin/opencode");
  return candidates;
}

/** Env override — `OPENCODE_CLI_PATH` (explicit, validated by the resolver). */
export function opencodeEnvCliPath(): string | null {
  return cliPathEnvOverride("opencode", "OPENCODE_CLI_PATH");
}

/** Synchronous local resolution used by the gateway + daemon (legacy shape). */
export function resolveOpencodeCliPath(override?: string): OpencodeCliInfo {
  const envOverride = override ?? opencodeEnvCliPath();
  const candidates = opencodeCandidatePaths();
  const allCandidates = envOverride ? [envOverride, ...candidates] : candidates;
  let resolved: string | null = null;
  for (const candidate of allCandidates) {
    if (candidate && existsSync(candidate)) {
      resolved = candidate;
      break;
    }
  }
  // If no file exists, still return first candidate that would be on PATH —
  // the exec fallback tries `opencode` via PATH.
  const cliPath = resolved ?? (envOverride || candidates[0]!);
  return {
    cliPath,
    resolvedPath: resolved,
    exists: Boolean(resolved),
    version: null,
    platform: os.platform(),
    candidates: allCandidates,
    envOverride,
    timestamp: Date.now(),
  };
}

/** OS wrappers need a shell on Windows. */
export function opencodeNeedsShell(cliPath: string): boolean {
  return cliPath.endsWith(".cmd") || cliPath.endsWith(".ps1") || cliPath.endsWith(".bat");
}

/** `opencode --version` with PATH + `npx opencode` fallbacks (never throws). */
export async function probeOpencodeVersion(
  cliPath: string,
  timeoutMs: number,
): Promise<string | null> {
  const shell = opencodeNeedsShell(cliPath);
  const run = async (file: string, args: string[], useShell: boolean) => {
    const { stdout } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: useShell as never,
    });
    return stdout.trim().split("\n")[0] ?? null;
  };
  try {
    return await run(cliPath, ["--version"], shell);
  } catch {
    try {
      return await run("opencode", ["--version"], shell);
    } catch {
      try {
        return await run("npx", ["opencode", "--version"], true);
      } catch {
        return null;
      }
    }
  }
}

/** `opencode serve …` argv for daemon mode. */
export function buildOpencodeDaemonArgs(
  port: number,
  hostname: string,
  pure: boolean,
): string[] {
  const args = ["serve", "--port", String(port), "--hostname", hostname];
  if (pure) args.push("--pure");
  return args;
}

/** Insert `--attach <daemonUrl>` right after the `run` subcommand (persistent mode). */
export function insertOpencodeDaemonAttach(args: string[], daemonUrl: string): string[] {
  const next = [...args];
  const runIndex = next.indexOf("run");
  if (runIndex !== -1) {
    next.splice(runIndex + 1, 0, "--attach", daemonUrl);
  }
  return next;
}

/** One-shot + daemon: `run --attach <url> --pure …` (legacy one-shot ordering). */
export function insertOpencodeOneShotDaemonAttach(
  args: string[],
  daemonUrl: string,
): string[] {
  const next = [...args];
  const runIndex = next.indexOf("run");
  if (runIndex !== -1) {
    next.splice(runIndex + 1, 0, "--attach", daemonUrl, "--pure");
  }
  return next;
}
