// ============================================================================
// Finance Agent OS — Portfolio History
// BUG FIX: GET /api/portfolio/history returned a hard-coded empty array with a
// "TODO: implement portfolio history persistence" note.
//
// This service subscribes to `portfolio.updated` events and keeps a bounded
// in-memory ring buffer of equity snapshots, persisted atomically to disk so
// the history survives a restart. Snapshots are also emitted on demand.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import { writeFileAtomic } from "../atomic.js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PortfolioHistoryPosition {
  qty: number;
  avgPrice: number;
  currentPrice: number;
}

export interface PortfolioHistorySnapshot {
  timestamp: number;
  cash: number;
  positions: Record<string, PortfolioHistoryPosition>;
  totalValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface PortfolioHistoryOptions {
  /** Where the snapshot history is persisted. */
  path?: string;
  /** Maximum number of snapshots kept in memory / on disk. */
  maxSnapshots?: number;
  /** Minimum interval (ms) between two persisted snapshots. */
  minIntervalMs?: number;
  /** Set false to keep history in memory only (tests). */
  persist?: boolean;
}

const DEFAULT_PATH = ".data/portfolio-history.json";

export class PortfolioHistory {
  private snapshots: PortfolioHistorySnapshot[] = [];
  private options: Required<PortfolioHistoryOptions>;
  private unsubscribe: (() => void) | null = null;
  private lastPersistedAt = 0;

  constructor(bus?: TypedEventBus, options?: PortfolioHistoryOptions) {
    this.options = {
      path: options?.path ?? DEFAULT_PATH,
      maxSnapshots: options?.maxSnapshots ?? 500,
      minIntervalMs: options?.minIntervalMs ?? 5_000,
      persist: options?.persist ?? true,
    };

    if (bus) {
      this.unsubscribe = bus.subscribeTo("portfolio.updated", (event) => {
        const data = event.data as {
          cash?: number;
          positions?: Record<string, PortfolioHistoryPosition>;
          realizedPnL?: number;
          unrealizedPnL?: number;
        };
        if (!data) return;
        this.record({
          cash: typeof data.cash === "number" ? data.cash : 0,
          positions: data.positions ?? {},
          realizedPnl: typeof data.realizedPnL === "number" ? data.realizedPnL : 0,
          unrealizedPnl: typeof data.unrealizedPnL === "number" ? data.unrealizedPnL : 0,
        });
      });
    }
  }

  start(): void {
    this.load();
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Appends a snapshot (bounded ring buffer) and persists it. */
  record(input: {
    cash: number;
    positions: Record<string, PortfolioHistoryPosition>;
    realizedPnl?: number;
    unrealizedPnl?: number;
    timestamp?: number;
  }): PortfolioHistorySnapshot {
    const positions = input.positions ?? {};
    const positionValue = Object.values(positions).reduce(
      (sum, p) => sum + (p.qty ?? 0) * (p.currentPrice ?? p.avgPrice ?? 0),
      0,
    );

    const snapshot: PortfolioHistorySnapshot = {
      timestamp: input.timestamp ?? Date.now(),
      cash: input.cash ?? 0,
      positions,
      totalValue: (input.cash ?? 0) + positionValue,
      realizedPnl: input.realizedPnl ?? 0,
      unrealizedPnl: input.unrealizedPnl ?? 0,
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.options.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.options.maxSnapshots);
    }

    this.persist();
    return snapshot;
  }

  /** Most recent snapshots, oldest first. */
  getSnapshots(limit = 100): PortfolioHistorySnapshot[] {
    const lim = Math.max(1, Math.trunc(limit) || 100);
    return this.snapshots.slice(-lim);
  }

  getLatest(): PortfolioHistorySnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  clear(): void {
    this.snapshots = [];
    this.persist(true);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persist(force = false): void {
    if (!this.options.persist) return;
    const now = Date.now();
    if (!force && now - this.lastPersistedAt < this.options.minIntervalMs) return;
    this.lastPersistedAt = now;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      writeFileAtomic(this.options.path, JSON.stringify(this.snapshots));
    } catch (err) {
      console.error("[portfolio-history] failed to persist snapshots:", err);
    }
  }

  private load(): void {
    if (!this.options.persist) return;
    try {
      const raw = readFileSync(this.options.path, "utf8");
      const parsed = JSON.parse(raw) as PortfolioHistorySnapshot[];
      if (Array.isArray(parsed)) {
        this.snapshots = parsed.slice(-this.options.maxSnapshots);
      }
    } catch {
      // No persisted history yet (or unreadable) — start empty.
    }
  }
}
