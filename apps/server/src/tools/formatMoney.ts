import { BaseTool } from "../core/tool.js";

// Pure money formatter. No strategy, no trading.
export class FormatMoneyTool extends BaseTool<{ amount: number; currency?: string }, { formatted: string }> {
  name = "format-money";
  description = "Format an amount as money (e.g. 125430.22 USDT -> 125,430.22 USDT)";
  version = "0.1.0";
  inputSchema = {
    type: "object",
    properties: { amount: { type: "number" }, currency: { type: "string" } },
    required: ["amount"],
  };

  async execute(input: { amount: number; currency?: string }): Promise<{ formatted: string }> {
    this.validate(input);
    if (!Number.isFinite(input.amount)) throw new Error("amount must be finite");
    const currency = input.currency?.trim() || "USDT";
    const formatted = `${input.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    return { formatted };
  }
}

export default FormatMoneyTool;
