// ============================================================================
// Finance Agent OS — Audit Logger
// Phase 22: Complete financial audit logging
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

export interface AuditRecord {
  id: string;
  timestamp: number;
  eventType: string;
  source: string;
  agentId?: string;
  correlationId?: string;
  details: Record<string, unknown>;
}

export class AuditLogger {
  private records: AuditRecord[] = [];
  private maxRecords = 10_000;
  private unsubscribe: (() => void) | null = null;

  constructor(private bus: TypedEventBus) {}

  start(): void {
    // Listen to all events and create audit records
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      this.record(event);
    });
    console.log("[audit] logger started");
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    console.log("[audit] logger stopped");
  }

  record(event: FinanceEvent): void {
    const record: AuditRecord = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: event.timestamp || Date.now(),
      eventType: event.type,
      source: event.source ?? "unknown",
      agentId: event.agentId,
      correlationId: event.correlationId,
      details: typeof event.data === "object" ? (event.data as Record<string, unknown>) ?? {} : { data: event.data },
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  getRecords(filter?: { eventType?: string; agentId?: string; since?: number; limit?: number }): AuditRecord[] {
    let result = this.records;

    if (filter?.eventType) {
      result = result.filter((r) => r.eventType === filter.eventType);
    }
    if (filter?.agentId) {
      result = result.filter((r) => r.agentId === filter.agentId);
    }
    if (filter?.since) {
      result = result.filter((r) => r.timestamp >= filter.since!);
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }

    return [...result];
  }

  size(): number {
    return this.records.length;
  }
}
