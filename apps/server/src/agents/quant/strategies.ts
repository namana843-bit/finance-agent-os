/**
 * strategies.ts — pure indicator functions
 * No side-effects, no I/O. Synthetic-friendly, deterministic.
 */

// ---------------------------------------------------------------------------
// SMA
// ---------------------------------------------------------------------------
export function sma(prices: number[], period: number): number | null {
  if (!Array.isArray(prices) || period <= 0) return null;
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// ---------------------------------------------------------------------------
// EMA — exponential moving average over the trailing `period`
// Uses SMA of first `period` as seed, then Wilder-style smoothing.
// Returns null if not enough data.
// ---------------------------------------------------------------------------
export function ema(prices: number[], period: number): number | null {
  if (!Array.isArray(prices) || period <= 0) return null;
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  // seed with SMA of first `period` values
  let emaVal = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    emaVal = prices[i]! * k + emaVal * (1 - k);
  }
  return emaVal;
}

/**
 * Helper: compute EMA series aligned to prices array (for MACD signal).
 * Returns array same length as prices where index < period-1 is null (via NaN sentinel internally)
 * but for simplicity we return full computed series starting at period-1.
 * Internal use for MACD.
 */
function emaSeries(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const series: number[] = [];
  if (prices.length < period) return series;
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series.push(prev); // corresponds to index period-1
  for (let i = period; i < prices.length; i++) {
    prev = prices[i]! * k + prev * (1 - k);
    series.push(prev);
  }
  return series;
}

// ---------------------------------------------------------------------------
// RSI — Wilder's RSI (0–100)
// ---------------------------------------------------------------------------
export function rsi(prices: number[], period = 14): number | null {
  if (!Array.isArray(prices) || period <= 0) return null;
  if (prices.length <= period) return null;

  // Need at least period+1 prices to compute period deltas
  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  // Wilder smoothing: for synthetic-friendly short buffers we use simple average of last `period` deltas.
  // For longer buffers, apply proper Wilder's smoothing (expanding from initial avg).
  // To keep pure and deterministic, if buffer is larger than period+1 we iteratively smooth.
  if (prices.length > period + 1) {
    // Recompute with Wilder's iterative method for accuracy over long series
    let avgGain = 0;
    let avgLoss = 0;
    // initial averages over first period deltas
    for (let i = 1; i <= period; i++) {
      const d = prices[i]! - prices[i - 1]!;
      if (d >= 0) avgGain += d;
      else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period + 1; i < prices.length; i++) {
      const d = prices[i]! - prices[i - 1]!;
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? Math.abs(d) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    gains = avgGain * period;
    losses = avgLoss * period;
    const avgG = gains / period;
    const avgL = losses / period;
    if (avgL === 0) return 100;
    const rs = avgG / avgL;
    return 100 - 100 / (1 + rs);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// MACD — (fast EMA - slow EMA) + signal EMA
// ---------------------------------------------------------------------------
export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  prices: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (!Array.isArray(prices)) return null;
  if (fastPeriod <= 0 || slowPeriod <= 0 || signalPeriod <= 0) return null;
  // Need at least slowPeriod + signalPeriod - 1 to have a meaningful signal
  const minLen = slowPeriod + signalPeriod;
  if (prices.length < minLen) return null;

  const fastEma = ema(prices, fastPeriod);
  const slowEma = ema(prices, slowPeriod);
  if (fastEma === null || slowEma === null) return null;

  // Build MACD line series to compute signal EMA
  // Compute macd line for each point where both EMAs are available
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);

  // Seed EMAs
  let emaFast = prices.slice(0, fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  let emaSlow = prices.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;

  // If fast < slow, we need to advance fast EMA to slowPeriod point before we start tracking macd series
  // Fast forward fast EMA from fastPeriod to slowPeriod-1
  for (let i = fastPeriod; i < slowPeriod; i++) {
    emaFast = prices[i]! * kFast + emaFast * (1 - kFast);
  }
  // At i = slowPeriod-1, emaSlow is seeded, emaFast already advanced
  const macdSeries: number[] = [];
  // First macd point at index slowPeriod-1
  macdSeries.push(emaFast - emaSlow);

  for (let i = slowPeriod; i < prices.length; i++) {
    emaFast = prices[i]! * kFast + emaFast * (1 - kFast);
    emaSlow = prices[i]! * kSlow + emaSlow * (1 - kSlow);
    macdSeries.push(emaFast - emaSlow);
  }

  // Current macd is last value
  const currentMacd = macdSeries[macdSeries.length - 1]!;

  // Signal line = EMA of macd series with signalPeriod
  if (macdSeries.length < signalPeriod) return null;
  const signalVal = ema(macdSeries, signalPeriod);
  if (signalVal === null) return null;

  return {
    macd: currentMacd,
    signal: signalVal,
    histogram: currentMacd - signalVal,
  };
}

// ---------------------------------------------------------------------------
// Bollinger Bands — middle = SMA(period), upper/lower = SMA +/- stdDev * σ
// ---------------------------------------------------------------------------
export interface BollingerBandsResult {
  middle: number;
  upper: number;
  lower: number;
  bandwidth: number;
  percentB: number;
}

export function bollingerBands(
  prices: number[],
  period = 20,
  stdDev = 2,
): BollingerBandsResult | null {
  if (!Array.isArray(prices) || period <= 0) return null;
  if (prices.length < period) return null;

  const slice = prices.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;

  // population standard deviation
  const variance = slice.reduce((acc, p) => acc + (p - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);

  const upper = middle + stdDev * sd;
  const lower = middle - stdDev * sd;

  const bandwidth = middle !== 0 ? (upper - lower) / middle : 0;
  const denom = upper - lower;
  const price = prices[prices.length - 1]!;
  const percentB = denom !== 0 ? (price - lower) / denom : 0.5;

  return { middle, upper, lower, bandwidth, percentB };
}
