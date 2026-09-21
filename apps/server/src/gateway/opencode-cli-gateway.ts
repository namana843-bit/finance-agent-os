// ============================================================================
// Finance Agent OS — OpenCode CLI Path Gateway
// Phase: CLI path resolution + permissioned execution gateway for `opencode`
// Agents / Desktop / API must route through this gateway — never spawn directly.
// Cross-platform: Windows (opencode.cmd / .ps1 / bin/opencode.exe) / Linux / Docker
// ============================================================================

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import type { TypedEventBus } from "@finance/core";

function execFileAsync(
  file: string,
  args: string[],
  options: { timeout?: number; windowsHide?: boolean; maxBuffer?: number; shell?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface OpencodeGatewayConfig {
  enabled: boolean;
  cliPathOverride?: string;
  allowedCommands: string[];
  maxArgs: number;
  timeoutMs: number;
}

export interface OpencodeRunRequest {
  command?: string;
  args?: string[];
  agentId: string;
  correlationId?: string;
}

export interface OpencodeRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cliPath: string;
  command: string;
  durationMs: number;
  gated: { allowed: boolean; reason?: string };
}

export interface OpencodeGatewayStats {
  totalRuns: number;
  successRuns: number;
  rejectedRuns: number;
  lastRunAt: number | null;
  cliInfo: OpencodeCliInfo;
  allowedCommands: string[];
}

// ---------------------------------------------------------------------------
// Path resolution — cross-platform
// ---------------------------------------------------------------------------

function candidatePaths(): string[] {
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
    path.join(process.cwd(), "node_modules", ".bin", "opencode"),
    path.join(process.cwd(), "node_modules", ".bin", "opencode.cmd"),
  );
  // workspace-local
  candidates.push(
    path.resolve("node_modules/.bin/opencode"),
    path.resolve("node_modules/.bin/opencode.cmd"),
  );
  // Unix global
  candidates.push("/usr/local/bin/opencode", "/usr/bin/opencode", "/opt/homebrew/bin/opencode");
  // where / which fallback will be probed dynamically, but keep PATH lookup
  return candidates;
}

function envCliPath(): string | null {
  return process.env.OPENCODE_CLI_PATH?.trim() || null;
}

export function resolveOpencodeCliPath(override?: string): OpencodeCliInfo {
  const envOverride = override ?? envCliPath();
  const candidates = candidatePaths();
  const allCandidates = envOverride ? [envOverride, ...candidates] : candidates;
  let resolved: string | null = null;
  for (const p of allCandidates) {
    if (p && existsSync(p)) {
      resolved = p;
      break;
    }
  }
  // If no file exists, still return first candidate that would be on PATH
  // The exec fallback will try `opencode` via PATH
  const cliPath = resolved ?? (envOverride || candidates[0]!);
  return {
    cliPath,
    resolvedPath: resolved,
    exists: !!resolved,
    version: null,
    platform: os.platform(),
    candidates: allCandidates,
    envOverride,
    timestamp: Date.now(),
  };
}

function needsShell(cliPath: string): boolean {
  return cliPath.endsWith(".cmd") || cliPath.endsWith(".ps1") || cliPath.endsWith(".bat");
}

async function probeVersion(cliPath: string, timeoutMs: number): Promise<string | null> {
  const shell = needsShell(cliPath);
  try {
    const { stdout } = await execFileAsync(cliPath, ["--version"], { timeout: timeoutMs, windowsHide: true, shell: shell as never });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    try {
      const { stdout } = await execFileAsync("opencode", ["--version"], { timeout: timeoutMs, windowsHide: true, shell: shell as never });
      return stdout.trim().split("\n")[0] ?? null;
    } catch {
      try {
        const { stdout } = await execFileAsync("npx", ["opencode", "--version"], { timeout: timeoutMs, windowsHide: true, shell: true as never });
        return stdout.trim().split("\n")[0] ?? null;
      } catch {
        return null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED = [
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
];

export class OpencodeCliGateway {
  private config: OpencodeGatewayConfig;
  private totalRuns = 0;
  private successRuns = 0;
  private rejectedRuns = 0;
  private lastRunAt: number | null = null;
  private cliInfoCache: OpencodeCliInfo | null = null;
  private cliInfoCacheAt = 0;

  constructor(
    private bus: TypedEventBus,
    config?: Partial<OpencodeGatewayConfig>,
  ) {
    this.config = {
      enabled: process.env.OPENCODE_GATEWAY_ENABLED !== "false",
      cliPathOverride: envCliPath() ?? undefined,
      allowedCommands: DEFAULT_ALLOWED,
      maxArgs: 20,
      timeoutMs: 30_000,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // CLI path gateway
  // -------------------------------------------------------------------------

  async getCliInfo(force = false): Promise<OpencodeCliInfo> {
    const now = Date.now();
    if (!force && this.cliInfoCache && now - this.cliInfoCacheAt < 10_000) {
      return this.cliInfoCache;
    }
    const info = resolveOpencodeCliPath(this.config.cliPathOverride);
    if (info.cliPath) info.version = await probeVersion(info.cliPath, 5000);
    // if PATH fallback worked, mark exists true when version found
    if (!info.exists && info.version) {
      info.exists = true;
      info.resolvedPath = info.cliPath;
    }
    this.cliInfoCache = info;
    this.cliInfoCacheAt = now;
    return info;
  }

  getCliPathSync(): string | null {
    return resolveOpencodeCliPath(this.config.cliPathOverride).cliPath;
  }

  getConfig(): Readonly<OpencodeGatewayConfig> {
    return { ...this.config };
  }

  getStats(): OpencodeGatewayStats {
    // use cached or fresh sync resolve for cliInfo
    const cliInfo = this.cliInfoCache ?? resolveOpencodeCliPath(this.config.cliPathOverride);
    return {
      totalRuns: this.totalRuns,
      successRuns: this.successRuns,
      rejectedRuns: this.rejectedRuns,
      lastRunAt: this.lastRunAt,
      cliInfo,
      allowedCommands: [...this.config.allowedCommands],
    };
  }

  listPathGateways() {
    const info = this.cliInfoCache ?? resolveOpencodeCliPath(this.config.cliPathOverride);
    return {
      gateway: "opencode-cli",
      enabled: this.config.enabled,
      cliPath: info.cliPath,
      resolvedPath: info.resolvedPath,
      exists: info.exists,
      platform: info.platform,
      // path gateways — each candidate is a gateway path that can be tried
      paths: info.candidates.map((p) => ({ path: p, exists: existsSync(p) })),
      allowedCommands: this.config.allowedCommands,
      financeGatewayPaths: ["/api/opencode/cli-path", "/api/opencode/run", "/api/opencode/gateway/stats", "/api/gateways"],
    };
  }

  // -------------------------------------------------------------------------
  // Permission check (mirrors FinanceGateway style)
  // -------------------------------------------------------------------------

  private checkAllowed(command: string | undefined, args: string[] | undefined): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: false, reason: "OPENCODE_GATEWAY_ENABLED=false" };
    }
    const cmd = (command ?? args?.[0] ?? "").trim();
    // Bare `--version` / `--help` without subcommand
    const first = cmd || args?.[0] || "";
    if (!first) {
      return { allowed: false, reason: "command is required" };
    }
    // Block shell metachars — extended set
    const joined = [command, ...(args ?? [])].join(" ");
    if (/[;&|`$><\\(){}\[\]!%*?~\n\r]/.test(joined)) {
      return { allowed: false, reason: "shell metacharacters not allowed" };
    }
    if ((args?.length ?? 0) > this.config.maxArgs) {
      return { allowed: false, reason: `too many args (max ${this.config.maxArgs})` };
    }
    const safeArgRe = /^[a-zA-Z0-9._\-/:@=+,]+$/;
    for (const a of args ?? []) {
      if (a.startsWith("--")) continue;
      if (a.startsWith("-") && a.length <= 8 && safeArgRe.test(a)) continue;
      if (!safeArgRe.test(a) && !this.config.allowedCommands.includes(a)) {
        return { allowed: false, reason: "arg '" + a + "' contains illegal characters or not in allowlist" };
      }
    }
    // Allow if first token is in allowlist or starts with --
    const base = first.replace(/^--/, "");
    const allowed = this.config.allowedCommands.includes(first) || this.config.allowedCommands.includes(base) || first.startsWith("--");
    if (!allowed) {
      return { allowed: false, reason: `command '${first}' not in allowed list: ${this.config.allowedCommands.join(", ")}` };
    }
    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // Run — permissioned execution via gateway
  // -------------------------------------------------------------------------

  async run(req: OpencodeRunRequest): Promise<OpencodeRunResult> {
    this.totalRuns++;
    const started = Date.now();
    const args = req.args ?? (req.command ? req.command.trim().split(/\s+/).filter(Boolean) : []);
    const command = req.command ?? args.join(" ");
    const gated = this.checkAllowed(req.command, args);

    if (!gated.allowed) {
      this.rejectedRuns++;
      const cliInfo = await this.getCliInfo();
      this.bus.publish({
        type: "opencode.cli_rejected",
        data: { command, args, agentId: req.agentId, reason: gated.reason, cliPath: cliInfo.cliPath },
        source: "opencode-gateway",
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: gated.reason ?? "rejected",
        cliPath: cliInfo.cliPath ?? "opencode",
        command,
        durationMs: Date.now() - started,
        gated,
      };
    }

    const cliInfo = await this.getCliInfo();
    let cliPath = cliInfo.resolvedPath ?? cliInfo.cliPath ?? "opencode";
    let cliArgs = args;
    let useShellForCli = needsShell(cliPath);
    let npxFallback = false;
    if (!cliInfo.exists) {
      cliPath = "npx";
      cliArgs = ["opencode", ...args];
      useShellForCli = false;
      npxFallback = true;
    }

    this.bus.publish({
      type: "opencode.cli_request",
      data: { command, args, agentId: req.agentId, cliPath: npxFallback ? `npx opencode ${command}` : cliPath },
      source: "opencode-gateway",
      agentId: req.agentId,
      correlationId: req.correlationId,
    });

    const tryExec = async (cPath: string, cArgs: string[], shell: boolean) =>
      execFileAsync(cPath, cArgs, {
        timeout: this.config.timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        shell: shell as never,
      });

    try {
      let stdout: string;
      let stderr: string;
      try {
        const res = await tryExec(cliPath, cliArgs, useShellForCli);
        stdout = String(res.stdout);
        stderr = String(res.stderr);
      } catch (firstErr: unknown) {
        const msg = String((firstErr as { message?: string })?.message ?? "");
        const isNotFound = /ENOENT|not found|not recognized/i.test(msg);
        if (!npxFallback && isNotFound) {
          const res2 = await tryExec("npx", ["opencode", ...args], true);
          stdout = String(res2.stdout);
          stderr = String(res2.stderr);
          cliPath = "npx opencode";
        } else {
          throw firstErr;
        }
      }
      this.successRuns++;
      this.lastRunAt = Date.now();
      const result: OpencodeRunResult = {
        ok: true,
        exitCode: 0,
        stdout: String(stdout),
        stderr: String(stderr),
        cliPath,
        command,
        durationMs: Date.now() - started,
        gated: { allowed: true },
      };
      this.bus.publish({
        type: "opencode.cli_response",
        data: { ...result, agentId: req.agentId },
        source: "opencode-gateway",
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return result;
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const isTimeout = e.killed === true;
      this.rejectedRuns++;
      this.lastRunAt = Date.now();
      const result: OpencodeRunResult = {
        ok: false,
        exitCode: e.code ?? 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? String(err)) + (isTimeout ? " (timeout)" : ""),
        cliPath,
        command,
        durationMs: Date.now() - started,
        gated: { allowed: true },
      };
      this.bus.publish({
        type: "opencode.cli_response",
        data: { ...result, agentId: req.agentId, error: true },
        source: "opencode-gateway",
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return result;
    }
  }
}
