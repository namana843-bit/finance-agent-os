// ============================================================================
// Finance Agent OS — Typed Event Bus
// Strongly typed event-driven architecture for finance
// ============================================================================

import { randomUUID } from "node:crypto";
import type { FinanceEvent, EventInput, EventHandler, HistoryFilter } from "@finance/shared";

export interface EventBusOptions {
  maxHistory?: number;
}

export class TypedEventBus {
  private history: FinanceEvent[] = [];
  private subscribers = new Map<string, Set<EventHandler>>();
  private globalSubscribers = new Set<EventHandler>();
  private readonly maxHistory: number;

  constructor(opts: EventBusOptions = {}) {
    this.maxHistory = opts.maxHistory ?? 10_000;
  }

  /**
   * Publish an event. Auto-generates id + timestamp if missing.
   */
  publish(input: EventInput): FinanceEvent {
    if (!input.type || typeof input.type !== "string") {
      throw new Error("Event type is required and must be a string");
    }

    const event: FinanceEvent = {
      id: input.id ?? randomUUID(),
      type: input.type,
      data: input.data ?? null,
      timestamp: input.timestamp ?? Date.now(),
      source: input.source,
      correlationId: input.correlationId,
      metadata: input.metadata,
      agentId: input.agentId,
      runId: input.runId,
      channelId: input.channelId,
      threadId: input.threadId,
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    // Notify global subscribers
    for (const handler of this.globalSubscribers) {
      this.safeNotify(handler, event);
    }

    // Notify type-specific subscribers
    const typeSubscribers = this.subscribers.get(event.type);
    if (typeSubscribers) {
      for (const handler of typeSubscribers) {
        this.safeNotify(handler, event);
      }
    }

    // Notify wildcard subscribers (type contains "*")
    for (const [pattern, handlers] of this.subscribers) {
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        if (regex.test(event.type)) {
          for (const handler of handlers) {
            this.safeNotify(handler, event);
          }
        }
      }
    }

    return event;
  }

  /**
   * Subscribe to all events.
   */
  subscribe(handler: EventHandler): () => void {
    this.globalSubscribers.add(handler);
    return () => {
      this.globalSubscribers.delete(handler);
    };
  }

  /**
   * Subscribe to a specific event type.
   */
  subscribeTo(type: string, handler: EventHandler): () => void {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    this.subscribers.get(type)!.add(handler);
    return () => {
      this.subscribers.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe with a filter predicate.
   */
  subscribeFiltered(filter: HistoryFilter, handler: EventHandler): () => void {
    const wrapped: EventHandler = (event) => {
      if (this.matchesFilter(event, filter)) {
        return handler(event);
      }
    };
    return this.subscribe(wrapped);
  }

  /**
   * Unsubscribe a handler from all subscriptions.
   */
  unsubscribe(handler: EventHandler): void {
    this.globalSubscribers.delete(handler);
    for (const handlers of this.subscribers.values()) {
      handlers.delete(handler);
    }
  }

  /**
   * Get history, optionally filtered and limited.
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
   */
  async replay(handler: EventHandler, filter?: HistoryFilter): Promise<number> {
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

  /** Total events in history. */
  size(): number {
    return this.history.length;
  }

  /** Clear history (useful for tests). */
  clear(): void {
    this.history = [];
  }

  /** Number of active global subscribers. */
  subscriberCount(): number {
    return this.globalSubscribers.size;
  }

  /** Number of type-specific subscriber groups. */
  subscriptionGroups(): number {
    return this.subscribers.size;
  }

  private safeNotify(handler: EventHandler, event: FinanceEvent): void {
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

  private matchesFilter(event: FinanceEvent, filter: HistoryFilter): boolean {
    if (filter.type !== undefined && event.type !== filter.type) return false;
    if (filter.source !== undefined && event.source !== filter.source) return false;
    if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) return false;
    if (filter.channelId !== undefined && event.channelId !== filter.channelId) return false;
    if (filter.threadId !== undefined && event.threadId !== filter.threadId) return false;
    if (filter.agentId !== undefined && event.agentId !== filter.agentId) return false;
    if (filter.runId !== undefined && event.runId !== filter.runId) return false;
    if (filter.since !== undefined && event.timestamp < filter.since) return false;
    if (filter.until !== undefined && event.timestamp > filter.until) return false;
    return true;
  }
}
