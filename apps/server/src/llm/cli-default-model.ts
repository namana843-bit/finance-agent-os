/**
 * Global default free model store.
 *
 * Stores the workspace-wide default OpenCode free model that coworkers inherit
 * when they don't have an agent-specific `model` override.
 *
 * Persisted to <dataDir>/cli-default-model.json using atomic writes.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";
import { writeFileAtomic } from "../atomic.js";

interface DefaultModelFile {
  version: number;
  model: string | null;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CliDefaultModelStore {
  private readonly filePath: string;
  private model: string | null = null;
  private loaded = false;

  constructor(opts: { dataDir?: string } = {}) {
    this.filePath = join(opts.dataDir ?? DATA_DIR, "cli-default-model.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as DefaultModelFile;
        if (parsed && typeof parsed.model === "string") {
          this.model = parsed.model;
        }
      }
    } catch {
      this.model = null;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: DefaultModelFile = {
      version: 1,
      model: this.model,
      updatedAt: nowIso(),
    };
    writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /** Get the current global default free model (null if none set). */
  get(): string | null {
    this.load();
    return this.model;
  }

  /** Set the global default free model (null to clear). */
  set(model: string | null): void {
    this.load();
    this.model = model;
    this.persist();
  }
}

let defaultStore: CliDefaultModelStore | null = null;

export function getCliDefaultModelStore(): CliDefaultModelStore {
  if (!defaultStore) defaultStore = new CliDefaultModelStore();
  return defaultStore;
}

export function resetCliDefaultModelStore(): void {
  defaultStore = null;
}
