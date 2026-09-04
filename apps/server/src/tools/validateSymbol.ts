import { BaseTool } from "../core/tool.js";

// Validates a finance symbol (BTCUSDT, AAPL, EURUSD...). No strategy, no trading.
export class ValidateSymbolTool extends BaseTool<{ symbol: string }, { symbol: string; valid: boolean }> {
  name = "validate-symbol";
  description = "Validate a finance symbol format (uppercase alphanumerics, 3-12 chars)";
  version = "0.1.0";
  inputSchema = { type: "object", properties: { symbol: { type: "string", minLength: 1 } }, required: ["symbol"] };

  async execute(input: { symbol: string }): Promise<{ symbol: string; valid: boolean }> {
    this.validate(input);
    const symbol = String(input.symbol).toUpperCase().trim();
    const valid = /^[A-Z0-9]{3,12}$/.test(symbol);
    return { symbol, valid };
  }
}

export default ValidateSymbolTool;
