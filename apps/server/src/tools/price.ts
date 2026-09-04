// ============================================================================
// Price tool — exchange-agnostic. Depends only on MarketDataProvider.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import type { MarketDataProvider } from "../providers/types.js";

export function priceTool(): ToolDefinition {
  return {
    id: "get_price",
    name: "Get Price",
    description: "Get current price for a symbol (exchange-agnostic)",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Symbol e.g. BTCUSDT" } },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        price: { type: "number" },
        bid: { type: "number" },
        ask: { type: "number" },
        volume: { type: "number" },
        timestamp: { type: "number" },
        source: { type: "string" },
      },
    },
    permissions: { required: false },
  };
}

export async function executeGetPrice(
  provider: MarketDataProvider,
  input: Record<string, unknown>,
): Promise<{ symbol: string; price: number; bid?: number; ask?: number; volume?: number; timestamp: number; source: string }> {
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) throw new Error("symbol is required (e.g. BTCUSDT)");
  return provider.getPrice(symbol);
}
