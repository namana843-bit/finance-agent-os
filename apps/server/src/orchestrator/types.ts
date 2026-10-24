// ============================================================================
// Trade Workflow Orchestrator — Types
// Research -> Strategy Proposal -> Risk Review -> User Approval ->
// Paper Execution -> Portfolio Update -> Audit Record
// Safety: proposals are brokered through the existing 7-stage ExecutionPipeline;
// LLM output can never bypass risk, permission, or approval gates.
// ============================================================================

export type WorkflowStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "user_rejected"
  | "failed";

export type WorkflowStage =
  | "research"
  | "proposal"
  | "risk_review"
  | "awaiting_approval"
  | "paper_execution"
  | "portfolio_update"
  | "audit_record"
  | "done";

export interface WorkflowAgentStep {
  agentId: string;
  stage: WorkflowStage;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  /** Final text/JSON output of the agent (secrets sanitized upstream). */
  output?: string;
  error?: string;
}

export interface WorkflowProposal {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  type: "market" | "limit";
  rationale: string;
  assumptions?: string;
}

export interface RiskReview {
  agentId: string;
  verdict: "ok" | "concern" | "block";
  concerns: string[];
  notes?: string;
}

export interface ApprovalInfo {
  decidedAt: string;
  decision: "approved" | "rejected";
  /** A user-declared reason is always required for an auditable rejection. */
  reason?: string;
  /** The exact order params the user typed to approve this proposal. */
  confirmed?: { symbol: string; side: "buy" | "sell"; quantity: number };
}

export interface WorkflowRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: WorkflowStatus;
  stage: WorkflowStage;
  agents: WorkflowAgentStep[];
  proposal?: WorkflowProposal;
  riskReview?: RiskReview;
  riskDecision?: Record<string, unknown>;
  approval?: ApprovalInfo;
  execution?: {
    correlationId: string;
    signalId: string;
    success: boolean;
    stage: string;
    reason: string;
    order?: Record<string, unknown>;
    filledPrice?: number;
    filledQuantity?: number;
    fee?: number;
  };
  portfolioAfter?: Record<string, unknown>;
  auditIds: string[];
  error?: string;
}

export function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object") return false;
  const run = value as WorkflowRun;
  return typeof run.id === "string"
    && typeof run.createdAt === "string"
    && typeof run.status === "string"
    && Array.isArray(run.agents);
}

/** Validate an LLM-produced proposal into a strict, execution-safe object. */
export function validateProposal(raw: unknown): { valid: boolean; reason?: string; proposal?: WorkflowProposal } {
  if (!raw || typeof raw !== "object") return { valid: false, reason: "proposal is not an object" };
  const p = raw as Record<string, unknown>;
  const symbol = typeof p.symbol === "string" ? p.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { valid: false, reason: "proposal symbol is missing or invalid" };
  const side = p.side === "buy" || p.side === "sell" ? p.side : undefined;
  if (!side) return { valid: false, reason: "proposal side must be 'buy' or 'sell'" };
  const quantity = typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : NaN;
  if (!Number.isFinite(quantity) || quantity <= 0) return { valid: false, reason: "proposal quantity must be a positive number" };
  if (quantity > 10_000) return { valid: false, reason: "proposal quantity is unreasonably large (cap 10,000)" };
  const price = typeof p.price === "number" && Number.isFinite(p.price) ? p.price : NaN;
  if (!Number.isFinite(price) || price <= 0) return { valid: false, reason: "proposal price must be a positive number" };
  if (price > 10_000_000) return { valid: false, reason: "proposal price is unreasonably large (cap 10,000,000)" };
  const type = p.type === undefined || p.type === "market" ? "market" : p.type === "limit" ? "limit" : null;
  if (!type) return { valid: false, reason: "proposal type must be 'market' or 'limit'" };
  const rationale = typeof p.rationale === "string" && p.rationale.trim().length >= 10
    ? p.rationale.trim().slice(0, 4_000)
    : undefined;
  if (!rationale) return { valid: false, reason: "proposal rationale must be at least 10 characters" };
  const proposal: WorkflowProposal = {
    symbol,
    side,
    quantity: Math.round(quantity * 1e8) / 1e8,
    price: Math.round(price * 1e8) / 1e8,
    type,
    rationale,
    assumptions: typeof p.assumptions === "string" ? p.assumptions.slice(0, 4_000) : undefined,
  };
  return { valid: true, proposal };
}
