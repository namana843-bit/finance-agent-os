// ============================================================================
// Finance Agent OS — Agent Memory
// Phase 5 & Phase 18: Structured persistent memory for agents with
// secret sanitization and end-to-end loop trace recording.
// ============================================================================

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

  constructor() {}

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
    // Also save in category index
    this.set("supervisor", "trade", trace.traceId, sanitizedTrace);
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
    return removed;
  }
}

// Singleton
export const agentMemory = new AgentMemory();
