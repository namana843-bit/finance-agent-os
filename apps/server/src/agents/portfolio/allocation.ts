/**
 * allocation.ts — portfolio allocation helpers
 * Pure functions, deterministic, test-friendly.
 */

/**
 * Kelly Criterion fraction.
 *
 * Classic formula: f = p - (1 - p) / b
 * where p = win probability (0-1), b = win/loss ratio (avgWin / avgLoss).
 *
 * Supports signatures:
 * - kellyCriterion(winProb, winLossRatio)
 * - kellyCriterion(winProb, avgWin, avgLoss)
 *
 * Returns fraction of capital to risk (0..1), floored at 0 if negative.
 * Rounded to 4 decimals.
 */
export function kellyCriterion(
  winProb: number,
  winLossRatioOrAvgWin: number,
  avgLoss?: number,
): number {
  if (!Number.isFinite(winProb) || !Number.isFinite(winLossRatioOrAvgWin)) return 0;
  if (winProb < 0) winProb = 0;
  if (winProb > 1) winProb = 1;

  let b: number;

  if (avgLoss !== undefined) {
    const avgWin = winLossRatioOrAvgWin;
    if (!Number.isFinite(avgLoss) || avgLoss <= 0) return 0;
    if (!Number.isFinite(avgWin) || avgWin <= 0) return 0;
    b = avgWin / avgLoss;
  } else {
    b = winLossRatioOrAvgWin;
  }

  if (!Number.isFinite(b) || b <= 0) return 0;

  const q = 1 - winProb;
  const f = winProb - q / b;

  // Floor at 0, cap at 1 (leverage not allowed via Kelly)
  const clamped = Math.max(0, Math.min(1, f));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Position sizing — 1% risk per trade by default.
 *
 * qty = (cash * riskPct) / price
 *
 * Signatures:
 * - positionSizing(cash, price, riskPct?)
 * - positionSizing(cash, price) -> uses 0.01
 *
 * Returns qty rounded to 6 decimals (preserves fractional for crypto).
 * Matches spec exactly: qty = (cash*0.01)/price
 * If price <=0 or cash <=0 returns 0.
 */
export function positionSizing(
  cash: number,
  price: number,
  riskPct = 0.01,
): number {
  if (!Number.isFinite(cash) || !Number.isFinite(price) || !Number.isFinite(riskPct)) return 0;
  if (cash <= 0 || price <= 0 || riskPct <= 0) return 0;
  if (riskPct > 1) riskPct = 1;

  const raw = (cash * riskPct) / price;
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  // Spec-exact: return raw rounded to 6 decimals (supports both stocks and crypto).
  // For integer-share semantics, callers may floor externally; we preserve exact sizing.
  return Math.round(raw * 1e6) / 1e6;
}

/**
 * Rebalance weights.
 *
 * Computes delta between current and target allocations.
 *
 * Signatures:
 * - rebalanceWeights(current: Record<string, number>, target: Record<string, number>)
 *   -> returns Record<string, number> delta weights (target - current), normalized
 *
 * - rebalanceWeights(current, target, totalValue, prices)
 *   -> returns array of trades { symbol, currentWeight, targetWeight, deltaWeight, deltaValue, qty }
 *
 * All weights expected as decimals (0..1) or percentages (0..100). Function normalizes
 * internally if sum > 1.1 (assumes percentages).
 */
export interface RebalanceTrade {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  deltaWeight: number;
  deltaValue: number;
  qty: number;
  side: "buy" | "sell" | "hold";
}

export function rebalanceWeights(
  current: Record<string, number> | Map<string, number>,
  target: Record<string, number> | Map<string, number>,
  totalValue?: number,
  prices?: Record<string, number> | Map<string, number>,
): Record<string, number> | RebalanceTrade[] {
  const toRecord = (m: Record<string, number> | Map<string, number>): Record<string, number> => {
    if (m instanceof Map) {
      const r: Record<string, number> = {};
      for (const [k, v] of m.entries()) r[k.toUpperCase()] = v;
      return r;
    }
    const r: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) r[k.toUpperCase()] = v;
    return r;
  };

  const cur = toRecord(current);
  const tgt = toRecord(target);

  // Normalize if weights look like percentages (>1.5 sum)
  const normalize = (weights: Record<string, number>): Record<string, number> => {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum > 1.5) {
      // assume percentages
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(weights)) out[k] = v / 100;
      return out;
    }
    return { ...weights };
  };

  const curNorm = normalize(cur);
  const tgtNorm = normalize(tgt);

  // Collect all symbols
  const symbols = new Set([...Object.keys(curNorm), ...Object.keys(tgtNorm)]);

  // Normalize target to sum 1 if needed
  const tgtSum = Object.values(tgtNorm).reduce((a, b) => a + b, 0);
  let tgtAdj = tgtNorm;
  if (tgtSum > 0 && Math.abs(tgtSum - 1) > 0.0001) {
    tgtAdj = {};
    for (const [k, v] of Object.entries(tgtNorm)) tgtAdj[k] = v / tgtSum;
  }

  // If totalValue and prices provided, return trades
  if (typeof totalValue === "number" && prices !== undefined) {
    const priceRecord = toRecord(prices as Record<string, number> | Map<string, number>);
    const trades: RebalanceTrade[] = [];
    for (const sym of symbols) {
      const cW = curNorm[sym] ?? 0;
      const tW = tgtAdj[sym] ?? 0;
      const dW = Math.round((tW - cW) * 10000) / 10000;
      const dVal = Math.round(dW * totalValue * 100) / 100;
      const price = priceRecord[sym] ?? 0;
      let qty = 0;
      if (price > 0) {
        const rawQty = dVal / price;
        qty = Math.round(rawQty * 1e6) / 1e6;
      }
      const side: "buy" | "sell" | "hold" = dW > 0.00001 ? "buy" : dW < -0.00001 ? "sell" : "hold";
      trades.push({
        symbol: sym,
        currentWeight: Math.round(cW * 10000) / 10000,
        targetWeight: Math.round(tW * 10000) / 10000,
        deltaWeight: dW,
        deltaValue: dVal,
        qty: Math.abs(qty) < 0.000001 ? 0 : qty,
        side,
      });
    }
    // Sort by symbol for determinism
    trades.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return trades;
  }

  // Otherwise return delta weights map
  const delta: Record<string, number> = {};
  for (const sym of symbols) {
    const cW = curNorm[sym] ?? 0;
    const tW = tgtAdj[sym] ?? 0;
    delta[sym] = Math.round((tW - cW) * 10000) / 10000;
  }
  return delta;
}
