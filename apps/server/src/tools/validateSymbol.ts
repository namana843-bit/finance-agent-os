// ============================================================================
// Validate Symbol tool — checks finance symbol format (BTCUSDT, AAPL...).
// Pure validation helper. No strategy, no trading.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";

export function validateSymbolTool(): ToolDefinition {
  return {
    id: "validate_symbol",
    name: "Validate Symbol",
    description: "Validate a finance symbol format (uppercase alphanumerics, 3-12 chars)",
    inputSchema: { type: "object", properties: { symbol: { type: "string", minLength: 1 } }, required: ["symbol"] },
    outputSchema: { type: "object", properties: { symbol: { type: "string" }, valid: { type: "boolean" } } },
    permissions: { required: false },
  };
}

export function executeValidateSymbol(input: Record<string, unknown>): { symbol: string; valid: boolean } {
  const symbol = String(input.symbol ?? "").toUpperCase().trim();
  const valid = /^[A-Z0-9]{3,12}$/.test(symbol);
  return { symbol, valid };
}
