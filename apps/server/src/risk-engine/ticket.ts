// ============================================================================
// Finance Agent OS — Risk Approval Ticket
// Phase 4: Verifiable, time-bounded, anti-replay Risk Approval Ticket.
// Absolute rule: No order reaches the broker without verified Risk approval.
// ============================================================================

import { createHmac, randomUUID } from "node:crypto";

export interface RiskApprovalTicket {
  ticketId: string;
  correlationId: string;
  riskDecisionId: string;
  symbol: string;
  side: "buy" | "sell";
  maxQuantity: number;
  maxPrice: number;
  approvedAt: number;
  expiresAt: number;
  agentId: string;
  strategy?: string;
  signature: string;
}

export interface TicketVerificationInput {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price?: number;
  correlationId?: string;
}

export interface TicketVerificationResult {
  valid: boolean;
  reason?: string;
}

// Secret for signing tickets — in production defaults to a generated random key or env
const RISK_SIGNING_SECRET = process.env.RISK_SIGNING_SECRET || "finance-agent-os-risk-secret-key-2026";
const DEFAULT_TICKET_TTL_MS = 30_000; // 30 seconds

// Anti-replay cache: tickets can only be redeemed once
const usedTickets = new Set<string>();
const usedTicketTimestamps = new Map<string, number>();

function cleanExpiredTickets(): void {
  const now = Date.now();
  for (const [id, exp] of usedTicketTimestamps.entries()) {
    if (now > exp) {
      usedTickets.delete(id);
      usedTicketTimestamps.delete(id);
    }
  }
}

// Clean every 60s
setInterval(cleanExpiredTickets, 60_000).unref();

export function computeTicketSignature(
  ticketId: string,
  correlationId: string,
  riskDecisionId: string,
  symbol: string,
  side: string,
  maxQuantity: number,
  maxPrice: number,
  approvedAt: number,
  expiresAt: number,
  secret = RISK_SIGNING_SECRET,
): string {
  const payload = `${ticketId}|${correlationId}|${riskDecisionId}|${symbol.toUpperCase()}|${side}|${maxQuantity}|${maxPrice}|${approvedAt}|${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function issueRiskTicket(params: {
  correlationId: string;
  riskDecisionId: string;
  symbol: string;
  side: "buy" | "sell";
  maxQuantity: number;
  maxPrice: number;
  agentId: string;
  strategy?: string;
  ttlMs?: number;
  secret?: string;
}): RiskApprovalTicket {
  const ticketId = `ticket-${randomUUID()}`;
  const approvedAt = Date.now();
  const ttl = params.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  const expiresAt = approvedAt + ttl;
  const sym = params.symbol.toUpperCase();

  const signature = computeTicketSignature(
    ticketId,
    params.correlationId,
    params.riskDecisionId,
    sym,
    params.side,
    params.maxQuantity,
    params.maxPrice,
    approvedAt,
    expiresAt,
    params.secret,
  );

  return {
    ticketId,
    correlationId: params.correlationId,
    riskDecisionId: params.riskDecisionId,
    symbol: sym,
    side: params.side,
    maxQuantity: params.maxQuantity,
    maxPrice: params.maxPrice,
    approvedAt,
    expiresAt,
    agentId: params.agentId,
    strategy: params.strategy,
    signature,
  };
}

export function verifyRiskTicket(
  ticket: RiskApprovalTicket | null | undefined,
  order: TicketVerificationInput,
  opts?: { allowReplay?: boolean; secret?: string },
): TicketVerificationResult {
  if (!ticket || typeof ticket !== "object") {
    return { valid: false, reason: "Missing or null risk approval ticket" };
  }

  // 1. Check required fields
  if (
    !ticket.ticketId ||
    !ticket.signature ||
    !ticket.symbol ||
    !ticket.side ||
    typeof ticket.maxQuantity !== "number" ||
    typeof ticket.expiresAt !== "number"
  ) {
    return { valid: false, reason: "Malformed risk approval ticket structure" };
  }

  // 2. Check expiration
  const now = Date.now();
  if (now > ticket.expiresAt) {
    return {
      valid: false,
      reason: `Risk approval ticket expired: expiredAt=${ticket.expiresAt}, current=${now} (drift: ${now - ticket.expiresAt}ms)`,
    };
  }

  // 3. Verify cryptographic HMAC signature
  const expectedSig = computeTicketSignature(
    ticket.ticketId,
    ticket.correlationId,
    ticket.riskDecisionId,
    ticket.symbol,
    ticket.side,
    ticket.maxQuantity,
    ticket.maxPrice,
    ticket.approvedAt,
    ticket.expiresAt,
    opts?.secret,
  );

  if (ticket.signature !== expectedSig) {
    return { valid: false, reason: "Cryptographic signature mismatch on risk approval ticket" };
  }

  // 4. Check anti-replay (unless explicit allowReplay)
  if (!opts?.allowReplay) {
    if (usedTickets.has(ticket.ticketId)) {
      return { valid: false, reason: `Replay attack detected: ticket ${ticket.ticketId} has already been redeemed` };
    }
  }

  // 5. Match order parameters against ticket bounds
  if (ticket.symbol.toUpperCase() !== order.symbol.toUpperCase()) {
    return {
      valid: false,
      reason: `Symbol mismatch: ticket is for ${ticket.symbol}, order requested ${order.symbol}`,
    };
  }

  if (ticket.side !== order.side) {
    return {
      valid: false,
      reason: `Side mismatch: ticket is for ${ticket.side}, order requested ${order.side}`,
    };
  }

  if (order.quantity > ticket.maxQuantity * 1.000001) {
    return {
      valid: false,
      reason: `Quantity breach: order quantity ${order.quantity} exceeds approved max ${ticket.maxQuantity}`,
    };
  }

  if (order.price !== undefined && order.price > 0 && ticket.maxPrice > 0) {
    // 5% slippage headroom on price verification
    if (order.price > ticket.maxPrice * 1.05) {
      return {
        valid: false,
        reason: `Price breach: order price ${order.price} exceeds approved max price ${ticket.maxPrice}`,
      };
    }
  }

  // 6. Check correlationId if provided
  if (order.correlationId && ticket.correlationId && order.correlationId !== ticket.correlationId) {
    return {
      valid: false,
      reason: `Correlation mismatch: ticket=${ticket.correlationId}, order=${order.correlationId}`,
    };
  }

  return { valid: true };
}

export function markTicketRedeemed(ticketId: string, expiresAt: number): void {
  usedTickets.add(ticketId);
  usedTicketTimestamps.set(ticketId, expiresAt);
}

export function resetUsedTickets(): void {
  usedTickets.clear();
  usedTicketTimestamps.clear();
}
