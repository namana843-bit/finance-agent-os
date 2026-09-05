// ============================================================================
// Finance Agent OS — Binance Market Data Normalizer
// Phase 6: Canonical normalized market event schemas & converters
// Converts Binance raw strings, satoshis, and payload variants into strongly
// typed, validated, and normalized data objects.
// ============================================================================

export interface NormalizedTick {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePercent24h: number;
  timestamp: number;
  source: "binance";
}

export interface NormalizedTrade {
  symbol: string;
  tradeId: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  isBuyerMaker: boolean;
  timestamp: number;
  source: "binance";
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface NormalizedOrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastUpdateId: number;
  timestamp: number;
  source: "binance";
}

export interface NormalizedKline {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isClosed: boolean;
  tradesCount: number;
  quoteVolume: number;
  timestamp: number;
  source: "binance";
}

/**
 * Normalizes trading pair symbol: converts to uppercase, removes slashes and hyphens.
 * e.g. "btc/usdt" -> "BTCUSDT", "ETH-USDT" -> "ETHUSDT"
 */
export function normalizeSymbol(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  return raw.replace(/[\/\-_ ]/g, "").toUpperCase();
}

/**
 * Safely parses string or number to a valid finite float.
 */
export function safeFloat(val: unknown, fallback = 0): number {
  if (typeof val === "number") return Number.isFinite(val) ? val : fallback;
  if (typeof val === "string") {
    const parsed = parseFloat(val);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Parse raw Binance 24hr ticker from WebSocket or REST API.
 */
export function parseBinanceTicker(data: Record<string, unknown>, symbolOverride?: string): NormalizedTick {
  const symbol = normalizeSymbol(String(data.s ?? data.symbol ?? symbolOverride ?? ""));
  const price = safeFloat(data.c ?? data.lastPrice ?? data.p ?? 0);
  const bid = safeFloat(data.b ?? data.bidPrice ?? price * 0.999);
  const ask = safeFloat(data.a ?? data.askPrice ?? price * 1.001);
  const volume = safeFloat(data.v ?? data.volume ?? 0);
  const high24h = safeFloat(data.h ?? data.highPrice ?? price);
  const low24h = safeFloat(data.l ?? data.lowPrice ?? price);
  const change24h = safeFloat(data.p ?? data.priceChange ?? 0);
  const changePercent24h = safeFloat(data.P ?? data.priceChangePercent ?? 0);
  const timestamp = typeof data.E === "number" ? data.E : typeof data.closeTime === "number" ? data.closeTime : Date.now();

  return {
    symbol,
    price,
    bid,
    ask,
    volume,
    high24h,
    low24h,
    change24h,
    changePercent24h,
    timestamp,
    source: "binance",
  };
}

/**
 * Parse raw Binance trade from WebSocket (@trade stream).
 */
export function parseBinanceTrade(data: Record<string, unknown>, symbolOverride?: string): NormalizedTrade {
  const symbol = normalizeSymbol(String(data.s ?? symbolOverride ?? ""));
  const tradeId = String(data.t ?? data.tradeId ?? Date.now());
  const price = safeFloat(data.p ?? data.price ?? 0);
  const quantity = safeFloat(data.q ?? data.quantity ?? 0);
  const isBuyerMaker = Boolean(data.m ?? data.isBuyerMaker ?? false);
  // In Binance: m=true means buyer is maker -> seller is taker (sell aggressive)
  const side: "buy" | "sell" = isBuyerMaker ? "sell" : "buy";
  const timestamp = typeof data.T === "number" ? data.T : Date.now();

  return {
    symbol,
    tradeId,
    price,
    quantity,
    side,
    isBuyerMaker,
    timestamp,
    source: "binance",
  };
}

/**
 * Parse raw Binance depth/orderbook from REST or WebSocket.
 */
export function parseBinanceOrderBook(data: Record<string, unknown>, symbol: string): NormalizedOrderBook {
  const sym = normalizeSymbol(symbol || String(data.s ?? ""));
  const rawBids = Array.isArray(data.bids) ? data.bids : Array.isArray(data.b) ? data.b : [];
  const rawAsks = Array.isArray(data.asks) ? data.asks : Array.isArray(data.a) ? data.a : [];

  const bids: OrderBookLevel[] = rawBids.map((b: unknown) => {
    if (Array.isArray(b)) {
      return { price: safeFloat(b[0]), quantity: safeFloat(b[1]) };
    }
    const obj = b as { price?: unknown; quantity?: unknown; p?: unknown; q?: unknown };
    return { price: safeFloat(obj.price ?? obj.p), quantity: safeFloat(obj.quantity ?? obj.q) };
  }).filter((lvl) => lvl.price > 0 && lvl.quantity > 0);

  const asks: OrderBookLevel[] = rawAsks.map((a: unknown) => {
    if (Array.isArray(a)) {
      return { price: safeFloat(a[0]), quantity: safeFloat(a[1]) };
    }
    const obj = a as { price?: unknown; quantity?: unknown; p?: unknown; q?: unknown };
    return { price: safeFloat(obj.price ?? obj.p), quantity: safeFloat(obj.quantity ?? obj.q) };
  }).filter((lvl) => lvl.price > 0 && lvl.quantity > 0);

  const lastUpdateId = Number(data.lastUpdateId ?? data.u ?? Date.now());
  const timestamp = typeof data.E === "number" ? data.E : Date.now();

  return {
    symbol: sym,
    bids,
    asks,
    lastUpdateId,
    timestamp,
    source: "binance",
  };
}

/**
 * Parse raw Binance kline from WebSocket (@kline stream) or REST API (/api/v3/klines).
 */
export function parseBinanceKline(raw: unknown, symbol: string, timeframe = "1m"): NormalizedKline {
  const sym = normalizeSymbol(symbol);

  // REST format: [openTime, open, high, low, close, volume, closeTime, quoteVolume, count, ...]
  if (Array.isArray(raw)) {
    const openTime = Number(raw[0] ?? Date.now());
    const open = safeFloat(raw[1]);
    const high = safeFloat(raw[2]);
    const low = safeFloat(raw[3]);
    const close = safeFloat(raw[4]);
    const volume = safeFloat(raw[5]);
    const closeTime = Number(raw[6] ?? openTime + 60000);
    const quoteVolume = safeFloat(raw[7]);
    const tradesCount = Number(raw[8] ?? 0);

    return {
      symbol: sym,
      timeframe,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      isClosed: true,
      tradesCount,
      quoteVolume,
      timestamp: openTime,
      source: "binance",
    };
  }

  // WebSocket format: { e: "kline", E: timestamp, s: "BTCUSDT", k: { t: openTime, T: closeTime, s: symbol, i: interval, o: open, c: close, h: high, l: low, v: volume, n: count, x: isClosed, q: quoteVolume } }
  const obj = raw as Record<string, unknown>;
  const k = (obj.k ?? obj) as Record<string, unknown>;

  const openTime = Number(k.t ?? obj.E ?? Date.now());
  const open = safeFloat(k.o ?? k.open);
  const high = safeFloat(k.h ?? k.high);
  const low = safeFloat(k.l ?? k.low);
  const close = safeFloat(k.c ?? k.close);
  const volume = safeFloat(k.v ?? k.volume);
  const closeTime = Number(k.T ?? k.closeTime ?? openTime + 60000);
  const isClosed = Boolean(k.x ?? k.isClosed ?? false);
  const tradesCount = Number(k.n ?? k.tradesCount ?? 0);
  const quoteVolume = safeFloat(k.q ?? k.quoteVolume ?? 0);
  const tf = String(k.i ?? timeframe);

  return {
    symbol: sym || normalizeSymbol(String(k.s ?? "")),
    timeframe: tf,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    isClosed,
    tradesCount,
    quoteVolume,
    timestamp: openTime,
    source: "binance",
  };
}
