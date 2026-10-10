// ============================================================================
// Finance Agent OS — OpenCode CLI Path Gateway
// Phase: permissioned execution gateway for `opencode`.
// Agents / Desktop / API must route through this gateway — never spawn directly.
//
// Since the CLI adapter refactor this gateway contains NO OpenCode path/args/
// protocol knowledge: discovery, version probing and the command allowlist all
// come from the OpenCode adapter layer (cli/adapters/opencode-paths.ts). The
// security policy (allowlist + metachar rejection + no-shell spawning) lives
// here and is unchanged.
// ============================================================================

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TypedEventBus } from "@finance/core";
import {
  OPENCODE_ALLOWED_COMMANDS,
  opencodeEnvCliPath,
  opencodeNeedsShell as needsShell,
  probeOpencodeVersion,
  resolveOpencodeCliPath,
} from "../cli/adapters/opencode-paths.js";
import type { OpencodeCliInfo } from "../cli/adapters/opencode-paths.js";

// Backward-compatible re-exports (legacy import paths keep working).
export { resolveOpencodeCliPath };
export type { OpencodeCliInfo };

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
      cliPathOverride: opencodeEnvCliPath() ?? undefined,
      allowedCommands: [...OPENCODE_ALLOWED_COMMANDS],
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
    if (info.cliPath) info.version = await probeOpencodeVersion(info.cliPath, 5000);
    // if PATH fallback worked, mark exists true when version found
    if (!info.exists && info.version) {
      info.exists = true;
      info.resolvedPath = info.cliPath;
    }
    // PATH fallback: sync candidates miss shims on PATH (e.g. different
    // APPDATA in service env). Try async resolver (`where`/`which` + PATH
    // scan) before giving up to `npx`.
    if (!info.exists && !info.version) {
      try {
        const { autoResolveCliPath } = await import("../cli/resolver.js");
        const viaPath = await autoResolveCliPath("opencode");
        if (viaPath) {
          info.cliPath = viaPath;
          info.resolvedPath = viaPath;
          info.exists = true;
          info.version = await probeOpencodeVersion(viaPath, 5000);
        }
      } catch {
        // ignore — npx fallback in run() still applies
      }
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
    // Normalize: prefer explicit args; if only a command string was given,
    // treat the first token as the subcommand and the remainder as a single
    // free-text prompt (do NOT split the prompt on whitespace).
    let argList = args ?? [];
    let cmdToken = (command ?? "").trim();
    if (argList.length === 0 && cmdToken) {
      const tokens = cmdToken.split(/\s+/).filter(Boolean);
      const first = tokens[0] ?? "";
      const rest = tokens.slice(1).join(" ");
      argList = rest ? [first, rest] : [first];
      cmdToken = first;
    }
    const first = cmdToken || argList[0] || "";
    if (!first) {
      return { allowed: false, reason: "command is required" };
    }
    if ((argList.length ?? 0) > this.config.maxArgs) {
      return { allowed: false, reason: `too many args (max ${this.config.maxArgs})` };
    }
    const isRun = first === "run" || argList[0] === "run";
    // For `run`, everything after flags/options is free-text prompt: only
    // block shell-dangerous chars (&;|`$<>\n\r), allow ?!.,:%* etc.
    // For other subcommands keep the strict set.
    const strictRe = /[;&|`$><\\(){}\[\]!%*?~\n\r]/;
    const promptRe = /[&;|`$<>\n\r]/;
    if (isRun) {
      const runIdx = argList[0] === "run" ? 0 : -1;
      // prompt starts at first non-flag token after `run`
      let promptIdx = argList.length;
      for (let i = runIdx + 1; i < argList.length; i++) {
        const t = argList[i]!;
        if (t.startsWith("-")) continue;
        // `--agent <name>` / `--model <m>` / `--attach <url>` take a value
        const prev = argList[i - 1];
        if (prev === "--agent" || prev === "--model" || prev === "--attach" || prev === "--dir" || prev === "--session" || prev === "--command" || prev === "--title" || prev === "--format") continue;
        promptIdx = i;
        break;
      }
      const prefix = argList.slice(0, promptIdx).join(" ");
      if (strictRe.test(prefix)) {
        return { allowed: false, reason: "shell metacharacters not allowed" };
      }
      const safeArgRe = /^[a-zA-Z0-9._\-/:@=+,]+$/;
      for (const a of argList.slice(0, promptIdx)) {
        if (a.startsWith("--")) continue;
        if (a === "run") continue;
        if (a.startsWith("-") && a.length <= 12 && safeArgRe.test(a)) continue;
        if (!safeArgRe.test(a) && !this.config.allowedCommands.includes(a)) {
          // allow flag values (agent names, urls, models) with a looser check
          if (/^[a-zA-Z0-9._\-/:@=+,]+$/.test(a) || /^https?:\/\/\S+$/.test(a)) continue;
          return { allowed: false, reason: "arg '" + a + "' contains illegal characters or not in allowlist" };
        }
      }
      const prompt = argList.slice(promptIdx).join(" ");
      if (promptRe.test(command ?? prompt)) {
        return { allowed: false, reason: "shell metacharacters not allowed in prompt" };
      }
    } else {
      const joined = [cmdToken, ...argList].join(" ");
      if (strictRe.test(joined)) {
        return { allowed: false, reason: "shell metacharacters not allowed" };
      }
      const safeArgRe = /^[a-zA-Z0-9._\-/:@=+,]+$/;
      for (const a of argList ?? []) {
        if (a.startsWith("--")) continue;
        if (a.startsWith("-") && a.length <= 8 && safeArgRe.test(a)) continue;
        if (!safeArgRe.test(a) && !this.config.allowedCommands.includes(a)) {
          return { allowed: false, reason: "arg '" + a + "' contains illegal characters or not in allowlist" };
        }
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
    // Same normalization as checkAllowed: bare command string keeps the
    // prompt as ONE arg instead of splitting it on whitespace.
    let args = req.args ?? [];
    if (args.length === 0 && req.command) {
      const tokens = req.command.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0] ?? "";
      const rest = tokens.slice(1).join(" ");
      args = rest ? [first, rest] : first ? [first] : [];
    }
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
