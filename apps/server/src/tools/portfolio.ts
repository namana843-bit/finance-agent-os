// ============================================================================
// Portfolio / Balance / Positions tools — exchange-agnostic via PortfolioProvider.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";
import type { PortfolioProvider, BalanceMap, ProviderPosition, ProviderPortfolio } from "../providers/types.js";

export function balanceTool(): ToolDefinition {
  return {
    id: "get_balance",
    name: "Get Balance",
    description: "Get account balances by asset (exchange-agnostic)",
    inputSchema: { type: "object", properties: { asset: { type: "string", description: "Optional asset filter e.g. USDT" } } },
    outputSchema: { type: "object", properties: { balances: { type: "object" } } },
    permissions: { required: false },
  };
}

export async function executeGetBalance(
  provider: PortfolioProvider,
  input: Record<string, unknown>,
): Promise<{ balances: BalanceMap }> {
  const balances = await provider.getBalance();
  const asset = String(input.asset ?? "").trim().toUpperCase();
  if (asset) {
    const entry = balances[asset];
    return { balances: entry ? { [asset]: entry } : {} };
  }
  return { balances };
}

export function positionsTool(): ToolDefinition {
  return {
    id: "get_positions",
    name: "Get Positions",
    description: "Get open positions (exchange-agnostic)",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional symbol filter" } },
    },
    outputSchema: { type: "object", properties: { positions: { type: "array" } } },
    permissions: { required: false },
  };
}

export async function executeGetPositions(
  provider: PortfolioProvider,
  input: Record<string, unknown>,
): Promise<{ positions: ProviderPosition[] }> {
  const positions = await provider.getPositions();
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (symbol) return { positions: positions.filter((p) => p.symbol.toUpperCase() === symbol) };
  return { positions };
}

export function portfolioTool(): ToolDefinition {
  return {
    id: "get_portfolio_snapshot",
    name: "Get Portfolio Snapshot",
    description: "Get full portfolio snapshot: cash, equity, positions, PnL (exchange-agnostic)",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        cash: { type: "number" },
        equity: { type: "number" },
        positions: { type: "array" },
        realizedPnl: { type: "number" },
        unrealizedPnl: { type: "number" },
        totalPnl: { type: "number" },
      },
    },
    permissions: { required: false },
  };
}

export async function executeGetPortfolioSnapshot(
  provider: PortfolioProvider,
  _input: Record<string, unknown>,
): Promise<ProviderPortfolio> {
  return provider.getPortfolio();
}
