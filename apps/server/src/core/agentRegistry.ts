import type { FinanceAgent, AgentStatus } from "./agent.js";

// ---------------------------------------------------------------------------
// AgentRegistry — single source of truth for agent lifecycle
// ---------------------------------------------------------------------------

export interface RegistryHealth {
  total: number;
  running: number;
  stopped: number;
  errors: number;
  agents: Array<{ id: string; name: string; status: AgentStatus; running: boolean }>;
}

export class AgentRegistry {
  private agents = new Map<string, FinanceAgent>();

  /** Register an agent. Throws on duplicate id or invalid shape. */
  register(agent: FinanceAgent): FinanceAgent {
    if (!agent || typeof agent !== "object") throw new Error("agent must be an object");
    if (!agent.id || typeof agent.id !== "string" || agent.id.trim() === "") {
      throw new Error("agent.id is required and must be a non-empty string");
    }
    if (typeof agent.start !== "function" || typeof agent.stop !== "function") {
      throw new Error(`agent ${agent.id} must implement start() and stop()`);
    }
    if (typeof agent.isRunning !== "function") {
      throw new Error(`agent ${agent.id} must implement isRunning()`);
    }
    const id = agent.id.trim();
    if (this.agents.has(id)) {
      throw new Error(`agent already registered: ${id}`);
    }
    // normalize id trimming (agents expose readonly id; store by trimmed key)
    this.agents.set(id, agent);
    return agent;
  }

  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  get(id: string): FinanceAgent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): FinanceAgent[] {
    return [...this.agents.values()];
  }

  ids(): string[] {
    return [...this.agents.keys()];
  }

  size(): number {
    return this.agents.size;
  }

  clear(): void {
    this.agents.clear();
  }

  /** Start all agents honoring declared dependencies (topological order). */
  async startAll(): Promise<void> {
    for (const agent of this.orderedByDependencies()) {
      await agent.start();
    }
  }

  async stopAll(): Promise<void> {
    // stop in reverse start order
    const ordered = this.orderedByDependencies().reverse();
    for (const agent of ordered) {
      try {
        await agent.stop();
      } catch (err) {
        console.error(`[AgentRegistry] stop failed for ${agent.id}:`, err);
      }
    }
  }

  async restart(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent: ${id}`);
    await agent.stop();
    await agent.start();
  }

  health(): RegistryHealth {
    const agents = this.list().map((a) => {
      let status: AgentStatus = "idle";
      let running = false;
      try {
        running = a.isRunning();
        status = typeof a.getStatus === "function" ? a.getStatus() : running ? "running" : "stopped";
      } catch {
        status = "error";
      }
      return { id: a.id, name: a.name, status, running };
    });
    return {
      total: agents.length,
      running: agents.filter((a) => a.running).length,
      stopped: agents.filter((a) => !a.running).length,
      errors: agents.filter((a) => a.status === "error").length,
      agents,
    };
  }

  /**
   * Multi-loop runner — executes `fn` for N iterations across all agents.
   * Used to verify the event pipeline repeatedly (e.g. market tick loops).
   * Returns per-iteration results.
   */
  async runLoops<T>(iterations: number, fn: (iteration: number) => T | Promise<T>): Promise<T[]> {
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new Error("iterations must be a positive integer");
    }
    const results: T[] = [];
    for (let i = 0; i < iterations; i++) {
      results.push(await fn(i));
    }
    return results;
  }

  private orderedByDependencies(): FinanceAgent[] {
    const agents = this.list();
    const byId = new Map(agents.map((a) => [a.id, a]));
    const visited = new Set<string>();
    const temp = new Set<string>();
    const out: FinanceAgent[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (temp.has(id)) throw new Error(`circular agent dependency involving ${id}`);
      temp.add(id);
      const agent = byId.get(id);
      const deps = agent?.dependencies ?? [];
      for (const dep of deps) {
        if (byId.has(dep)) visit(dep);
      }
      temp.delete(id);
      visited.add(id);
      if (agent) out.push(agent);
    };

    for (const agent of agents) visit(agent.id);
    return out;
  }
}

export default AgentRegistry;
