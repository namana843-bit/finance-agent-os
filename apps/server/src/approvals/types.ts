import type { TypedEventBus } from "@finance/core";

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface TradeProposal {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  confidence?: number;
  reason?: string;
  strategy?: string;
  signalId?: string;
  threadId?: string | null;
  planId?: string | null;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  result?: unknown;
}

export interface ProposeInput {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  confidence?: number;
  reason?: string;
  strategy?: string;
  signalId?: string;
  threadId?: string | null;
  planId?: string | null;
  ttlMs?: number;
}

export type ApprovalMode = "auto-paper" | "always";

export interface ApprovalServiceOptions {
  bus: TypedEventBus;
  getPipeline?: () => { execute: (signal: Record<string, unknown>) => Promise<unknown> } | undefined;
  mode?: ApprovalMode;
  executionMode?: string;
  ttlMs?: number;
}

export class ApprovalError extends Error {
  code: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED" | "NO_PIPELINE";

  constructor(code: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED" | "NO_PIPELINE", message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}
