// ============================================================================
// Execution Pipeline — Validation
// Pure validation for PipelineSignal. No side effects.
// ============================================================================

import type { PipelineSignal } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  normalized?: PipelineSignal;
}

const VALID_SIDE = new Set(["buy", "sell"]);
const VALID_TYPE = new Set(["market", "limit"]);

export function validateSignal(signal: unknown): ValidationResult {
  if (!signal || typeof signal !== "object") {
    return { valid: false, reason: "signal is required and must be an object" };
  }
  const s = signal as Partial<PipelineSignal>;

  if (!s.symbol || typeof s.symbol !== "string" || s.symbol.trim() === "") {
    return { valid: false, reason: "symbol is required (non-empty string)" };
  }
  const symbol = s.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}USDT$|^[A-Z0-9]{2,12}$/.test(symbol)) {
    return { valid: false, reason: `symbol '${s.symbol}' is not valid` };
  }

  const sideRaw = (s.side as string | undefined)?.toString().toLowerCase();
  if (!sideRaw || !VALID_SIDE.has(sideRaw)) {
    return { valid: false, reason: "side must be 'buy' or 'sell'" };
  }

  if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity) || s.quantity <= 0) {
    return { valid: false, reason: "quantity must be a positive number" };
  }

  if (typeof s.price !== "number" || !Number.isFinite(s.price) || s.price <= 0) {
    return { valid: false, reason: "price must be a positive number" };
  }

  if (!s.agentId || typeof s.agentId !== "string" || s.agentId.trim() === "") {
    return { valid: false, reason: "agentId is required" };
  }

  if (s.type !== undefined && s.type !== null) {
    const t = String(s.type).toLowerCase();
    if (!VALID_TYPE.has(t)) {
      return { valid: false, reason: "type must be 'market' or 'limit' if provided" };
    }
  }

  if (s.correlationId !== undefined && s.correlationId !== null && typeof s.correlationId !== "string") {
    return { valid: false, reason: "correlationId must be a string if provided" };
  }

  if (s.confidence !== undefined && s.confidence !== null) {
    if (typeof s.confidence !== "number" || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1) {
      return { valid: false, reason: "confidence must be a number between 0 and 1 if provided" };
    }
  }

  const normalized: PipelineSignal = {
    id: typeof s.id === "string" && s.id.trim() !== "" ? s.id.trim() : undefined,
    symbol,
    side: sideRaw as "buy" | "sell",
    quantity: s.quantity,
    price: s.price,
    type: s.type ? (String(s.type).toLowerCase() as "market" | "limit") : "market",
    strategy: typeof s.strategy === "string" ? s.strategy : undefined,
    agentId: s.agentId.trim(),
    correlationId: typeof s.correlationId === "string" ? s.correlationId : undefined,
    confidence: typeof s.confidence === "number" ? s.confidence : undefined,
    timestamp: typeof s.timestamp === "number" ? s.timestamp : Date.now(),
  };

  return { valid: true, normalized };
}

export function validateNotional(signal: PipelineSignal, maxOrderValue?: number): ValidationResult {
  if (maxOrderValue !== undefined && maxOrderValue > 0) {
    const notional = signal.quantity * signal.price;
    if (notional > maxOrderValue) {
      return { valid: false, reason: `notional ${notional.toFixed(2)} exceeds maxOrderValue ${maxOrderValue}` };
    }
  }
  return { valid: true, normalized: signal };
}
