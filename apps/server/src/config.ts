import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import {
  applySandboxEnv,
  getSandboxState,
  isTestModeEnabled,
  resolveSandboxPort,
  writeSandboxMarker,
  type SandboxState,
} from "./test-mode/sandbox.js";

// ---------------------------------------------------------------------------
// Test / simulation sandbox bootstrap.
// Must run BEFORE DATA_DIR is computed so every downstream persistence root
// (order-manager, agent-memory, core/storage, llm persistence, …) resolves
// into the isolated sandbox instead of the production data dir.
// Enable with FINANCE_TEST_MODE=true (see test-mode/sandbox.ts for all flags).
// ---------------------------------------------------------------------------
export const SANDBOX: SandboxState = applySandboxEnv();
if (SANDBOX.enabled) {
  writeSandboxMarker(SANDBOX.sandboxDir);
  console.log(
    `[test-mode] sandbox active — dataDir=${SANDBOX.dataDir} executionMode=paper liveTradingEnabled=false port=${SANDBOX.port}`,
  );
}

export { isTestModeEnabled, getSandboxState };
export type { SandboxState };

export const DATA_DIR = process.env.FINANCE_DATA_DIR || process.env.OMB_DATA_DIR || join(homedir(), ".finance-agent");

const PRODUCTION_DEFAULT_PORT = 4132;
export const DEFAULT_PORT = Number(
  process.env.PORT || process.env.FINANCE_PORT || (SANDBOX.enabled ? resolveSandboxPort() : PRODUCTION_DEFAULT_PORT),
);


export interface AppConfig {
  port?: number;
  host?: string;
  executionMode?: "paper" | "live";
  dataDir?: string;
  cliStartup?: {
    access: "local" | "tunnel" | "tailscale" | "public-url";
    publicUrl?: string;
    phone?: "ios" | "android";
  };
  box?: { token?: string };
  signIn?: { admins: string[]; members: string[] };
  finance?: {
    defaultSymbol?: string;
    paperCapital?: number;
    riskPerTradePct?: number;
    pollMs?: number;
  };
  llm?: Record<string, unknown>;
}

function parseConfig(raw: string): AppConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as AppConfig;
  } catch { return {}; }
}

export function loadConfig(dataDir = DATA_DIR): AppConfig {
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) return {};
  try { return parseConfig(readFileSync(file, "utf8")); } catch { return {}; }
}

export function saveConfig(config: AppConfig, dataDir = DATA_DIR): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "config.json");
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function configPath(dataDir = DATA_DIR): string {
  return join(dataDir, "config.json");
}

export function ensureDataDir(dataDir = DATA_DIR): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

export function loadEnvironmentId(dataDir = DATA_DIR): string {
  const file = join(dataDir, "environment-id");
  if (existsSync(file)) {
    try { const id = readFileSync(file, "utf8").trim(); if (/^[0-9a-f-]{36}$/i.test(id)) return id; } catch { /* ignore */ }
  }
  const id = crypto.randomUUID();
  try { ensureDataDir(dataDir); writeFileAtomic(file, `${id}\n`, { mode: 0o600 }); } catch { /* best-effort */ }
  return id;
}
