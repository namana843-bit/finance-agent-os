// ============================================================================
// Finance Agent OS — Provider Interfaces (exchange-agnostic)
// Tools depend only on these interfaces; exchange-specific code lives in
// adapters/providers (binance, mock, etc.). No tool imports BinanceAdapter.
// ============================================================================

export interface PriceResult {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp: number;
  source: string;
}

export interface OHLCVBar {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  closed: boolean;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface BalanceEntry {
  free: number;
  used: number;
  total: number;
}

export type BalanceMap = Record<string, BalanceEntry>;

export interface ProviderPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl?: number;
  openedAt: number;
  updatedAt: number;
  leverage?: number;
}

export interface ProviderPortfolio {
  cash: number;
  equity: number;
  positions: ProviderPosition[];
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// MarketDataProvider — price / OHLCV / order book
// PortfolioProvider — balance / positions / portfolio
// ---------------------------------------------------------------------------

export interface MarketDataProvider {
  getPrice(symbol: string): Promise<PriceResult>;
  getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCVBar[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
}

export interface PortfolioProvider {
  getBalance(): Promise<BalanceMap>;
  getPositions(): Promise<ProviderPosition[]>;
  getPortfolio(): Promise<ProviderPortfolio>;
}

export interface ExchangeProvider extends MarketDataProvider, PortfolioProvider {
  readonly id: string;
}
