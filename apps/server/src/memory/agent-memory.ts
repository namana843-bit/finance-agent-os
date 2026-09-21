// ============================================================================
// Finance Agent OS — Agent Memory
// Phase 5 & Phase 18: Structured persistent memory for agents with
// secret sanitization and end-to-end loop trace recording.
// ============================================================================
import * as path from "node:path";

export interface MemoryEntry {
  id: string;
  agentId: string;
  category: "decision" | "signal" | "trade" | "research" | "risk" | "state";
  key: string;
  value: unknown;
  timestamp: number;
  ttl?: number; // Time-to-live in ms, undefined = permanent
}

export interface AgentLoopTrace {
  traceId: string;
  correlationId: string;
  symbol: string;
  marketEvent?: unknown;
  quantSignal?: unknown;
  proposal?: unknown;
  riskDecision?: unknown;
  ticketIssued?: boolean;
  executionResult?: unknown;
  outcome: "executed" | "rejected_by_risk" | "rejected_by_guard" | "execution_failed" | "held";
  reason?: string;
  timestamp: number;
}

const SECRET_KEY_REGEX = /^(api[_-]?key|secret|token|password|private[_-]?key|credential|authorization|auth)$/i;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9_\-\.]+/gi;

/**
 * Recursively sanitizes data to prevent leaking secrets, credentials, or API keys
 * into agent persistent memory or audit trails.
 */
export function sanitizeSecrets<T>(val: T): T {
  if (val === null || val === undefined) return val;

  if (typeof val === "string") {
    return val.replace(BEARER_REGEX, "Bearer [REDACTED]") as unknown as T;
  }

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeSecrets(item)) as unknown as T;
  }

  if (typeof val === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SECRET_KEY_REGEX.test(k)) {
        cleaned[k] = "[REDACTED]";
      } else {
        cleaned[k] = sanitizeSecrets(v);
      }
    }
    return cleaned as T;
  }

  return val;
}

export class AgentMemory {
  private entries = new Map<string, MemoryEntry>();
  private agentIndex = new Map<string, Set<string>>(); // agentId -> entryIds
  private categoryIndex = new Map<string, Set<string>>(); // category -> entryIds
  private traces: AgentLoopTrace[] = [];
  private readonly maxTraces = 1000;
  private persistPath: string | null = null;
  private tracesPath: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private persistEnabled = false;
  private dirty = false;

  constructor(opts?: { persistDir?: string; maxTraces?: number }) {
    if (opts?.maxTraces) (this as unknown as { maxTraces: number }).maxTraces = opts.maxTraces;
    if (opts?.persistDir) this.configurePersistence(opts.persistDir);
  }

  /** Enable file persistence — lightweight JSONL, no SQLite hang */
  configurePersistence(dir: string): void {
    try {
      this.persistPath = path.join(dir, "agent-memory.json");
      this.tracesPath = path.join(dir, "traces.jsonl");
      this.persistEnabled = true;
    } catch { this.persistEnabled = false; }
  }

  async load(): Promise<void> {
    if (!this.persistEnabled || !this.persistPath) return;
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      try {
        const raw = await fs.readFile(this.persistPath, "utf8");
        const data = JSON.parse(raw) as { entries: MemoryEntry[]; traces: AgentLoopTrace[] };
        for (const e of data.entries ?? []) {
          if (e.ttl && Date.now() - e.timestamp > e.ttl) continue;
          this.entries.set(e.id, e);
          if (!this.agentIndex.has(e.agentId)) this.agentIndex.set(e.agentId, new Set());
          this.agentIndex.get(e.agentId)!.add(e.id);
          const catKey = `${e.agentId}:${e.category}`;
          if (!this.categoryIndex.has(catKey)) this.categoryIndex.set(catKey, new Set());
          this.categoryIndex.get(catKey)!.add(e.id);
        }
        this.traces = (data.traces ?? []).slice(-this.maxTraces);
      } catch { /* first run */ }
      // also replay traces.jsonl tail
      if (this.tracesPath) {
        try {
          const tail = await fs.readFile(this.tracesPath, "utf8");
          const lines = tail.trim().split("\n").filter(Boolean).slice(-this.maxTraces);
          for (const line of lines) {
            try { const t = JSON.parse(line) as AgentLoopTrace; if (!this.traces.find(x=>x.traceId===t.traceId)) this.traces.push(t); } catch {}
          }
          if (this.traces.length > this.maxTraces) this.traces.splice(0, this.traces.length - this.maxTraces);
        } catch {}
      }
    } catch {}
  }

  private schedulePersist(): void {
    if (!this.persistEnabled) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush(); }, 3000);
  }

  async flush(): Promise<void> {
    if (!this.persistEnabled || !this.persistPath || !this.dirty) return;
    this.dirty = false;
    try {
      const fs = await import("node:fs/promises");
      const pathMod = await import("node:path");
      await fs.mkdir(pathMod.dirname(this.persistPath), { recursive: true });
      const payload = JSON.stringify({ entries: [...this.entries.values()], traces: this.traces.slice(-500) }, null, 2);
      // atomic via tmp + renameWithRetry to handle Windows EPERM/EBUSY
      const { writeFileAtomic } = await import("../atomic.js");
      writeFileAtomic(this.persistPath, payload);
    } catch {}
  }

  startAutoCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const n = this.cleanup();
      if (n > 0) this.schedulePersist();
    }, intervalMs);
    if (this.cleanupTimer && typeof (this.cleanupTimer as unknown as { unref: () => void }).unref === "function") {
      (this.cleanupTimer as unknown as { unref: () => void }).unref();
    }
  }

  stopAutoCleanup(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }

  getStats(): { entries: number; traces: number; persistEnabled: boolean; persistPath: string | null } {
    return { entries: this.entries.size, traces: this.traces.length, persistEnabled: this.persistEnabled, persistPath: this.persistPath };
  }

  set(agentId: string, category: MemoryEntry["category"], key: string, value: unknown, ttl?: number): void {
    const id = `${agentId}:${category}:${key}`;
    const sanitizedValue = sanitizeSecrets(value);
    const entry: MemoryEntry = {
      id,
      agentId,
      category,
      key,
      value: sanitizedValue,
      timestamp: Date.now(),
      ttl,
    };

    this.entries.set(id, entry);

    if (!this.agentIndex.has(agentId)) this.agentIndex.set(agentId, new Set());
    this.agentIndex.get(agentId)!.add(id);

    const catKey = `${agentId}:${category}`;
    if (!this.categoryIndex.has(catKey)) this.categoryIndex.set(catKey, new Set());
    this.categoryIndex.get(catKey)!.add(id);
    this.schedulePersist();
  }

  get(agentId: string, category: MemoryEntry["category"], key: string): unknown | undefined {
    const id = `${agentId}:${category}:${key}`;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl) {
      this.delete(agentId, category, key);
      return undefined;
    }
    return entry.value;
  }

  delete(agentId: string, category: MemoryEntry["category"], key: string): boolean {
    const id = `${agentId}:${category}:${key}`;
    const entry = this.entries.get(id);
    if (!entry) return false;

    this.entries.delete(id);
    this.agentIndex.get(agentId)?.delete(id);
    this.categoryIndex.get(`${agentId}:${category}`)?.delete(id);
    return true;
  }

  getByAgent(agentId: string): MemoryEntry[] {
    const ids = this.agentIndex.get(agentId) ?? new Set();
    return [...ids].map((id) => this.entries.get(id)!).filter(Boolean);
  }

  getByCategory(agentId: string, category: MemoryEntry["category"]): MemoryEntry[] {
    const ids = this.categoryIndex.get(`${agentId}:${category}`) ?? new Set();
    return [...ids].map((id) => this.entries.get(id)!).filter(Boolean);
  }

  getRecent(agentId: string, category: MemoryEntry["category"], limit = 10): MemoryEntry[] {
    return this.getByCategory(agentId, category)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Records a complete end-to-end agent loop trace with secret sanitization.
   */
  recordTrace(trace: AgentLoopTrace): void {
    const sanitizedTrace = sanitizeSecrets(trace);
    this.traces.push(sanitizedTrace);
    if (this.traces.length > this.maxTraces) {
      this.traces.splice(0, this.traces.length - this.maxTraces);
    }
    // Also save in category index (skip extra persist — will be batched)
    const id = `supervisor:trade:${trace.traceId}`;
    const entry: MemoryEntry = { id, agentId: "supervisor", category: "trade", key: trace.traceId, value: sanitizedTrace, timestamp: Date.now() };
    this.entries.set(id, entry);
    if (!this.agentIndex.has("supervisor")) this.agentIndex.set("supervisor", new Set());
    this.agentIndex.get("supervisor")!.add(id);
    const catKey = "supervisor:trade";
    if (!this.categoryIndex.has(catKey)) this.categoryIndex.set(catKey, new Set());
    this.categoryIndex.get(catKey)!.add(id);
    // Append to JSONL for durability without rewriting full file each time
    if (this.persistEnabled && this.tracesPath) {
      void import("node:fs/promises").then(async (fs) => {
        try {
          const path = await import("node:path");
          await fs.mkdir(path.dirname(this.tracesPath!), { recursive: true });
          await fs.appendFile(this.tracesPath!, JSON.stringify(sanitizedTrace) + "\n", "utf8");
          // rotate if > 5MB
          try { const st = await fs.stat(this.tracesPath!); if (st.size > 5 * 1024 * 1024) await fs.rename(this.tracesPath!, `${this.tracesPath!}.${Date.now()}.bak`); } catch {}
        } catch {}
      });
    }
    this.schedulePersist();
  }

  /**
   * Retrieve loop traces optionally filtered by symbol.
   */
  getTraces(symbol?: string, limit = 50): AgentLoopTrace[] {
    let list = this.traces;
    if (symbol) {
      const sym = symbol.toUpperCase();
      list = list.filter((t) => t.symbol?.toUpperCase() === sym);
    }
    return list.slice(-limit);
  }

  clear(): void {
    this.entries.clear();
    this.agentIndex.clear();
    this.categoryIndex.clear();
    this.traces = [];
    this.schedulePersist();
  }

  size(): number {
    return this.entries.size;
  }

  // Cleanup expired entries
  cleanup(): number {
    let removed = 0;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) {
        this.entries.delete(id);
        this.agentIndex.get(entry.agentId)?.delete(id);
        this.categoryIndex.get(`${entry.agentId}:${entry.category}`)?.delete(id);
        removed++;
      }
    }
    // also prune traces older than 7 days to avoid hang
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const before = this.traces.length;
    this.traces = this.traces.filter(t => t.timestamp > cutoff);
    if (this.traces.length !== before) removed += before - this.traces.length;
    if (removed > 0) this.schedulePersist();
    return removed;
  }
}

// Singleton
export const agentMemory = new AgentMemory();
