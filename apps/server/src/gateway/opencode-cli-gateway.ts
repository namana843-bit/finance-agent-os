// ============================================================================
// Finance Agent OS — OpenCode CLI Path Gateway (DEPRECATED compatibility shim)
// Cline is now the primary agent CLI. This module preserves every legacy
// export and behavior by subclassing the shared AgentCliGateway with the
// OpenCode definition. New code must use `gateway/cline-cli-gateway.js`.
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
  OPENCODE_ALLOWED_COMMANDS,
  opencodeEnvCliPath,
  opencodeNeedsShell,
  probeOpencodeVersion,
  resolveOpencodeCliPath,
  type OpencodeCliInfo,
} from "../cli/adapters/opencode-paths.js";

// Backward-compatible re-exports (legacy import paths keep working).
export { resolveOpencodeCliPath };
export type { OpencodeCliInfo };

export type OpencodeGatewayConfig = AgentCliGatewayConfig;
export type OpencodeRunRequest = AgentCliRunRequest;
export type OpencodeRunResult = AgentCliRunResult;
export type OpencodeGatewayStats = AgentCliGatewayStats;

const OPENCODE_DEFINITION = {
  binary: "opencode",
  npxPackage: "opencode",
  enabledEnvVar: "OPENCODE_GATEWAY_ENABLED",
  gatewayName: "opencode-cli",
  eventPrefix: "opencode",
  source: "opencode-gateway",
  financeGatewayPaths: [
    "/api/opencode/cli-path",
    "/api/opencode/run",
    "/api/opencode/gateway/stats",
    "/api/gateways",
  ] as string[],
  allowedCommands: OPENCODE_ALLOWED_COMMANDS,
  // Legacy behavior: bare prompts are rejected (unknown first token).
  allowBarePrompt: false,
  flagValueOptions: [
    "--agent",
    "--model",
    "--attach",
    "--dir",
    "--session",
    "--command",
    "--title",
    "--format",
  ] as readonly string[],
  envCliPath: () => opencodeEnvCliPath(),
  needsShell: (p: string) => opencodeNeedsShell(p),
  resolveCliPath: (o?: string): AgentCliInfo => resolveOpencodeCliPath(o) as unknown as AgentCliInfo,
  probeVersion: (p: string, t: number) => probeOpencodeVersion(p, t),
};

/** @deprecated Use ClineCliGateway (gateway/cline-cli-gateway.js) instead. */
export class OpencodeCliGateway extends AgentCliGateway {
  constructor(bus: TypedEventBus, config?: Partial<OpencodeGatewayConfig>) {
    super(bus, OPENCODE_DEFINITION, config);
  }
}
