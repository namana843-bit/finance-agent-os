/**
 * Provider connection store.
 *
 * A "connection" is the user-facing configuration for one provider endpoint:
 * which catalog preset it uses, an optional base URL override, the *name* of
 * the environment variable that holds its credential, a timeout, and optional
 * fallback models.
 *
 * Security contract
 * - A raw API key is never accepted, stored, returned or logged here. Callers
 *   may only name an environment variable (server-side secret source). Payloads
 *   containing key-like fields are rejected outright.
 * - `toView` strips everything that is not safe for the renderer and reports
 *   only `keyPresent: boolean`.
 * - Health is only reported from a real `healthCheck()` round trip.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderHealth } from "@finance/shared";
import { writeFileAtomic } from "../atomic.js";
import { DATA_DIR } from "../config.js";
import { API_PRESETS, buildProvider, getPreset, type ProviderPreset } from "./provider-catalog.js";
import type { LLMProvider } from "./provider.js";
import type { ProviderRegistry } from "./registry.js";
import { redactText } from "./redact.js";

export interface FallbackTarget {
  providerId: string;
  model: string;
}

export interface ProviderConnection {
  id: string;
  presetId: string;
  name: string;
  kind: "api" | "cli";
  baseUrl?: string;
  /** Environment variable holding the credential — never the credential. */
  apiKeyEnv?: string;
  enabled: boolean;
  defaultModel?: string;
  timeoutMs: number;
  fallbackModels: FallbackTarget[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastStatus?: ProviderHealth["status"];
  lastMessage?: string;
}

/** Renderer-safe projection: no env values, only presence. */
export interface ProviderConnectionView {
  id: string;
  presetId: string;
  name: string;
  kind: "api" | "cli";
  baseUrl?: string;
  apiKeyEnv?: string;
  keyRequired: boolean;
  keyPresent: boolean;
  enabled: boolean;
  defaultModel?: string;
  timeoutMs: number;
  fallbackModels: FallbackTarget[];
  capabilities: { streaming: boolean; tools: boolean; reasoning: boolean };
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastStatus?: ProviderHealth["status"];
  lastMessage?: string;
}

export interface ConnectionInput {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
  defaultModel?: string;
  timeoutMs?: number;
  fallbackModels?: Array<{ providerId?: string; model?: string }>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  connection?: ProviderConnection;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Payload keys that would mean the caller is trying to send a secret. */
const FORBIDDEN_SECRET_FIELDS = ["apiKey", "apikey", "key", "secret", "token", "password", "authorization"];

function nowIso(): string {
  return new Date().toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export class ProviderConnectionStore {
  private readonly filePath: string;
  private connections = new Map<string, ProviderConnection>();
  /** Preset ids the user deleted; they must not be re-seeded on restart. */
  private removedIds: string[] = [];
  private loaded = false;

  constructor(opts: { dataDir?: string } = {}) {
    this.filePath = join(opts.dataDir ?? DATA_DIR, "provider-connections.json");
  }

  get path(): string {
    return this.filePath;
  }

  private seedDefaults(): ProviderConnection[] {
    const stamp = nowIso();
    return API_PRESETS.map((preset) => ({
      id: preset.id,
      presetId: preset.id,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      enabled: true,
      defaultModel: preset.defaultModel,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      fallbackModels: [],
      createdAt: stamp,
      updatedAt: stamp,
    }));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let stored: ProviderConnection[] = [];
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as
          | { connections?: ProviderConnection[]; removed?: string[] }
          | ProviderConnection[];
        stored = Array.isArray(parsed) ? parsed : parsed.connections ?? [];
        if (!Array.isArray(parsed) && Array.isArray(parsed.removed)) {
          this.removedIds = parsed.removed.filter((id): id is string => typeof id === "string");
        }
      }
    } catch {
      stored = [];
    }
    for (const connection of stored) {
      if (connection && typeof connection.id === "string") {
        this.connections.set(connection.id, {
          ...this.normalizeStored(connection),
        });
      }
    }
    // Seed catalog presets the file has never seen, without resurrecting ones
    // the user deleted (they are recorded in `removed`).
    const removed = new Set(this.removedIds);
    for (const seed of this.seedDefaults()) {
      if (this.connections.has(seed.id) || removed.has(seed.id)) continue;
      this.connections.set(seed.id, seed);
    }
  }

  private normalizeStored(raw: ProviderConnection): ProviderConnection {
    return {
      ...raw,
      kind: raw.kind === "cli" ? "cli" : "api",
      enabled: raw.enabled !== false,
      timeoutMs:
        typeof raw.timeoutMs === "number" && raw.timeoutMs >= MIN_TIMEOUT_MS
          ? Math.min(raw.timeoutMs, MAX_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS,
      fallbackModels: Array.isArray(raw.fallbackModels) ? raw.fallbackModels : [],
      createdAt: raw.createdAt ?? nowIso(),
      updatedAt: raw.updatedAt ?? nowIso(),
    };
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: nowIso(),
      removed: this.removedIds,
      connections: [...this.connections.values()],
    };
    writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  list(): ProviderConnection[] {
    this.load();
    return [...this.connections.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ProviderConnection | undefined {
    this.load();
    return this.connections.get(id);
  }

  validate(input: ConnectionInput, existingId?: string): ValidationResult {
    const errors: string[] = [];
    if (!input || typeof input !== "object") {
      return { ok: false, errors: ["body must be a JSON object"] };
    }

    const raw = input as Record<string, unknown>;
    const forbidden = FORBIDDEN_SECRET_FIELDS.filter((field) => raw[field] !== undefined);
    if (forbidden.length > 0) {
      return {
        ok: false,
        errors: [
          `credential fields are rejected: ${forbidden.join(", ")} — set 'apiKeyEnv' to the name of a server environment variable instead`,
        ],
      };
    }

    const presetId = typeof input.presetId === "string" ? input.presetId.trim() : "";
    const preset = getPreset(presetId);
    if (!preset) errors.push(`unknown preset '${presetId}'`);

    const id = (existingId ?? input.id ?? presetId).trim().toLowerCase();
    if (!ID_PATTERN.test(id)) {
      errors.push("'id' must be 3-40 chars, lowercase letters/digits/hyphens, starting with a letter");
    }
    if (!existingId && this.get(id)) errors.push(`provider connection '${id}' already exists`);
    if (existingId && existingId !== id) errors.push("'id' cannot change once created");

    const baseUrlRaw = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    const baseUrl = baseUrlRaw || preset?.baseUrl;
    if (baseUrl && !isHttpUrl(baseUrl)) errors.push(`'baseUrl' must be an http(s) URL (got '${baseUrlRaw}')`);

    const apiKeyEnvRaw = typeof input.apiKeyEnv === "string" ? input.apiKeyEnv.trim() : "";
    const apiKeyEnv = apiKeyEnvRaw || preset?.apiKeyEnv;
    if (apiKeyEnv && !ENV_PATTERN.test(apiKeyEnv)) {
      errors.push("'apiKeyEnv' must be an environment variable NAME like OPENAI_API_KEY (not a key value)");
    }

    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.round(input.timeoutMs)
        : existingId
          ? this.get(existingId)?.timeoutMs ?? DEFAULT_TIMEOUT_MS
          : DEFAULT_TIMEOUT_MS;
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      errors.push(`'timeoutMs' must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    }

    const fallbackModels: FallbackTarget[] = [];
    if (input.fallbackModels !== undefined) {
      if (!Array.isArray(input.fallbackModels)) {
        errors.push("'fallbackModels' must be an array of { providerId, model }");
      } else {
        for (const entry of input.fallbackModels) {
          const providerId = typeof entry?.providerId === "string" ? entry.providerId.trim() : "";
          const model = typeof entry?.model === "string" ? entry.model.trim() : "";
          if (!providerId || !model) {
            errors.push("each fallback needs both 'providerId' and 'model'");
            continue;
          }
          if (!fallbackModels.some((f) => f.providerId === providerId && f.model === model)) {
            fallbackModels.push({ providerId, model });
          }
        }
      }
    }

    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : preset?.name;
    if (!name) errors.push("'name' is required");

    if (errors.length > 0) return { ok: false, errors };

    const previous = existingId ? this.get(existingId) : undefined;
    const stamp = nowIso();
    const connection: ProviderConnection = {
      id,
      presetId: presetId || previous?.presetId || id,
      name: name as string,
      kind: preset?.kind ?? previous?.kind ?? "api",
      baseUrl,
      apiKeyEnv,
      enabled: input.enabled !== undefined ? input.enabled !== false : previous?.enabled ?? true,
      defaultModel:
        typeof input.defaultModel === "string" && input.defaultModel.trim()
          ? input.defaultModel.trim().slice(0, 200)
          : previous?.defaultModel ?? preset?.defaultModel,
      timeoutMs,
      fallbackModels,
      createdAt: previous?.createdAt ?? stamp,
      updatedAt: stamp,
      lastValidatedAt: previous?.lastValidatedAt,
      lastStatus: previous?.lastStatus,
      lastMessage: previous?.lastMessage,
    };
    return { ok: true, errors: [], connection };
  }

  upsert(input: ConnectionInput, existingId?: string): ValidationResult {
    const result = this.validate(input, existingId);
    if (!result.ok || !result.connection) return result;
    this.load();
    this.connections.set(result.connection.id, result.connection);
    this.persist();
    return result;
  }

  remove(id: string): boolean {
    this.load();
    const removed = this.connections.delete(id);
    if (removed) {
      this.removedIds.push(id);
      this.persist();
    }
    return removed;
  }

  recordHealth(id: string, health: ProviderHealth): void {
    this.load();
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.lastValidatedAt = nowIso();
    connection.lastStatus = health.status;
    connection.lastMessage = health.message ? redactText(health.message) : undefined;
    this.persist();
  }

  /** Safe projection for the desktop app. */
  view(connection: ProviderConnection): ProviderConnectionView {
    const preset = getPreset(connection.presetId);
    return {
      id: connection.id,
      presetId: connection.presetId,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      apiKeyEnv: connection.apiKeyEnv,
      keyRequired: preset?.keyRequired ?? false,
      keyPresent: this.hasCredential(connection),
      enabled: connection.enabled,
      defaultModel: connection.defaultModel,
      timeoutMs: connection.timeoutMs,
      fallbackModels: connection.fallbackModels,
      capabilities: preset?.capabilities ?? { streaming: false, tools: false, reasoning: false },
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      lastValidatedAt: connection.lastValidatedAt,
      lastStatus: connection.lastStatus,
      lastMessage: connection.lastMessage,
    };
  }

  hasCredential(connection: ProviderConnection): boolean {
    const preset = getPreset(connection.presetId);
    if (preset && !preset.keyRequired) return true;
    if (!connection.apiKeyEnv) return false;
    return Boolean(process.env[connection.apiKeyEnv]);
  }
}

let defaultStore: ProviderConnectionStore | null = null;

export function getProviderConnections(): ProviderConnectionStore {
  if (!defaultStore) defaultStore = new ProviderConnectionStore();
  return defaultStore;
}

/** Reset the process-wide store (tests, or after a data-dir change). */
export function resetProviderConnections(): void {
  defaultStore = null;
}

/**
 * Register one provider instance per enabled connection in the single
 * existing registry. Re-running this is idempotent: ids overwrite.
 */
export function applyConnections(
  registry: ProviderRegistry,
  connections: ProviderConnection[] = getProviderConnections().list(),
): void {
  for (const connection of connections) {
    if (!connection.enabled) {
      registry.unregister(connection.id);
      continue;
    }
    const preset: ProviderPreset | undefined = getPreset(connection.presetId);
    if (!preset) continue;
    registry.register(
      buildProvider(preset, {
        providerId: connection.id,
        providerName: connection.name,
        baseUrl: connection.baseUrl,
        apiKeyEnv: connection.apiKeyEnv,
        defaultModel: connection.defaultModel,
        timeoutMs: connection.timeoutMs,
      }),
    );
  }
}

export function connectionPresets(): ProviderPreset[] {
  return API_PRESETS;
}

/** Instantiate a live provider for one stored connection. */
export function providerForConnection(connection: ProviderConnection): LLMProvider | undefined {
  const preset = getPreset(connection.presetId);
  if (!preset) return undefined;
  return buildProvider(preset, {
    providerId: connection.id,
    providerName: connection.name,
    baseUrl: connection.baseUrl,
    apiKeyEnv: connection.apiKeyEnv,
    defaultModel: connection.defaultModel,
    timeoutMs: connection.timeoutMs,
  });
}
