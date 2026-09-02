// ============================================================================
// Finance Agent OS — State Recovery
// Phase 17: Application must survive restart. Reconstruct state from persistence.
// ============================================================================

import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

// ---------------------------------------------------------------------------
// State Store — in-memory with file persistence
// ---------------------------------------------------------------------------

export interface PersistedState {
  portfolio: {
    cash: number;
    positions: Record<string, { symbol: string; qty: number; avgPrice: number; currentPrice: number; leverage: number }>;
    realizedPnl: number;
    unrealizedPnl: number;
  };
  strategyConfig: Record<string, { enabled: boolean; parameters: Record<string, unknown> }>;
  riskConfig: Record<string, unknown>;
  agentState: Record<string, { status: string; lastActivity: number }>;
  orders: Array<{ id: string; symbol: string; status: string; timestamp: number }>;
  trades: Array<{ id: string; symbol: string; side: string; entryPrice: number; quantity: number; status: string }>;
  signals: Array<{ id: string; symbol: string; side: string; confidence: number; timestamp: number }>;
  lastSnapshot: number;
}

export interface StateRecoveryConfig {
  persistencePath: string;
  snapshotIntervalMs: number;
  maxSnapshots: number;
}

const DEFAULT_STATE: PersistedState = {
  portfolio: {
    cash: 100_000,
    positions: {},
    realizedPnl: 0,
    unrealizedPnl: 0,
  },
  strategyConfig: {},
  riskConfig: {},
  agentState: {},
  orders: [],
  trades: [],
  signals: [],
  lastSnapshot: 0,
};

// ---------------------------------------------------------------------------
// State Recovery Service
// ---------------------------------------------------------------------------

export class StateRecovery {
  private state: PersistedState = { ...DEFAULT_STATE };
  private config: StateRecoveryConfig;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private fileSystem: FileSystemAdapter;

  constructor(bus: TypedEventBus, config?: Partial<StateRecoveryConfig>) {
    this.config = {
      persistencePath: ".data/state.json",
      snapshotIntervalMs: 30_000,
      maxSnapshots: 5,
      ...config,
    };
    this.fileSystem = new NodeFileSystemAdapter();

    // Subscribe to important events to track state changes
    bus.subscribeTo("portfolio.updated", (event) => {
      const data = event.data as { cash?: number; positions?: Record<string, unknown>; realizedPnL?: number; unrealizedPnL?: number };
      if (data) {
        if (typeof data.cash === "number") this.state.portfolio.cash = data.cash;
        if (data.positions) this.state.portfolio.positions = data.positions as PersistedState["portfolio"]["positions"];
        if (typeof data.realizedPnL === "number") this.state.portfolio.realizedPnl = data.realizedPnL;
        if (typeof data.unrealizedPnL === "number") this.state.portfolio.unrealizedPnl = data.unrealizedPnL;
      }
    });

    bus.subscribeTo("order.filled", (event) => {
      const data = event.data as { orderId?: string; symbol?: string; status?: string; timestamp?: number };
      if (data) {
        this.state.orders.push({
          id: data.orderId ?? "",
          symbol: data.symbol ?? "",
          status: "FILLED",
          timestamp: data.timestamp ?? Date.now(),
        });
      }
    });

    bus.subscribeTo("trade.opened", (event) => {
      const data = event.data as { id?: string; symbol?: string; side?: string; entryPrice?: number; quantity?: number; status?: string };
      if (data) {
        this.state.trades.push({
          id: data.id ?? "",
          symbol: data.symbol ?? "",
          side: data.side ?? "",
          entryPrice: data.entryPrice ?? 0,
          quantity: data.quantity ?? 0,
          status: data.status ?? "open",
        });
      }
    });

    bus.subscribeTo("quant.signal", (event) => {
      const data = event.data as { id?: string; symbol?: string; side?: string; confidence?: number; timestamp?: number };
      if (data) {
        this.state.signals.push({
          id: data.id ?? "",
          symbol: data.symbol ?? "",
          side: data.side ?? "",
          confidence: data.confidence ?? 0,
          timestamp: data.timestamp ?? Date.now(),
        });
        // Keep signals bounded
        if (this.state.signals.length > 500) {
          this.state.signals = this.state.signals.slice(-500);
        }
      }
    });

    bus.subscribeTo("agent.started", (event) => {
      const data = event.data as { agentId?: string; status?: string };
      const agentId = data?.agentId ?? event.agentId ?? "";
      if (agentId) {
        this.state.agentState[agentId] = {
          status: "running",
          lastActivity: Date.now(),
        };
      }
    });

    bus.subscribeTo("agent.stopped", (event) => {
      const agentId = event.agentId ?? "";
      if (agentId) {
        this.state.agentState[agentId] = {
          status: "stopped",
          lastActivity: Date.now(),
        };
      }
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // Load any persisted state from disk
    await this.loadState();
    console.log(`[state-recovery] loaded state from ${this.config.persistencePath}`);

    // Start periodic snapshots
    if (this.config.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => {
        void this.saveState();
      }, this.config.snapshotIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    // Save final state
    await this.saveState();
    console.log("[state-recovery] stopped, state saved");
  }

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  getState(): PersistedState {
    return JSON.parse(JSON.stringify(this.state));
  }

  updatePortfolio(portfolio: Partial<PersistedState["portfolio"]>): void {
    Object.assign(this.state.portfolio, portfolio);
  }

  updateAgentState(agentId: string, status: string): void {
    this.state.agentState[agentId] = {
      status,
      lastActivity: Date.now(),
    };
  }

  updateStrategyConfig(strategyId: string, config: { enabled?: boolean; parameters?: Record<string, unknown> }): void {
    this.state.strategyConfig[strategyId] = {
      ...this.state.strategyConfig[strategyId],
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async saveState(): Promise<void> {
    this.state.lastSnapshot = Date.now();
    try {
      const payload = JSON.stringify(this.state, null, 2);
      await this.fileSystem.writeFile(this.config.persistencePath, payload);
    } catch (err) {
      console.error("[state-recovery] failed to save state:", err);
    }
  }

  async loadState(): Promise<void> {
    try {
      const exists = await this.fileSystem.exists(this.config.persistencePath);
      if (!exists) {
        console.log("[state-recovery] no persisted state found, using defaults");
        return;
      }
      const raw = await this.fileSystem.readFile(this.config.persistencePath);
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = { ...DEFAULT_STATE, ...parsed };
      console.log(`[state-recovery] recovered state from ${new Date(this.state.lastSnapshot).toISOString()}`);
    } catch (err) {
      console.error("[state-recovery] failed to load state, using defaults:", err);
      this.state = { ...DEFAULT_STATE };
    }
  }

  async clearState(): Promise<void> {
    this.state = { ...DEFAULT_STATE };
    await this.saveState();
    console.log("[state-recovery] state cleared");
  }
}

// ---------------------------------------------------------------------------
// File System Adapter — abstraction for persistence backend
// ---------------------------------------------------------------------------

export interface FileSystemAdapter {
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

export class NodeFileSystemAdapter implements FileSystemAdapter {
  async writeFile(path: string, data: string): Promise<void> {
    const dir = dirname(path);
    await this.mkdir(dir);
    await writeFile(path, data, "utf-8");
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
