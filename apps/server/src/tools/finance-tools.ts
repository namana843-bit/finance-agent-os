// ============================================================================
// Finance Agent OS — Finance Tools
// Callable tools that agents use to interact with the platform
// ============================================================================

import type { ToolDefinition, ToolPermission } from "@finance/shared";
import type { TypedEventBus } from "@finance/core";
import { validateSymbolTool, executeValidateSymbol } from "./validateSymbol.js";
import { formatMoneyTool, executeFormatMoney } from "./formatMoney.js";
import { eventLogTool, executeEventLog } from "./eventLog.js";
import { priceTool, executeGetPrice } from "./price.js";
import { ohlcvTool, executeGetOHLCV } from "./ohlcv.js";
import { orderBookTool, executeGetOrderBook } from "./orderbook.js";
import {
  balanceTool,
  executeGetBalance,
  positionsTool,
  executeGetPositions,
  portfolioTool,
  executeGetPortfolioSnapshot,
} from "./portfolio.js";
import {
  smaTool,
  executeSMA,
  emaTool,
  executeEMA,
  rsiTool,
  executeRSIIndicator,
  macdTool,
  executeMACDIndicator,
  bollingerBandsTool,
  executeBollingerBands,
  indicatorTool,
  executeIndicator,
} from "./indicators.js";
import { createExchangeProvider } from "../providers/index.js";

export interface ToolContext {
  bus: TypedEventBus;
  marketState: Map<string, { price: number; timestamp: number }>;
  portfolioState: { cash: number; positions: Map<string, { qty: number; avgPrice: number; currentPrice: number }> };
  riskConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Market Tools
// ---------------------------------------------------------------------------

export function getMarketPriceTool(): ToolDefinition {
  return {
    id: "get_market_price",
    name: "Get Market Price",
    description: "Get current price for a symbol",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    outputSchema: { type: "object", properties: { symbol: { type: "string" }, price: { type: "number" }, timestamp: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeGetMarketPrice(ctx: ToolContext, input: Record<string, unknown>): { symbol: string; price: number; timestamp: number } {
  const symbol = String(input.symbol).toUpperCase();
  const state = ctx.marketState.get(symbol);
  if (!state) throw new Error(`No price data for ${symbol}`);
  return { symbol, price: state.price, timestamp: state.timestamp };
}

export function getCandlesTool(): ToolDefinition {
  return {
    id: "get_candles",
    name: "Get Candles",
    description: "Get historical candles for a symbol (TODO: implement candle storage)",
    inputSchema: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" }, limit: { type: "number" } }, required: ["symbol"] },
    outputSchema: { type: "object", properties: { candles: { type: "array" } } },
    permissions: { required: false },
  };
}

// ---------------------------------------------------------------------------
// Quantitative Tools
// ---------------------------------------------------------------------------

export function calculateRSITool(): ToolDefinition {
  return {
    id: "calculate_rsi",
    name: "Calculate RSI",
    description: "Calculate Relative Strength Index for a price series",
    inputSchema: { type: "object", properties: { prices: { type: "array" }, period: { type: "number" } }, required: ["prices"] },
    outputSchema: { type: "object", properties: { rsi: { type: "number" }, period: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeCalculateRSI(input: Record<string, unknown>): { rsi: number | null; period: number } {
  const prices = input.prices as number[];
  const period = (input.period as number) ?? 14;
  if (!Array.isArray(prices) || prices.length <= period) return { rsi: null, period };
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return { rsi: 100, period };
  if (avgGain === 0) return { rsi: 0, period };
  const rs = avgGain / avgLoss;
  return { rsi: Math.round((100 - 100 / (1 + rs)) * 100) / 100, period };
}

export function calculateMACDTool(): ToolDefinition {
  return {
    id: "calculate_macd",
    name: "Calculate MACD",
    description: "Calculate Moving Average Convergence Divergence",
    inputSchema: { type: "object", properties: { prices: { type: "array" }, fast: { type: "number" }, slow: { type: "number" }, signal: { type: "number" } }, required: ["prices"] },
    outputSchema: { type: "object", properties: { macd: { type: "number" }, signal: { type: "number" }, histogram: { type: "number" } } },
    permissions: { required: false },
  };
}

// ---------------------------------------------------------------------------
// Portfolio Tools
// ---------------------------------------------------------------------------

export function getPortfolioTool(): ToolDefinition {
  return {
    id: "get_portfolio",
    name: "Get Portfolio",
    description: "Get current portfolio state",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { cash: { type: "number" }, positions: { type: "array" }, totalValue: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeGetPortfolio(ctx: ToolContext): { cash: number; positions: Array<{ symbol: string; qty: number; avgPrice: number; currentPrice: number; value: number; pnl: number }>; totalValue: number } {
  const positions = [...ctx.portfolioState.positions.entries()].map(([symbol, pos]) => ({
    symbol,
    qty: pos.qty,
    avgPrice: pos.avgPrice,
    currentPrice: pos.currentPrice,
    value: pos.qty * pos.currentPrice,
    pnl: (pos.currentPrice - pos.avgPrice) * pos.qty,
  }));
  const posValue = positions.reduce((sum, p) => sum + p.value, 0);
  return { cash: ctx.portfolioState.cash, positions, totalValue: ctx.portfolioState.cash + posValue };
}

export function calculatePositionSizeTool(): ToolDefinition {
  return {
    id: "calculate_position_size",
    name: "Calculate Position Size",
    description: "Calculate position size based on risk parameters",
    inputSchema: { type: "object", properties: { cash: { type: "number" }, price: { type: "number" }, riskPercent: { type: "number" } }, required: ["cash", "price"] },
    outputSchema: { type: "object", properties: { qty: { type: "number" }, notional: { type: "number" }, riskAmount: { type: "number" } } },
    permissions: { required: false },
  };
}

export function executeCalculatePositionSize(input: Record<string, unknown>): { qty: number; notional: number; riskAmount: number } {
  const cash = Number(input.cash) || 0;
  const price = Number(input.price) || 0;
  const riskPercent = Number(input.riskPercent) || 0.01;
  if (cash <= 0 || price <= 0) return { qty: 0, notional: 0, riskAmount: 0 };
  const riskAmount = cash * riskPercent;
  const qty = Math.round((riskAmount / price) * 1e6) / 1e6;
  return { qty, notional: qty * price, riskAmount };
}

// ---------------------------------------------------------------------------
// Supertrend Indicator Tool
// ---------------------------------------------------------------------------

export function supertrendTool(): ToolDefinition {
  return {
    id: "calculate_supertrend",
    name: "Supertrend Indicator",
    description: "Calculate Supertrend indicator (ATR multiplier & trend direction)",
    inputSchema: {
      type: "object",
      properties: {
        prices: { type: "array", items: { type: "number" } },
        period: { type: "number", default: 10 },
        multiplier: { type: "number", default: 3 },
      },
      required: ["prices"],
    },
    outputSchema: {
      type: "object",
      properties: {
        supertrend: { type: "number" },
        trend: { type: "string" },
        upperBand: { type: "number" },
        lowerBand: { type: "number" },
      },
    },
    permissions: { required: false },
  };
}

export function executeSupertrend(input: Record<string, unknown>): { supertrend: number; trend: "bullish" | "bearish"; upperBand: number; lowerBand: number } {
  const prices = (input.prices as number[]) || [];
  const period = Number(input.period || 10);
  const multiplier = Number(input.multiplier || 3);

  if (!prices || prices.length < period) {
    const last = prices[prices.length - 1] ?? 50000;
    return {
      supertrend: last * 0.97,
      trend: "bullish",
      upperBand: last * 1.03,
      lowerBand: last * 0.97,
    };
  }

  const lastPrice = prices[prices.length - 1]!;
  let atr = 0;
  for (let i = prices.length - period; i < prices.length - 1; i++) {
    atr += Math.abs(prices[i + 1]! - prices[i]!);
  }
  atr = atr / Math.max(1, period - 1);

  const upperBand = Math.round((lastPrice + multiplier * atr) * 100) / 100;
  const lowerBand = Math.round((lastPrice - multiplier * atr) * 100) / 100;
  const trend = lastPrice >= lowerBand ? "bullish" : "bearish";
  const supertrend = trend === "bullish" ? lowerBand : upperBand;

  return { supertrend, trend, upperBand, lowerBand };
}

// ---------------------------------------------------------------------------
// Tool Registration Helper
// ---------------------------------------------------------------------------

export function registerAllTools(runtime: import("@finance/core").FinanceRuntime): void {
  const bus = runtime.getEventBus();
  const ctx: ToolContext = {
    bus,
    marketState: new Map(),
    portfolioState: { cash: 100000, positions: new Map() },
    riskConfig: {},
  };

  // Sync market state from events (kept for backward compat with get_market_price / get_portfolio)
  bus.subscribeTo("market.tick", (event) => {
    const tick = event.data as { symbol: string; price: number; timestamp: number };
    if (tick && tick.symbol) {
      ctx.marketState.set(tick.symbol, { price: tick.price, timestamp: tick.timestamp });
    }
  });

  bus.subscribeTo("portfolio.updated", (event) => {
    const data = event.data as { cash: number; positions: Record<string, { qty: number; avgPrice: number; currentPrice: number }> };
    if (data) {
      ctx.portfolioState.cash = data.cash;
      ctx.portfolioState.positions = new Map(Object.entries(data.positions ?? {}));
    }
  });

  // Exchange-agnostic providers — exchange-specific code stays in providers/*,
  // tools depend only on MarketDataProvider/PortfolioProvider interfaces.
  // Select via EXCHANGE_PROVIDER env: "memory" (default, deterministic) | "binance" (live).
  const exchangeProvider = createExchangeProvider();

  const tools: Array<[ToolDefinition, (input: Record<string, unknown>) => Promise<unknown> | unknown]> = [
    // Legacy / existing
    [getMarketPriceTool(), (input) => executeGetMarketPrice(ctx, input)],
    [getCandlesTool(), async () => ({ candles: [], note: "TODO: implement candle storage" })],
    [calculateRSITool(), (input) => executeCalculateRSI(input)],
    [calculateMACDTool(), async () => ({ note: "TODO: wrap strategies.ts macd()" })],
    [getPortfolioTool(), () => executeGetPortfolio(ctx)],
    [calculatePositionSizeTool(), (input) => executeCalculatePositionSize(input)],
    [validateSymbolTool(), (input) => executeValidateSymbol(input)],
    [formatMoneyTool(), (input) => executeFormatMoney(input)],
    [eventLogTool(), (input) => executeEventLog(ctx, input)],
    // New — market data (price / OHLCV / order book) — via MarketDataProvider
    [priceTool(), (input) => executeGetPrice(exchangeProvider, input)],
    [ohlcvTool(), (input) => executeGetOHLCV(exchangeProvider, input)],
    [orderBookTool(), (input) => executeGetOrderBook(exchangeProvider, input)],
    // New — portfolio / balance / positions — via PortfolioProvider
    [balanceTool(), (input) => executeGetBalance(exchangeProvider, input)],
    [positionsTool(), (input) => executeGetPositions(exchangeProvider, input)],
    [portfolioTool(), (input) => executeGetPortfolioSnapshot(exchangeProvider, input)],
    // New — basic indicators (pure, no provider)
    [smaTool(), (input) => executeSMA(input)],
    [emaTool(), (input) => executeEMA(input)],
    [rsiTool(), (input) => executeRSIIndicator(input)],
    [macdTool(), (input) => executeMACDIndicator(input)],
    [bollingerBandsTool(), (input) => executeBollingerBands(input)],
    [indicatorTool(), (input) => executeIndicator(input)],
    [supertrendTool(), (input) => executeSupertrend(input)],
  ];

  for (const [def, handler] of tools) {
    runtime.registerTool(def, { execute: handler as (input: Record<string, unknown>) => Promise<unknown> });
  }

  console.log(`[tools] registered ${tools.length} finance tools`);
}
