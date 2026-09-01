/**
 * metrics.ts — pure risk metric functions
 * No side-effects, no I/O. Deterministic, test-friendly.
 */

/**
 * Calculate portfolio exposure as percentage.
 * Supports multiple call signatures for flexibility:
 * - calculateExposure(positionValues: number[], totalValue: number)
 * - calculateExposure(positionValue: number, totalValue: number)
 * - calculateExposure(positions: Map<string, number>, totalValue: number)
 * - calculateExposure(positions: Map<string, {value:number}>, totalValue: number)
 * - calculateExposure(positionValues: number[]) with implied total = sum + cash fallback
 */
export function calculateExposure(
  positionValues: number | number[] | Map<string, number | { value: number }>,
  totalValue?: number,
): number {
  let positionSum = 0;

  if (typeof positionValues === "number") {
    positionSum = positionValues;
  } else if (Array.isArray(positionValues)) {
    positionSum = positionValues.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  } else if (positionValues instanceof Map) {
    for (const v of positionValues.values()) {
      if (typeof v === "number") {
        positionSum += Number.isFinite(v) ? v : 0;
      } else if (v && typeof (v as { value: number }).value === "number") {
        const n = (v as { value: number }).value;
        positionSum += Number.isFinite(n) ? n : 0;
      }
    }
  } else {
    return 0;
  }

  // If totalValue not provided or invalid, use positionSum as total (0% edge)
  // caller should pass totalValue; if missing we fallback to positionSum or 1 to avoid NaN
  const total = typeof totalValue === "number" && Number.isFinite(totalValue) && totalValue > 0
    ? totalValue
    : positionSum > 0 ? positionSum : 1;

  if (total <= 0) return 0;
  const pct = (positionSum / total) * 100;
  return Math.max(0, Math.round(pct * 100) / 100);
}

/**
 * Calculate drawdown percentage.
 * - calculateDrawdown(currentValue: number, peakValue: number)
 * - calculateDrawdown(values: number[]) => max drawdown from history
 */
export function calculateDrawdown(
  currentOrValues: number | number[],
  peakValue?: number,
): number {
  // Array signature: max drawdown
  if (Array.isArray(currentOrValues)) {
    const values = currentOrValues;
    if (values.length === 0) return 0;
    let peak = values[0]!;
    let maxDd = 0;
    for (const v of values) {
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = ((peak - v) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }
    }
    return Math.round(maxDd * 100) / 100;
  }

  // Two-number signature
  const current = currentOrValues as number;
  const peak = peakValue as number;
  if (!Number.isFinite(current) || !Number.isFinite(peak) || peak <= 0) return 0;
  if (current >= peak) return 0;
  const dd = ((peak - current) / peak) * 100;
  return Math.round(dd * 100) / 100;
}

/**
 * Historical Value at Risk (VaR).
 * Returns positive number representing loss magnitude at given confidence.
 * e.g., confidence 0.95 => 5th percentile loss.
 * - calculateVaR(returns: number[], confidence?: number)
 */
export function calculateVaR(returns: number[], confidence = 0.95): number {
  if (!Array.isArray(returns) || returns.length === 0) return 0;
  if (confidence <= 0 || confidence >= 1) confidence = 0.95;

  const sorted = [...returns].sort((a, b) => a - b);
  // historical VaR: percentile at (1 - confidence)
  // e.g., 95% confidence => 5% worst
  const n = sorted.length;
  const percentile = 1 - confidence;
  // Use floor index; for n=5, 5% => index 0 (worst loss)
  let index = Math.floor(percentile * n);
  // clamp
  if (index < 0) index = 0;
  if (index >= n) index = n - 1;

  // For even more accurate interpolation (linear), but floor is deterministic and test-friendly
  const varReturn = sorted[index]!;
  // VaR is typically expressed as positive loss; if worst return is positive, VaR is negative or zero
  // We return -varReturn but floored at 0 if gains
  const varValue = -varReturn;
  // Round to 4 decimals for small returns, but keep general rounding
  const rounded = Math.round(varValue * 10000) / 10000;
  // If VaR negative (meaning portfolio gains even at worst), return 0 (no risk)
  return rounded < 0 ? 0 : rounded;
}

/**
 * Sharpe ratio: mean excess return / std dev
 * Annualization left to caller; this returns period Sharpe.
 * Handles population std dev for determinism.
 * - calculateSharpe(returns: number[], riskFreeRate?: number)
 */
export function calculateSharpe(returns: number[], riskFreeRate = 0): number {
  if (!Array.isArray(returns) || returns.length === 0) return 0;
  if (returns.length < 2) return 0;

  const excess = returns.map((r) => r - riskFreeRate);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;

  // population standard deviation
  const variance = excess.reduce((acc, r) => acc + (r - mean) ** 2, 0) / excess.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  const sharpe = mean / stdDev;
  // round to 4 decimals
  return Math.round(sharpe * 10000) / 10000;
}
