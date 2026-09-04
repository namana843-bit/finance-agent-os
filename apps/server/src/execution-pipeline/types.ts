// ============================================================================
// Execution Pipeline — Types
// Safe pipeline: Signal -> Risk Engine -> Permission Check -> Paper Trading -> Result
// Live trading disabled by default. Every stage is audit-logged + event-driven.
// ============================================================================

import type { RiskDecision } from "../agents/risk/index.js";
import type { PaperOrder } from "../broker/paper-broker.js";

export interface PipelineSignal {
  id?: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  type?: "market" | "limit";
  strategy?: string;
  agentId: string;
  correlationId?: string;
  confidence?: number;
  timestamp?: number;
}

export interface PipelineConfig {
  /** Live trading must remain disabled unless explicitly enabled + env allows it */
  liveTradingEnabled: boolean;
  /** Enforce risk approval (default true) */
  requireRiskApproval: boolean;
  /** Enable audit log publishing (default true) */
  auditEnabled: boolean;
  /** Max notional per order for extra validation (optional) */
  maxOrderValue?: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  liveTradingEnabled: false,
  requireRiskApproval: true,
  auditEnabled: true,
};

export type PipelineStage =
  | "validation"
  | "risk"
  | "permission"
  | "paper"
  | "completed";

export type PipelineRejectionStage = "validation" | "risk" | "permission" | "paper" | "live_disabled";

export interface PipelineResult {
  success: boolean;
  stage: PipelineStage | PipelineRejectionStage;
  reason: string;
  correlationId: string;
  signalId: string;
  order?: PaperOrder;
  riskDecision?: RiskDecision;
  durationMs: number;
  auditIds: string[];
  timestamp: number;
}

export interface AuditEntry {
  id: string;
  correlationId: string;
  signalId: string;
  stage: string;
  eventType: string;
  approved: boolean | null;
  reason?: string;
  details: Record<string, unknown>;
  timestamp: number;
}

export const PIPELINE_EVENTS = {
  SIGNAL_RECEIVED: "execution.pipeline_signal_received",
  VALIDATED: "execution.pipeline_validated",
  VALIDATION_FAILED: "execution.pipeline_validation_failed",
  RISK_CHECKED: "execution.pipeline_risk_checked",
  RISK_REJECTED: "execution.pipeline_risk_rejected",
  PERMISSION_CHECKED: "execution.pipeline_permission_checked",
  PERMISSION_DENIED: "execution.pipeline_permission_denied",
  PAPER_EXECUTED: "execution.pipeline_paper_executed",
  PAPER_FAILED: "execution.pipeline_paper_failed",
  COMPLETED: "execution.pipeline_completed",
  REJECTED: "execution.pipeline_rejected",
  LIVE_BLOCKED: "execution.pipeline_live_blocked",
} as const;
