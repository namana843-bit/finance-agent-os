// ============================================================================
// Finance Agent OS — Agent Memory
// Phase 18: Structured persistent memory for agents
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

export class AgentMemory {
  private entries = new Map<string, MemoryEntry>();
  private agentIndex = new Map<string, Set<string>>(); // agentId -> entryIds
  private categoryIndex = new Map<string, Set<string>>(); // category -> entryIds

  constructor() {}

  set(agentId: string, category: MemoryEntry["category"], key: string, value: unknown, ttl?: number): void {
    const id = `${agentId}:${category}:${key}`;
    const entry: MemoryEntry = {
      id,
      agentId,
      category,
      key,
      value,
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

  clear(): void {
    this.entries.clear();
    this.agentIndex.clear();
    this.categoryIndex.clear();
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
