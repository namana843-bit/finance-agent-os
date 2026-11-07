/**
 * Global default CLI provider store.
 *
 * Stores the workspace-wide default CLI provider ID that agents inherit
 * when they don't have an agent-specific `providerId` override.
 *
 * Three-level override: global default → agent providerId → task override.
 *
 * Persisted to <dataDir>/cli-default-provider.json using atomic writes.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";
import { writeFileAtomic } from "../atomic.js";

interface DefaultProviderFile {
  version: number;
  providerId: string | null;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CliDefaultProviderStore {
  private readonly filePath: string;
  private providerId: string | null = null;
  private loaded = false;

  constructor(opts: { dataDir?: string } = {}) {
    this.filePath = join(opts.dataDir ?? DATA_DIR, "cli-default-provider.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as DefaultProviderFile;
        if (parsed && typeof parsed.providerId === "string") {
          this.providerId = parsed.providerId;
        }
      }
    } catch {
      this.providerId = null;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: DefaultProviderFile = {
      version: 1,
      providerId: this.providerId,
      updatedAt: nowIso(),
    };
    writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /** Get the current global default provider ID (null if none set). */
  get(): string | null {
    this.load();
    return this.providerId;
  }

  /** Set the global default provider ID (null to clear). */
  set(providerId: string | null): void {
    this.load();
    this.providerId = providerId;
    this.persist();
  }
}

let defaultStore: CliDefaultProviderStore | null = null;

export function getCliDefaultProviderStore(): CliDefaultProviderStore {
  if (!defaultStore) defaultStore = new CliDefaultProviderStore();
  return defaultStore;
}

export function resetCliDefaultProviderStore(): void {
  defaultStore = null;
}
