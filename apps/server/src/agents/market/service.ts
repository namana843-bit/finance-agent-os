export const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "EURUSD", "AAPL", "SPY"] as const;

export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export interface Tick {
  symbol: string;
  price: number;
  change: number;
  volume: number;
  timestamp: number;
  source: "binance" | "synthetic";
}

export const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 68120.5,
  ETHUSDT: 3450.12,
  EURUSD: 1.0854,
  AAPL: 227.48,
  SPY: 578.32,
};

export function isSupportedSymbol(symbol: string): boolean {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(symbol.toUpperCase());
}

export function generateSyntheticTick(symbol: string, prevPrice?: number): Tick {
  const sym = symbol.toUpperCase();
  const base = BASE_PRICES[sym] ?? 100;
  const last = prevPrice ?? base;
  const volatility = sym === "BTCUSDT" ? 0.002 : sym === "ETHUSDT" ? 0.003 : sym === "EURUSD" ? 0.0008 : 0.0015;
  const delta = (Math.random() - 0.5) * 2 * last * volatility;
  const price = Math.max(last + delta, base * 0.5);
  const change = price - last;
  const volume = Number((Math.random() * 800 + 50).toFixed(2));
  return {
    symbol: sym,
    price: Number(price.toFixed(sym === "EURUSD" ? 4 : 2)),
    change: Number(change.toFixed(sym === "EURUSD" ? 4 : 2)),
    volume,
    timestamp: Date.now(),
    source: "synthetic",
  };
}

export async function fetchBinancePrice(symbol: string): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res: any = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { symbol: string; price: string };
    const n = Number(data.price);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchTick(symbol: string, prevPrice?: number): Promise<Tick> {
  const sym = symbol.toUpperCase();
  const binancePrice = await fetchBinancePrice(sym);
  if (binancePrice !== null) {
    const last = prevPrice ?? BASE_PRICES[sym] ?? binancePrice;
    const change = binancePrice - last;
    return {
      symbol: sym,
      price: Number(binancePrice.toFixed(sym === "EURUSD" ? 4 : 2)),
      change: Number(change.toFixed(sym === "EURUSD" ? 4 : 2)),
      volume: Number((Math.random() * 800 + 50).toFixed(2)),
      timestamp: Date.now(),
      source: "binance",
    };
  }
  return generateSyntheticTick(sym, prevPrice);
}
