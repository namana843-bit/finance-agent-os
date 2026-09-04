// ============================================================================
// Execution Pipeline — Permission Check
// Pure permission logic reusing agent permissions shape from FinanceGateway.
// No live calls; checks canTrade, canSubmitOrders, maxOrderSize, maxDailyOrders,
// allowedSymbols, allowedStrategies.
// ============================================================================

import type { PipelineSignal } from "./types.js";

export interface PermissionInput {
  canTrade: boolean;
  canSubmitOrders: boolean;
  maxOrderSize: number;
  maxDailyOrders: number;
  allowedSymbols: string[];
  allowedStrategies: string[];
}

export const DEFAULT_PERMISSION: PermissionInput = {
  canTrade: true,
  canSubmitOrders: true,
  maxOrderSize: 50_000,
  maxDailyOrders: 100,
  allowedSymbols: [],
  allowedStrategies: [],
};

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export function checkPermission(
  signal: PipelineSignal,
  perms: PermissionInput | undefined,
  dailyCount: number,
): PermissionResult {
  const p = perms ?? DEFAULT_PERMISSION;

  if (!p.canTrade) {
    return { allowed: false, reason: `Agent '${signal.agentId}' is not allowed to trade` };
  }
  if (!p.canSubmitOrders) {
    return { allowed: false, reason: `Agent '${signal.agentId}' is not allowed to submit orders` };
  }
  if (p.maxOrderSize > 0) {
    const notional = signal.quantity * signal.price;
    if (notional > p.maxOrderSize) {
      return { allowed: false, reason: `Order value ${notional.toFixed(2)} exceeds max ${p.maxOrderSize}` };
    }
  }
  if (p.maxDailyOrders > 0 && dailyCount >= p.maxDailyOrders) {
    return { allowed: false, reason: `Daily order limit reached: ${dailyCount}/${p.maxDailyOrders}` };
  }
  if (p.allowedSymbols.length > 0) {
    const sym = signal.symbol.toUpperCase();
    if (!p.allowedSymbols.map((s) => s.toUpperCase()).includes(sym)) {
      return { allowed: false, reason: `Symbol '${signal.symbol}' not in allowed list for agent '${signal.agentId}'` };
    }
  }
  if (p.allowedStrategies.length > 0 && signal.strategy) {
    if (!p.allowedStrategies.includes(signal.strategy)) {
      return { allowed: false, reason: `Strategy '${signal.strategy}' not allowed for agent '${signal.agentId}'` };
    }
  }
  return { allowed: true };
}
