// ============================================================================
// Execution Pipeline — Audit Log
// In-memory audit store for pipeline stages. Mirrors AuditLogger shape but
// keeps pipeline-specific entries with stage/approved/reason + event emission.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { AuditEntry } from "./types.js";

export class PipelineAuditLog {
  private entries: AuditEntry[] = [];
  private maxEntries = 5000;

  constructor(private bus?: TypedEventBus) {}

  record(entry: Omit<AuditEntry, "id" | "timestamp"> & { id?: string; timestamp?: number }): AuditEntry {
    const full: AuditEntry = {
      id: entry.id ?? `pipeline-audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: entry.timestamp ?? Date.now(),
      correlationId: entry.correlationId,
      signalId: entry.signalId,
      stage: entry.stage,
      eventType: entry.eventType,
      approved: entry.approved,
      reason: entry.reason,
      details: entry.details,
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    // also forward to bus as audit-like event if bus available
    if (this.bus) {
      this.bus.publish({
        type: full.eventType,
        data: { auditId: full.id, correlationId: full.correlationId, signalId: full.signalId, stage: full.stage, approved: full.approved, reason: full.reason, details: full.details, timestamp: full.timestamp },
        source: "execution-pipeline",
        correlationId: full.correlationId,
      });
    }
    return full;
  }

  list(filter?: { correlationId?: string; signalId?: string; stage?: string; limit?: number }): AuditEntry[] {
    let out = this.entries;
    if (filter?.correlationId) out = out.filter((e) => e.correlationId === filter.correlationId);
    if (filter?.signalId) out = out.filter((e) => e.signalId === filter.signalId);
    if (filter?.stage) out = out.filter((e) => e.stage === filter.stage);
    if (filter?.limit) out = out.slice(-filter.limit);
    return [...out];
  }

  getByCorrelationId(correlationId: string): AuditEntry[] {
    return this.list({ correlationId });
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
