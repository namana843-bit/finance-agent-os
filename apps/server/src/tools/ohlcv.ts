// ============================================================================
// OHLCV tool — exchange-agnostic.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import type { MarketDataProvider, OHLCVBar } from "../providers/types.js";

export function ohlcvTool(): ToolDefinition {
  return {
    id: "get_ohlcv",
    name: "Get OHLCV",
    description: "Get OHLCV candles for a symbol and timeframe (exchange-agnostic)",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        timeframe: { type: "string", description: "1m, 5m, 15m, 1h, 4h, 1d", default: "1m" },
        limit: { type: "number", description: "Number of candles (1-500)", minimum: 1, maximum: 500, default: 20 },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        timeframe: { type: "string" },
        ohlcv: { type: "array" },
      },
    },
    permissions: { required: false },
  };
}

export async function executeGetOHLCV(
  provider: MarketDataProvider,
  input: Record<string, unknown>,
): Promise<{ symbol: string; timeframe: string; ohlcv: OHLCVBar[] }> {
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) throw new Error("symbol is required");
  const timeframe = String(input.timeframe ?? "1m").trim() || "1m";
  const limit = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 500);
  const ohlcv = await provider.getOHLCV(symbol, timeframe, limit);
  return { symbol: symbol.toUpperCase(), timeframe, ohlcv };
}
