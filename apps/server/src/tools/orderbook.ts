// ============================================================================
// Order Book tool — exchange-agnostic.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import type { MarketDataProvider, OrderBookSnapshot } from "../providers/types.js";

export function orderBookTool(): ToolDefinition {
  return {
    id: "get_order_book",
    name: "Get Order Book",
    description: "Get order book snapshot (bids/asks) for a symbol (exchange-agnostic)",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        depth: { type: "number", description: "Depth per side (1-100)", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        bids: { type: "array" },
        asks: { type: "array" },
        timestamp: { type: "number" },
      },
    },
    permissions: { required: false },
  };
}

export async function executeGetOrderBook(
  provider: MarketDataProvider,
  input: Record<string, unknown>,
): Promise<OrderBookSnapshot> {
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) throw new Error("symbol is required");
  const depth = Math.min(Math.max(Number(input.depth ?? 10) || 10, 1), 100);
  return provider.getOrderBook(symbol, depth);
}
