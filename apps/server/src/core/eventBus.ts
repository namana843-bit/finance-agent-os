import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Event type — OpenBot-style
// ---------------------------------------------------------------------------

export interface FinanceEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
  channelId?: string;
  threadId?: string;
  agentId?: string;
  runId?: string;
  /** Optional origin, e.g. "market-agent", "tool:validate-symbol", "runtime" */
  source?: string;
  /** Propagated across pipeline (tick -> signal -> risk -> order -> fill) */
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export type EventInput = Omit<FinanceEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: number;
};

export type EventHandler = (event: FinanceEvent) => void | Promise<void>;

export interface HistoryFilter {
  type?: string;
  /** Match colon or dot notation interchangeably (market:tick == market.tick) */
  channelId?: string;
  threadId?: string;
  agentId?: string;
  runId?: string;
  source?: string;
  correlationId?: string;
  since?: number;
  until?: number;
}

export interface EventBusOptions {
  maxHistory?: number;
}

// ---------------------------------------------------------------------------
// Typed Event Bus with history + replay
// ---------------------------------------------------------------------------

export class EventBus {
  private history: FinanceEvent[] = [];
  private subscribers = new Set<EventHandler>();
  private readonly maxHistory: number;

  constructor(opts: EventBusOptions = {}) {
    this.maxHistory = opts.maxHistory ?? 10_000;
  }

  /**
   * Publish an event. Auto-generates id + timestamp if missing,
   * pushes to history, and notifies all subscribers.
   */
  publish(input: EventInput): FinanceEvent {
    if (!input.type || typeof input.type !== "string") {
      throw new Error("Event type is required and must be a string");
    }

    const event: FinanceEvent = {
      id: input.id ?? randomUUID(),
      type: normalizeEventType(input.type),
      data: input.data ?? null,
      timestamp: input.timestamp ?? Date.now(),
      channelId: input.channelId,
      threadId: input.threadId,
      agentId: input.agentId,
      runId: input.runId,
      source: input.source,
      correlationId: input.correlationId,
      metadata: input.metadata,
    };

    this.history.push(event);

    // Trim history to maxHistory
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    // Notify subscribers (fire-and-forget, isolate errors)
    for (const handler of this.subscribers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error("[eventBus] async handler error:", err);
          });
        }
      } catch (err) {
        console.error("[eventBus] handler error:", err);
      }
    }

    return event;
  }

  /**
   * Subscribe to all future events.
   * Returns an unsubscribe function.
   */
  subscribe(handler: EventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Subscribe with a filter predicate. Only matching events are forwarded.
   */
  subscribeFiltered(
    filter: HistoryFilter,
    handler: EventHandler,
  ): () => void {
    const wrapped: EventHandler = (event) => {
      if (this.matchesFilter(event, filter)) {
        return handler(event);
      }
    };
    return this.subscribe(wrapped);
  }

  /**
   * Get history, optionally filtered and limited.
   * Returns oldest-first order.
   */
  getHistory(filter?: HistoryFilter, limit?: number): FinanceEvent[] {
    let result = this.history;

    if (filter) {
      result = result.filter((e) => this.matchesFilter(e, filter));
    }

    if (limit !== undefined && limit !== null) {
      if (limit <= 0) return [];
      result = result.slice(-limit);
    }

    return [...result];
  }

  /**
   * Replay history to a handler.
   * If `filter` is provided only matching events are replayed.
   * If `since` timestamp is set inside filter, events after that are replayed.
   */
  async replay(
    handler: EventHandler,
    filter?: HistoryFilter,
  ): Promise<number> {
    const events = this.getHistory(filter);
    for (const event of events) {
      try {
        await handler(event);
      } catch (err) {
        console.error("[eventBus] replay handler error:", err);
      }
    }
    return events.length;
  }

  /**
   * Return total number of events stored.
   */
  size(): number {
    return this.history.length;
  }

  /**
   * Clear history (useful for tests).
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Number of active subscribers.
   */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  private matchesFilter(event: FinanceEvent, filter: HistoryFilter): boolean {
    if (filter.type !== undefined && !eventTypesEqual(event.type, filter.type)) return false;
    if (filter.channelId !== undefined && event.channelId !== filter.channelId)
      return false;
    if (filter.threadId !== undefined && event.threadId !== filter.threadId)
      return false;
    if (filter.agentId !== undefined && event.agentId !== filter.agentId)
      return false;
    if (filter.runId !== undefined && event.runId !== filter.runId)
      return false;
    if (filter.source !== undefined && event.source !== filter.source)
      return false;
    if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId)
      return false;
    if (filter.since !== undefined && event.timestamp < filter.since)
      return false;
    if (filter.until !== undefined && event.timestamp > filter.until)
      return false;
    return true;
  }
}

/**
 * Canonical finance event names (colon notation preserved for backward
 * compat with dashboard + 5 existing agents). Dot notation is accepted
 * anywhere and normalized to colon form on publish.
 */
export const FINANCE_EVENTS = {
  MARKET_TICK: "market:tick",
  SIGNAL_BUY: "signal:buy",
  SIGNAL_SELL: "signal:sell",
  SIGNAL_HOLD: "signal:hold",
  RISK_APPROVED: "risk:approved",
  RISK_REJECTED: "risk:rejected",
  PORTFOLIO_ORDER: "portfolio:order",
  PORTFOLIO_UPDATE: "portfolio:update",
  EXECUTION_FILLED: "execution:filled",
  EXECUTION_REJECTED: "execution:rejected",
  AGENT_STARTED: "agent.started",
  AGENT_STOPPED: "agent.stopped",
  AGENT_ERROR: "agent.error",
  TOOL_CALLED: "tool.called",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  SYSTEM_READY: "system.ready",
  SYSTEM_STOPPED: "system.stopped",
} as const;

/** Normalize dot notation (market.tick) to canonical colon form (market:tick). */
export function normalizeEventType(type: string): string {
  if (typeof type !== "string") return type;
  const t = type.trim();
  // agent.* / tool.* / system.* already use dots — keep them
  if (t.startsWith("agent.") || t.startsWith("tool.") || t.startsWith("system.")) return t;
  if (t.includes(".") && !t.includes(":")) {
    const [domain, ...rest] = t.split(".");
    return `${domain}:${rest.join(".")}`;
  }
  return t;
}

/** Compare event types ignoring dot/colon style differences. */
export function eventTypesEqual(a: string, b: string): boolean {
  return normalizeEventType(a) === normalizeEventType(b);
}

// Singleton default bus for convenience
export const eventBus = new EventBus();

export default EventBus;
