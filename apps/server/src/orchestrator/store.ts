// ============================================================================
// Trade Workflow Orchestrator — Persistence
// One JSON file per run under <DATA_DIR>/workflows/, atomic write (tmp+rename),
// index file for listing. Same conventions as AgentPersistence.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { isWorkflowRun, type WorkflowRun } from "./types.js";
import { writeFileAtomic } from "../atomic.js";

function defaultDataDir(): string {
  return process.env.FINANCE_DATA_DIR || DATA_DIR;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class WorkflowStore {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(defaultDataDir(), "workflows");
  }

  private runPath(id: string): string {
    return join(this.dataDir, `${safeId(id)}.json`);
  }

  private indexPath(): string {
    return join(this.dataDir, "index.json");
  }

  async loadRun(id: string): Promise<WorkflowRun | undefined> {
    try {
      const content = await readFile(this.runPath(id), "utf-8");
      const parsed = JSON.parse(content);
      return isWorkflowRun(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      await writeFileAtomic(this.runPath(run.id), JSON.stringify(run, null, 2));
      await this.updateIndex(run);
    } catch (err) {
      console.error("[WorkflowStore] Failed to save run:", err);
    }
  }

  private async updateIndex(run: WorkflowRun): Promise<void> {
    let index: Array<{ id: string; status: string; updatedAt: string; symbol?: string }> = [];
    try {
      const content = await readFile(this.indexPath(), "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) index = parsed;
    } catch {
      // fresh index
    }
    index = index.filter((e) => e.id !== run.id);
    index.unshift({
      id: run.id,
      status: run.status,
      updatedAt: run.updatedAt,
      symbol: run.proposal?.symbol,
    });
    if (index.length > 500) index = index.slice(0, 500);
    const tmp = `${this.indexPath()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
    await rename(tmp, this.indexPath()).catch(async () => {
      await writeFileAtomic(this.indexPath(), JSON.stringify(index, null, 2));
    });
  }

  /** Recover all persisted runs after a restart (index + per-run files). */
  async loadAll(limit = 100): Promise<WorkflowRun[]> {
    let index: Array<{ id: string }> = [];
    try {
      const content = await readFile(this.indexPath(), "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) index = parsed;
    } catch {
      return [];
    }
    const runs: WorkflowRun[] = [];
    for (const entry of index.slice(0, limit)) {
      const run = await this.loadRun(entry.id);
      if (run) runs.push(run);
    }
    return runs;
  }
}
