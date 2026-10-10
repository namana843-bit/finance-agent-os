// ============================================================================
// Finance Agent OS — Test / Simulation Sandbox
// Isolated execution mode for running test scenarios *concurrently* with a
// normal production instance without any interference.
//
// Guarantees provided when the sandbox is enabled (see isTestModeEnabled):
//   1. DATA ISOLATION  — every persisted artefact (orders.json, agent-memory,
//      traces.jsonl, engines.json, usage.json, agents.json, conversations/,
//      channels/threads/messages, state.json) is redirected into
//      `<base>/test-sandbox[/<runId>]` instead of the production data dir.
//   2. LIVE-TRADING HARD BLOCK — LIVE_TRADING_ENABLED is forced to "false" and
//      EXECUTION_MODE to "paper" (never "live"). The execution pipeline also
//      carries a non-bypassable sandboxMode flag, so a live path cannot be
//      re-enabled at runtime even if the env var is flipped afterwards.
//   3. PORT ISOLATION — the default HTTP port is shifted off the production
//      default so both servers can run side by side. With FINANCE_TEST_RUN_ID
//      set, the port is derived deterministically from the run id.
//   4. NETWORK ISOLATION — MarketAgent switches to synthetic ticks and the
//      runtime wires a deterministic SimulatedMarket adapter (no Binance REST/WS).
//
// Env flags (any one enables the sandbox; see TEST_MODE_FLAGS):
//   FINANCE_TEST_MODE=true | FINANCE_SIMULATION_MODE=true | SIMULATION_MODE=true
//   SANDBOX_MODE=true        | FINANCE_RUN_MODE=test|sim|simulation|sandbox
//
// Optional knobs:
//   FINANCE_TEST_DATA_DIR  — absolute sandbox root (overrides the default)
//   FINANCE_TEST_RUN_ID    — scopes a concurrent run into its own sub-dir + port
//
// IMPORTANT: this module must never import ../config.js (config imports it).
// ============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../atomic.js";

/** Env vars that switch the process into the isolated test/simulation sandbox. */
export const TEST_MODE_FLAGS = [
  "FINANCE_TEST_MODE",
  "FINANCE_SIMULATION_MODE",
  "SIMULATION_MODE",
  "SANDBOX_MODE",
] as const;

/** Alternate switch: FINANCE_RUN_MODE=test|sim|simulation|sandbox */
export const TEST_RUN_MODE_ENV = "FINANCE_RUN_MODE";

/** Base HTTP port used by a sandboxed server when no PORT/FINANCE_PORT is given. */
export const SANDBOX_DEFAULT_PORT = 4232;

/** Name of the marker file written into the sandbox root. */
export const SANDBOX_MARKER_FILE = "TEST_SANDBOX.json";

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled", "test", "sim", "simulation", "sandbox"]);
const RUN_MODE_SANDBOX = new Set(["test", "sim", "simulation", "sandbox"]);

// ---------------------------------------------------------------------------
// Production data dir — captured BEFORE any sandbox env mutation happens.
// This is the single source of truth for "where production data lives" and is
// what the sandbox must never write into.
// ---------------------------------------------------------------------------
const ORIGINAL_FINANCE_DATA_DIR = process.env.FINANCE_DATA_DIR;
const ORIGINAL_OMB_DATA_DIR = process.env.OMB_DATA_DIR;
const ORIGINAL_AGENT_MEMORY_DIR = process.env.AGENT_MEMORY_DIR;
const ORIGINAL_LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED;
const ORIGINAL_EXECUTION_MODE = process.env.EXECUTION_MODE;
const ORIGINAL_FINANCE_PORT = process.env.FINANCE_PORT;

/**
 * The production (non-sandbox) data directory for this process.
 * Evaluated once at module load — before `applySandboxEnv()` can rewrite env.
 */
export const PRODUCTION_DATA_DIR =
  ORIGINAL_FINANCE_DATA_DIR || ORIGINAL_OMB_DATA_DIR || join(homedir(), ".finance-agent");

function isTruthy(value: string | undefined): boolean {
  return typeof value === "string" && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Returns true when the process (or the supplied env bag) is in test/simulation mode.
 * Pure with respect to `process.env` when an explicit env bag is passed.
 */
export function isTestModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const runMode = env[TEST_RUN_MODE_ENV]?.trim().toLowerCase();
  if (runMode && RUN_MODE_SANDBOX.has(runMode)) return true;
  for (const flag of TEST_MODE_FLAGS) {
    if (isTruthy(env[flag])) return true;
  }
  return false;
}

/** Sanitize a user-provided run id so it can never escape the sandbox root. */
export function sanitizeRunId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Production data dir as seen from an env bag.
 * For `process.env` we always return the captured production dir (never the
 * sandbox path that `applySandboxEnv` may have written into it).
 */
export function getBaseDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env === process.env) return PRODUCTION_DATA_DIR;
  return env.FINANCE_DATA_DIR || env.OMB_DATA_DIR || PRODUCTION_DATA_DIR;
}

/**
 * Resolve the isolated sandbox data directory (may or may not exist yet).
 * Priority: FINANCE_TEST_DATA_DIR > `<base>/test-sandbox[/<runId>]`.
 */
export function resolveSandboxDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FINANCE_TEST_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const runId = sanitizeRunId(env.FINANCE_TEST_RUN_ID);
  const root = join(getBaseDataDir(env), "test-sandbox");
  return runId ? join(root, runId) : root;
}

/**
 * Deterministic sandbox HTTP port. Stable for a given run id so several
 * scenario runs can host their own servers in parallel.
 */
export function resolveSandboxPort(env: NodeJS.ProcessEnv = process.env): number {
  const runId = sanitizeRunId(env.FINANCE_TEST_RUN_ID);
  if (!runId) return SANDBOX_DEFAULT_PORT;
  let hash = 0;
  for (let i = 0; i < runId.length; i++) hash = (hash * 31 + runId.charCodeAt(i)) >>> 0;
  return SANDBOX_DEFAULT_PORT + (hash % 400);
}

/** True when `dir` is the (or is inside the) isolated sandbox root. */
export function isSandboxDataDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!dir) return false;
  const normalized = resolve(dir);
  const sandbox = resolve(resolveSandboxDataDir(env));
  return normalized === sandbox || normalized.startsWith(sandbox + sep);
}

// ---------------------------------------------------------------------------
// Sandbox env application / restore
// ---------------------------------------------------------------------------

export interface SandboxState {
  /** Whether the sandbox is currently active for this process. */
  enabled: boolean;
  /** Where persisted artefacts go (sandbox dir when enabled, else production). */
  dataDir: string;
  /** Always the isolated sandbox root, even when the sandbox is disabled. */
  sandboxDir: string;
  /** Optional concurrent-run scope. */
  runId?: string;
  /** Effective execution mode — forced to "paper" whenever the sandbox is on. */
  executionMode: "paper" | "live";
  /** Effective live-trading flag — always false when the sandbox is on. */
  liveTradingEnabled: boolean;
  /** Effective default HTTP port (sandboxed port when enabled). */
  port: number;
}

const MANAGED_KEYS = [
  "FINANCE_SANDBOX",
  "FINANCE_SANDBOX_DATA_DIR",
  "FINANCE_DATA_DIR",
  "OMB_DATA_DIR",
  "AGENT_MEMORY_DIR",
  "LIVE_TRADING_ENABLED",
  "EXECUTION_MODE",
  "FINANCE_PORT",
] as const;

let lastApplied: SandboxState | null = null;
/** Values that existed before we overwrote them, so we can restore exactly. */
let savedValues: Partial<Record<(typeof MANAGED_KEYS)[number], string | undefined>> | null = null;

function setOrDelete(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function currentPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT || env.FINANCE_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : resolveSandboxPort(env);
}

/**
 * Idempotently project the sandbox onto an env bag.
 *
 * When enabled this rewrites every persistence/network-safety env var so that
 * *all* downstream modules (`config.DATA_DIR`, `core/storage`, `llm/*`,
 * `order-manager`, `runtime` agent memory, …) resolve into the sandbox. When
 * disabled it restores whatever it previously overwrote, so toggling is safe.
 *
 * Called automatically from `config.ts` at import time; also safe to call
 * directly (tests, CLI entrypoints).
 */
export function applySandboxEnv(env: NodeJS.ProcessEnv = process.env): SandboxState {
  const enabled = isTestModeEnabled(env);
  const sandboxDir = resolveSandboxDataDir(env);
  const runId = sanitizeRunId(env.FINANCE_TEST_RUN_ID);

  if (enabled) {
    if (!savedValues) {
      savedValues = {};
      for (const key of MANAGED_KEYS) savedValues[key] = env[key];
    }
    setOrDelete(env, "FINANCE_SANDBOX", "1");
    setOrDelete(env, "FINANCE_SANDBOX_DATA_DIR", sandboxDir);
    setOrDelete(env, "FINANCE_DATA_DIR", sandboxDir);
    setOrDelete(env, "OMB_DATA_DIR", sandboxDir);
    // Agent memory is a second, independent persistence root — isolate it too.
    setOrDelete(env, "AGENT_MEMORY_DIR", join(sandboxDir, "memory"));
    // Non-bypassable safety: a sandbox can never reach a live broker.
    setOrDelete(env, "LIVE_TRADING_ENABLED", "false");
    setOrDelete(env, "EXECUTION_MODE", "paper");
    // Leave an explicit PORT/FINANCE_PORT alone so callers can pin the port;
    // otherwise shift the default off the production port.
    if (!env.PORT && !env.FINANCE_PORT) {
      setOrDelete(env, "FINANCE_PORT", String(resolveSandboxPort(env)));
    }
    const state: SandboxState = {
      enabled: true,
      dataDir: sandboxDir,
      sandboxDir,
      runId,
      executionMode: "paper",
      liveTradingEnabled: false,
      port: currentPort(env),
    };
    lastApplied = state;
    return state;
  }

  // Disabled — restore anything we previously overwrote (and nothing else).
  if (savedValues) {
    for (const key of MANAGED_KEYS) setOrDelete(env, key, savedValues[key]);
    savedValues = null;
  }
  const state: SandboxState = {
    enabled: false,
    dataDir: getBaseDataDir(env),
    sandboxDir,
    runId,
    executionMode: env.EXECUTION_MODE === "live" ? "live" : "paper",
    liveTradingEnabled: isTruthy(env.LIVE_TRADING_ENABLED),
    port: currentPort(env),
  };
  lastApplied = state;
  return state;
}

/** Current sandbox state for the process (computes on first call). */
export function getSandboxState(): SandboxState {
  return lastApplied ?? applySandboxEnv();
}

// ---------------------------------------------------------------------------
// Marker file — makes a sandbox dir self-describing & greppable
// ---------------------------------------------------------------------------

export interface SandboxMarker {
  kind: "finance-agent-test-sandbox";
  version: 1;
  runId?: string;
  pid: number;
  startedAt: number;
  baseDataDir: string;
  executionMode: "paper";
  liveTradingEnabled: false;
}

export function writeSandboxMarker(dir?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const target = dir ?? resolveSandboxDataDir(env);
  const marker: SandboxMarker = {
    kind: "finance-agent-test-sandbox",
    version: 1,
    runId: sanitizeRunId(env.FINANCE_TEST_RUN_ID),
    pid: process.pid,
    startedAt: Date.now(),
    baseDataDir: PRODUCTION_DATA_DIR,
    executionMode: "paper",
    liveTradingEnabled: false,
  };
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const file = join(target, SANDBOX_MARKER_FILE);
    writeFileAtomic(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export function readSandboxMarker(dir: string): SandboxMarker | null {
  const file = join(dir, SANDBOX_MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SandboxMarker;
    return parsed && parsed.kind === "finance-agent-test-sandbox" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenario run dirs — always isolated, never the production data dir
// ---------------------------------------------------------------------------

/**
 * Root under which individual test scenarios get their own private data dir.
 * Always anchored on the sandbox root so scenarios can never touch production
 * state, even if the process itself was started without the sandbox flag.
 */
export function resolveScenarioRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveSandboxDataDir(env), "scenarios");
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Allocate a fresh, private directory for one scenario run.
 * Guaranteed to sit under the sandbox root and to be unique per call, so any
 * number of scenarios can run concurrently without colliding.
 */
export function createScenarioDataDir(scenarioId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safeId = sanitizeRunId(scenarioId) ?? "scenario";
  const dir = join(resolveScenarioRoot(env), `${safeId}-${Date.now().toString(36)}-${randomSuffix()}`);
  // Defence-in-depth: refuse to hand out the production data dir.
  if (resolve(dir) === resolve(PRODUCTION_DATA_DIR)) {
    throw new Error(`[test-mode] refusing to use production data dir for scenario '${scenarioId}'`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Human-readable one-liner describing the current sandbox configuration. */
export function describeSandbox(state: SandboxState = getSandboxState()): string {
  if (!state.enabled) {
    return `sandbox=off dataDir=${state.dataDir} port=${state.port}`;
  }
  const scope = state.runId ? ` runId=${state.runId}` : "";
  return (
    `sandbox=ON${scope} dataDir=${state.dataDir} ` +
    `executionMode=paper liveTradingEnabled=false port=${state.port}`
  );
}
