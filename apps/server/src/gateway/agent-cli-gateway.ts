// ============================================================================
// Finance Agent OS — Generic permissioned agent-CLI gateway
// Phase: shared execution gateway for agent CLIs (Cline is primary,
// OpenCode is a deprecated subclass). Agents / Desktop / API must route
// through a gateway — never spawn directly.
//
// Security policy (unchanged from the original OpenCode gateway):
// allowlist + metachar rejection + no-shell spawning (execFile argv arrays,
// stdin closed). Prompts are passed as a single argv element, never
// interpolated into shell strings. No secrets are ever logged.
// ============================================================================

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import type { TypedEventBus } from "@finance/core";

// ---------------------------------------------------------------------------
// Types (binary-agnostic)
// ---------------------------------------------------------------------------

export interface AgentCliInfo {
  cliPath: string | null;
  resolvedPath: string | null;
  exists: boolean;
  version: string | null;
  platform: string;
  candidates: string[];
  envOverride: string | null;
  timestamp: number;
}

export interface AgentCliGatewayConfig {
  enabled: boolean;
  cliPathOverride?: string;
  allowedCommands: string[];
  maxArgs: number;
  timeoutMs: number;
}

export interface AgentCliRunRequest {
  command?: string;
  args?: string[];
  agentId: string;
  correlationId?: string;
}

export interface AgentCliRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cliPath: string;
  command: string;
  durationMs: number;
  gated: { allowed: boolean; reason?: string };
}

export interface AgentCliGatewayStats {
  totalRuns: number;
  successRuns: number;
  rejectedRuns: number;
  lastRunAt: number | null;
  cliInfo: AgentCliInfo;
  allowedCommands: string[];
}

/**
 * Per-CLI wiring. All provider-specific behavior lives here — the core
 * gateway logic below never names a concrete CLI.
 */
export interface AgentCliDefinition {
  /** Binary name, e.g. "cline". */
  binary: string;
  /** npx package for the not-installed fallback, e.g. "cline". */
  npxPackage: string;
  /** Env toggle, e.g. "CLINE_GATEWAY_ENABLED". */
  enabledEnvVar: string;
  /** Gateway label, e.g. "cline-cli". */
  gatewayName: string;
  /** Bus event prefix + source, e.g. "cline" / "cline-gateway". */
  eventPrefix: string;
  source: string;
  /** Paths advertised to the finance gateway index. */
  financeGatewayPaths: string[];
  allowedCommands: readonly string[];
  /** Flags whose next argv token is a value (not the free-text prompt). */
  flagValueOptions: readonly string[];
  /**
   * Whether a bare prompt with no subcommand (e.g. `cline "do X"`) is
   * accepted as a one-shot run. False preserves the legacy strict behavior
   * (unknown first tokens are rejected as not-allowlisted).
   */
  allowBarePrompt: boolean;
  envCliPath(): string | null;
  needsShell(cliPath: string): boolean;
  resolveCliPath(override?: string): AgentCliInfo;
  probeVersion(cliPath: string, timeoutMs: number): Promise<string | null>;
}

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

export class AgentCliGateway {
  protected readonly def: AgentCliDefinition;
  protected config: AgentCliGatewayConfig;
  private totalRuns = 0;
  private successRuns = 0;
  private rejectedRuns = 0;
  private lastRunAt: number | null = null;
  private cliInfoCache: AgentCliInfo | null = null;
  private cliInfoCacheAt = 0;

  constructor(
    protected bus: TypedEventBus,
    def: AgentCliDefinition,
    config?: Partial<AgentCliGatewayConfig>,
  ) {
    this.def = def;
    this.config = {
      enabled: process.env[def.enabledEnvVar] !== "false",
      cliPathOverride: def.envCliPath() ?? undefined,
      allowedCommands: [...def.allowedCommands],
      maxArgs: 20,
      timeoutMs: 30_000,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // CLI path gateway
  // -------------------------------------------------------------------------

  async getCliInfo(force = false): Promise<AgentCliInfo> {
    const now = Date.now();
    if (!force && this.cliInfoCache && now - this.cliInfoCacheAt < 10_000) {
      return this.cliInfoCache;
    }
    const info = this.def.resolveCliPath(this.config.cliPathOverride);
    if (info.cliPath) info.version = await this.def.probeVersion(info.cliPath, 5000);
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
        const viaPath = await autoResolveCliPath(this.def.binary);
        if (viaPath) {
          info.cliPath = viaPath;
          info.resolvedPath = viaPath;
          info.exists = true;
          info.version = await this.def.probeVersion(viaPath, 5000);
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
    return this.def.resolveCliPath(this.config.cliPathOverride).cliPath;
  }

  getConfig(): Readonly<AgentCliGatewayConfig> {
    return { ...this.config };
  }

  getStats(): AgentCliGatewayStats {
    // use cached or fresh sync resolve for cliInfo
    const cliInfo =
      this.cliInfoCache ?? this.def.resolveCliPath(this.config.cliPathOverride);
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
    const info =
      this.cliInfoCache ?? this.def.resolveCliPath(this.config.cliPathOverride);
    return {
      gateway: this.def.gatewayName,
      enabled: this.config.enabled,
      cliPath: info.cliPath,
      resolvedPath: info.resolvedPath,
      exists: info.exists,
      platform: info.platform,
      // path gateways — each candidate is a gateway path that can be tried
      paths: info.candidates.map((p) => ({ path: p, exists: existsSync(p) })),
      allowedCommands: this.config.allowedCommands,
      financeGatewayPaths: [...this.def.financeGatewayPaths],
    };
  }

  // -------------------------------------------------------------------------
  // Permission check (mirrors FinanceGateway style)
  // -------------------------------------------------------------------------

  private checkAllowed(
    command: string | undefined,
    args: string[] | undefined,
  ): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: false, reason: `${this.def.enabledEnvVar}=false` };
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
    // A bare prompt (no subcommand, e.g. `cline "do X"`) is a one-shot run:
    // treat the whole input as free-text prompt with the relaxed check —
    // but only when the CLI definition opts in (legacy CLIs reject it).
    const barePrompt =
      !first.startsWith("-") &&
      first !== "run" &&
      argList[0] !== "run" &&
      !this.config.allowedCommands.includes(first);
    if (barePrompt && !this.def.allowBarePrompt) {
      return { allowed: false, reason: `command '${first}' not in allowed list: ${this.config.allowedCommands.join(", ")}` };
    }
    const isRun = first === "run" || argList[0] === "run" || barePrompt;
    // For runs, everything after flags/options is free-text prompt: only
    // block shell-dangerous chars (&;|`$<>\n\r), allow ?!.,:%* etc.
    // For other subcommands keep the strict set.
    const strictRe = /[;&|`$><\\(){}\[\]!%*?~\n\r]/;
    const promptRe = /[&;|`$<>\n\r]/;
    if (isRun) {
      const runIdx = argList[0] === "run" ? 0 : -1;
      // prompt starts at first non-flag token after `run` (or at 0 for bare)
      let promptIdx = argList.length;
      for (let i = runIdx + 1; i < argList.length; i++) {
        const t = argList[i]!;
        if (t.startsWith("-")) continue;
        // flags that take a value (per-CLI list)
        const prev = argList[i - 1];
        if (prev && (this.def.flagValueOptions as readonly string[]).includes(prev)) continue;
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
    // Allow if first token is in allowlist or starts with -- (bare one-shot
    // prompts were already accepted above via the relaxed prompt check).
    const base = first.replace(/^--/, "");
    const allowed =
      (isRun && this.def.allowBarePrompt) ||
      this.config.allowedCommands.includes(first) ||
      this.config.allowedCommands.includes(base) ||
      first.startsWith("--");
    if (!allowed) {
      return { allowed: false, reason: `command '${first}' not in allowed list: ${this.config.allowedCommands.join(", ")}` };
    }
    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // Run — permissioned execution via gateway
  // -------------------------------------------------------------------------

  async run(req: AgentCliRunRequest): Promise<AgentCliRunResult> {
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
    const p = this.def.eventPrefix;

    if (!gated.allowed) {
      this.rejectedRuns++;
      const cliInfo = await this.getCliInfo();
      this.bus.publish({
        type: `${p}.cli_rejected`,
        data: { command, args, agentId: req.agentId, reason: gated.reason, cliPath: cliInfo.cliPath },
        source: this.def.source,
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: gated.reason ?? "rejected",
        cliPath: cliInfo.cliPath ?? this.def.binary,
        command,
        durationMs: Date.now() - started,
        gated,
      };
    }

    const cliInfo = await this.getCliInfo();
    let cliPath = cliInfo.resolvedPath ?? cliInfo.cliPath ?? this.def.binary;
    let cliArgs = args;
    let useShellForCli = this.def.needsShell(cliPath);
    let npxFallback = false;
    if (!cliInfo.exists) {
      cliPath = "npx";
      cliArgs = [this.def.npxPackage, ...args];
      useShellForCli = false;
      npxFallback = true;
    }

    this.bus.publish({
      type: `${p}.cli_request`,
      data: { command, args, agentId: req.agentId, cliPath: npxFallback ? `npx ${this.def.npxPackage} ${command}` : cliPath },
      source: this.def.source,
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
          const res2 = await tryExec("npx", [this.def.npxPackage, ...args], true);
          stdout = String(res2.stdout);
          stderr = String(res2.stderr);
          cliPath = `npx ${this.def.npxPackage}`;
        } else {
          throw firstErr;
        }
      }
      this.successRuns++;
      this.lastRunAt = Date.now();
      const result: AgentCliRunResult = {
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
        type: `${p}.cli_response`,
        data: { ...result, agentId: req.agentId },
        source: this.def.source,
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return result;
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const isTimeout = e.killed === true;
      this.rejectedRuns++;
      this.lastRunAt = Date.now();
      const result: AgentCliRunResult = {
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
        type: `${p}.cli_response`,
        data: { ...result, agentId: req.agentId, error: true },
        source: this.def.source,
        agentId: req.agentId,
        correlationId: req.correlationId,
      });
      return result;
    }
  }
}
