// ============================================================================
// Finance Agent OS — Structured Trade Proposal
// Phase 5: Agent reasoning outputs structured proposals; free-form text
// must never directly create or place an order.
// ============================================================================

export interface EntryParameters {
  targetEntryPrice: number;
  orderType: "market" | "limit";
  timeInForce?: "GTC" | "IOC";
}

export interface RiskParameters {
  maxSlippagePct: number;
  positionLimitPct: number;
}

export interface TradeProposal {
  proposalId: string;
  correlationId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  strategy: string;
  confidence: number;
  reasoning: string;
  entryParameters: EntryParameters;
  riskParameters: RiskParameters;
  stopLoss?: number;
  takeProfit?: number;
  timeframe: string;
  timestamp: number;
  agentId: string;
}

export function validateTradeProposal(proposal: unknown): { valid: boolean; proposal?: TradeProposal; reason?: string } {
  if (!proposal || typeof proposal !== "object") {
    return { valid: false, reason: "TradeProposal must be an object" };
  }

  const p = proposal as Partial<TradeProposal>;

  if (!p.proposalId || typeof p.proposalId !== "string") {
    return { valid: false, reason: "Missing proposalId" };
  }
  if (!p.correlationId || typeof p.correlationId !== "string") {
    return { valid: false, reason: "Missing correlationId" };
  }
  if (!p.symbol || typeof p.symbol !== "string") {
    return { valid: false, reason: "Missing or invalid symbol" };
  }
  if (p.side !== "buy" && p.side !== "sell") {
    return { valid: false, reason: "side must be 'buy' or 'sell'" };
  }
  if (typeof p.quantity !== "number" || !Number.isFinite(p.quantity) || p.quantity <= 0) {
    return { valid: false, reason: "quantity must be a positive finite number" };
  }
  if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0) {
    return { valid: false, reason: "price must be a positive finite number" };
  }
  if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
    return { valid: false, reason: "confidence must be a number between 0 and 1" };
  }
  if (!p.strategy || typeof p.strategy !== "string") {
    return { valid: false, reason: "Missing strategy name" };
  }
  if (!p.reasoning || typeof p.reasoning !== "string") {
    return { valid: false, reason: "Missing reasoning explanation" };
  }
  if (!p.entryParameters || typeof p.entryParameters !== "object") {
    return { valid: false, reason: "Missing entryParameters" };
  }
  if (!p.riskParameters || typeof p.riskParameters !== "object") {
    return { valid: false, reason: "Missing riskParameters" };
  }

  return {
    valid: true,
    proposal: {
      ...p,
      symbol: p.symbol.toUpperCase(),
      timeframe: p.timeframe ?? "1h",
      timestamp: p.timestamp ?? Date.now(),
      agentId: p.agentId ?? "supervisor",
    } as TradeProposal,
  };
}

export interface CreateProposalOptions {
  proposalId?: string;
  correlationId?: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  strategy?: string;
  confidence?: number;
  reasoning: string;
  entryParameters?: Partial<EntryParameters>;
  riskParameters?: Partial<RiskParameters>;
  stopLoss?: number;
  takeProfit?: number;
  timeframe?: string;
  timestamp?: number;
  agentId?: string;
}

export function createTradeProposal(opts: CreateProposalOptions): TradeProposal {
  const proposal: TradeProposal = {
    proposalId: opts.proposalId ?? `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: opts.correlationId ?? `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: opts.symbol.toUpperCase(),
    side: opts.side,
    quantity: opts.quantity,
    price: opts.price,
    strategy: opts.strategy ?? "quantitative-confluence",
    confidence: opts.confidence ?? 0.8,
    reasoning: opts.reasoning,
    entryParameters: {
      targetEntryPrice: opts.entryParameters?.targetEntryPrice ?? opts.price,
      orderType: opts.entryParameters?.orderType ?? "market",
      timeInForce: opts.entryParameters?.timeInForce ?? "GTC",
    },
    riskParameters: {
      maxSlippagePct: opts.riskParameters?.maxSlippagePct ?? 0.01,
      positionLimitPct: opts.riskParameters?.positionLimitPct ?? 0.2,
    },
    stopLoss: opts.stopLoss,
    takeProfit: opts.takeProfit,
    timeframe: opts.timeframe ?? "tick",
    timestamp: opts.timestamp ?? Date.now(),
    agentId: opts.agentId ?? "supervisor",
  };

  const validation = validateTradeProposal(proposal);
  if (!validation.valid || !validation.proposal) {
    throw new Error(`Invalid TradeProposal parameters: ${validation.reason}`);
  }

  return validation.proposal;
}
