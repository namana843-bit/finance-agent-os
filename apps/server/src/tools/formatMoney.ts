// ============================================================================
// Format Money tool — pure money formatter.
// No strategy, no trading.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";

export function formatMoneyTool(): ToolDefinition {
  return {
    id: "format_money",
    name: "Format Money",
    description: "Format an amount as money (e.g. 125430.22 USDT)",
    inputSchema: { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount"] },
    outputSchema: { type: "object", properties: { formatted: { type: "string" } } },
    permissions: { required: false },
  };
}

export function executeFormatMoney(input: Record<string, unknown>): { formatted: string } {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount)) throw new Error("amount must be finite");
  const currency = String(input.currency ?? "").trim() || "USDT";
  const formatted = `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  return { formatted };
}
