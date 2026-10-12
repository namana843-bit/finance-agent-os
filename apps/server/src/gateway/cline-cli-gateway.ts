// ============================================================================
// Finance Agent OS — Cline CLI Path Gateway (PRIMARY agent gateway)
// Permissioned execution gateway for `cline`. Agents / Desktop / API must
// route through this gateway — never spawn directly.
//
// Security policy lives in the shared base (allowlist + metachar rejection +
// no-shell spawning); Cline-specific wiring (binary, allowlist, value flags)
// comes from the Cline adapter layer (cli/adapters/cline-paths.ts).
// Auth is reused from the local CLI (`cline auth`); no credentials in argv.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import {
  AgentCliGateway,
  type AgentCliGatewayConfig,
  type AgentCliGatewayStats,
  type AgentCliInfo,
  type AgentCliRunRequest,
  type AgentCliRunResult,
} from "./agent-cli-gateway.js";
import {
  CLINE_ALLOWED_COMMANDS,
  clineEnvCliPath,
  clineNeedsShell,
  probeClineVersion,
  resolveClineCliPath,
  type ClineCliInfo,
} from "../cli/adapters/cline-paths.js";

// Backward-compatible re-exports (legacy import paths keep working).
export { resolveClineCliPath };
export type { ClineCliInfo };

export type ClineGatewayConfig = AgentCliGatewayConfig;
export type ClineRunRequest = AgentCliRunRequest;
export type ClineRunResult = AgentCliRunResult;
export type ClineGatewayStats = AgentCliGatewayStats;

const CLINE_DEFINITION = {
  binary: "cline",
  npxPackage: "cline",
  enabledEnvVar: "CLINE_GATEWAY_ENABLED",
  gatewayName: "cline-cli",
  eventPrefix: "cline",
  source: "cline-gateway",
  financeGatewayPaths: [
    "/api/cline/cli-path",
    "/api/cline/run",
    "/api/cline/gateway/stats",
    "/api/gateways",
  ] as string[],
  allowedCommands: CLINE_ALLOWED_COMMANDS,
  // `cline [flags] [prompt]` — a bare prompt is a one-shot run.
  allowBarePrompt: true,
  // Flags that consume the next argv token as a value (per official CLI ref).
  flagValueOptions: [
    "--model", "-m",
    "--provider", "-P",
    "--cwd", "-c",
    "--timeout", "-t",
    "--config",
    "--data-dir",
    "--thinking",
    "--retries",
    "--hooks-dir",
    "--system", "-s",
    "--key", "-k",
    "--id",
    "--auto-approve",
  ] as readonly string[],
  envCliPath: () => clineEnvCliPath(),
  needsShell: (p: string) => clineNeedsShell(p),
  resolveCliPath: (o?: string) => resolveClineCliPath(o),
  probeVersion: (p: string, t: number) => probeClineVersion(p, t),
};

export class ClineCliGateway extends AgentCliGateway {
  constructor(bus: TypedEventBus, config?: Partial<ClineGatewayConfig>) {
    // `CLINE_GATEWAY_ENABLED` unset → fall back to the legacy
    // `OPENCODE_GATEWAY_ENABLED` toggle during the migration.
    const enabled =
      config?.enabled ??
      (process.env.CLINE_GATEWAY_ENABLED !== undefined
        ? process.env.CLINE_GATEWAY_ENABLED !== "false"
        : process.env.OPENCODE_GATEWAY_ENABLED !== "false");
    super(bus, CLINE_DEFINITION, { ...config, enabled });
  }
}
