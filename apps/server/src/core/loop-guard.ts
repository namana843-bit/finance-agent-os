// ============================================================================
// Finance Agent OS — Loop Guard & Anti-Recursion Engine
// Phase 5: Reliability Agent — Prevents infinite event loops, recursive
// supervisor calls, agent ping-pong, and duplicate event processing.
// ============================================================================

export interface LoopGuardConfig {
  maxRecursionDepth: number; // Max chain depth per correlationId (default: 4)
  symbolCooldownMs: number; // Min cooldown between signals for same symbol (default: 2000ms)
  maxRetries: number; // Max retries per correlationId (default: 3)
  historyTtlMs: number; // TTL for tracked events (default: 5 min)
}

const DEFAULT_CONFIG: LoopGuardConfig = {
  maxRecursionDepth: 4,
  symbolCooldownMs: 2000,
  maxRetries: 3,
  historyTtlMs: 300_000,
};

export class LoopGuard {
  private config: LoopGuardConfig;
  private processedEvents = new Map<string, number>(); // eventId -> timestamp
  private correlationDepths = new Map<string, number>(); // correlationId -> current depth
  private symbolLastActivity = new Map<string, number>(); // symbol -> timestamp
  private retryCounts = new Map<string, number>(); // correlationId -> count

  constructor(config?: Partial<LoopGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Periodically clean stale event history
    setInterval(() => this.cleanup(), 60_000).unref();
  }

  /**
   * Check if an event has already been processed to prevent duplicate loops.
   */
  isDuplicateEvent(eventId: string): boolean {
    if (!eventId) return false;
    const existing = this.processedEvents.get(eventId);
    if (existing && Date.now() - existing < this.config.historyTtlMs) {
      return true;
    }
    return false;
  }

  /**
   * Record that an event has been processed.
   */
  recordEvent(eventId: string): void {
    if (eventId) {
      this.processedEvents.set(eventId, Date.now());
    }
  }

  /**
   * Enter a correlation trace step. Checks if recursion depth exceeds safety limit.
   */
  enterTrace(correlationId: string): { allowed: boolean; depth: number; reason?: string } {
    if (!correlationId) return { allowed: true, depth: 1 };

    const current = this.correlationDepths.get(correlationId) ?? 0;
    const next = current + 1;

    if (next > this.config.maxRecursionDepth) {
      return {
        allowed: false,
        depth: next,
        reason: `Recursion depth limit exceeded: depth=${next} > max=${this.config.maxRecursionDepth} for correlationId=${correlationId}`,
      };
    }

    this.correlationDepths.set(correlationId, next);
    return { allowed: true, depth: next };
  }

  /**
   * Exit a correlation trace step.
   */
  exitTrace(correlationId: string): void {
    if (!correlationId) return;
    const current = this.correlationDepths.get(correlationId) ?? 1;
    if (current <= 1) {
      this.correlationDepths.delete(correlationId);
    } else {
      this.correlationDepths.set(correlationId, current - 1);
    }
  }

  /**
   * Check per-symbol burst cooldown to prevent high-frequency agent ping-pong.
   */
  checkSymbolCooldown(symbol: string): { allowed: boolean; waitMs?: number } {
    const sym = symbol.toUpperCase();
    const last = this.symbolLastActivity.get(sym) ?? 0;
    const elapsed = Date.now() - last;

    if (elapsed < this.config.symbolCooldownMs) {
      return {
        allowed: false,
        waitMs: this.config.symbolCooldownMs - elapsed,
      };
    }

    this.symbolLastActivity.set(sym, Date.now());
    return { allowed: true };
  }

  /**
   * Check and record a retry for a correlationId.
   */
  recordRetry(correlationId: string): { allowed: boolean; retries: number } {
    const count = (this.retryCounts.get(correlationId) ?? 0) + 1;
    this.retryCounts.set(correlationId, count);

    if (count > this.config.maxRetries) {
      return { allowed: false, retries: count };
    }

    return { allowed: true, retries: count };
  }

  /**
   * Reset tracking state (useful for tests).
   */
  reset(): void {
    this.processedEvents.clear();
    this.correlationDepths.clear();
    this.symbolLastActivity.clear();
    this.retryCounts.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.processedEvents.entries()) {
      if (now - ts > this.config.historyTtlMs) {
        this.processedEvents.delete(id);
      }
    }
  }
}
