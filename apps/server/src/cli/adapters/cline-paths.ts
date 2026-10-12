// ============================================================================
// Finance Agent OS — Cline executable discovery + protocol constants
// All Cline-specific path knowledge lives here (and only here):
// candidate locations, env override, version probe, allowlist.
// Consumed by ClineAdapter and the Cline CLI gateway.
// Flags verified against the official Cline CLI reference
// (https://docs.cline.bot/cli, `cline --help` is the source of truth):
// one-shot `cline [--json] [--model <id>] [--provider <id>] [--cwd <path>]
// [--timeout <s>] [prompt]`, auth via `cline auth` (no credentials in argv).
// ============================================================================

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import { cliPathEnvOverride } from "../resolver.js";

const execFileAsync = promisify(execFile);

export interface ClineCliInfo {
  cliPath: string | null;
  resolvedPath: string | null;
  exists: boolean;
  version: string | null;
  platform: string;
  candidates: string[];
  envOverride: string | null;
  timestamp: number;
}

/**
 * Command allowlist for the permissioned gateway (`cline <command>`).
 * Subcommands per the official CLI reference: auth, config, connect, mcp,
 * dev, hub, update, version, kanban, task, instance, schedule, history,
 * doctor. A bare prompt (no subcommand) runs a one-shot task.
 */
export const CLINE_ALLOWED_COMMANDS = [
  "--help",
  "--version",
  "-V",
  "-h",
  "auth",
  "config",
  "connect",
  "mcp",
  "dev",
  "hub",
  "update",
  "version",
  "kanban",
  "task",
  "instance",
  "schedule",
  "history",
  "doctor",
] as const;

/**
 * Default argv template for one-shot agent runs.
 * `--json` yields newline-delimited JSON messages (`{"type":"say","text":…}`)
 * which the shared parser normalizes to text deltas; unknown shapes fall back
 * to plain text. The prompt is always passed as a single argv element —
 * never interpolated into a shell string.
 */
export const CLINE_DEFAULT_RUN_ARGS = ["--json", "{prompt}"];

/** Candidate locations — cross-platform (npm/pnpm shims, Unix, workspace). */
export function clineCandidatePaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  const pnpmHome =
    process.env.PNPM_HOME || path.join(home, "AppData", "Local", "pnpm");
  // Prefer native .exe over .cmd wrapper on Windows for execFile without shell
  candidates.push(
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "cline", "dist", "index.js"),
    path.join(home, "AppData", "Roaming", "npm", "cline.cmd"),
    path.join(home, "AppData", "Roaming", "npm", "cline"),
    path.join(home, "AppData", "Roaming", "npm", "cline.ps1"),
    path.join(pnpmHome, "cline.exe"),
    path.join(pnpmHome, "cline.cmd"),
    path.join(process.cwd(), "node_modules", "cline", "dist", "index.js"),
    path.join(process.cwd(), "node_modules", ".bin", "cline.cmd"),
  );
  // workspace-local
  candidates.push(
    path.resolve("node_modules/.bin/cline"),
    path.resolve("node_modules/.bin/cline.cmd"),
  );
  // Unix global
  candidates.push("/usr/local/bin/cline", "/usr/bin/cline", "/opt/homebrew/bin/cline");
  return candidates;
}

/**
 * Env override — `CLINE_CLI_PATH` (explicit, validated by the resolver).
 * `OPENCODE_CLI_PATH` is honoured as a deprecated fallback so existing
 * deployments keep resolving during the migration.
 */
export function clineEnvCliPath(): string | null {
  return (
    cliPathEnvOverride("cline", "CLINE_CLI_PATH") ??
    cliPathEnvOverride("cline", "OPENCODE_CLI_PATH")
  );
}

/** Synchronous local resolution used by the gateway (legacy shape). */
export function resolveClineCliPath(override?: string): ClineCliInfo {
  const envOverride = override ?? clineEnvCliPath();
  const candidates = clineCandidatePaths();
  const allCandidates = envOverride ? [envOverride, ...candidates] : candidates;
  let resolved: string | null = null;
  for (const candidate of allCandidates) {
    if (candidate && existsSync(candidate)) {
      resolved = candidate;
      break;
    }
  }
  // If no file exists, still return first candidate that would be on PATH —
  // the exec fallback tries `cline` via PATH.
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
export function clineNeedsShell(cliPath: string): boolean {
  return cliPath.endsWith(".cmd") || cliPath.endsWith(".ps1") || cliPath.endsWith(".bat");
}

/** `cline --version` with PATH fallback (never throws). */
export async function probeClineVersion(
  cliPath: string,
  timeoutMs: number,
): Promise<string | null> {
  const shell = clineNeedsShell(cliPath);
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
      return await run("cline", ["--version"], shell);
    } catch {
      return null;
    }
  }
}
