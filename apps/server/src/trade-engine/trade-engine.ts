// ============================================================================
// Finance Agent OS — Trade Engine
// Phase 15: Trade management separate from orders
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { TypedEventBus } from "@finance/core";

export interface Trade {
  id: string;
  symbol: string;
  strategy: string;
  side: "buy" | "sell";
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  fees: number;
  pnl: number;
  openedAt: number;
  closedAt?: number;
  status: "open" | "closed";
  orderId: string;
}

export class TradeEngine {
  private trades = new Map<string, Trade>();
  private openTradesBySymbol = new Map<string, Trade[]>();

  constructor(private bus: TypedEventBus) {}

  openTrade(params: {
    symbol: string;
    strategy: string;
    side: "buy" | "sell";
    entryPrice: number;
    quantity: number;
    fees: number;
    orderId: string;
  }): Trade {
    const trade: Trade = {
      id: uuidv4(),
      symbol: params.symbol.toUpperCase(),
      strategy: params.strategy,
      side: params.side,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      fees: params.fees,
      pnl: 0,
      openedAt: Date.now(),
      status: "open",
      orderId: params.orderId,
    };

    this.trades.set(trade.id, trade);

    const symbolTrades = this.openTradesBySymbol.get(trade.symbol) ?? [];
    symbolTrades.push(trade);
    this.openTradesBySymbol.set(trade.symbol, symbolTrades);

    this.bus.publish({
      type: "trade.opened",
      data: { ...trade },
      source: "trade-engine",
      agentId: "execution",
    });

    return trade;
  }

  closeTrade(tradeId: string, exitPrice: number, fees: number): Trade | null {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.status !== "open") return null;

    trade.exitPrice = exitPrice;
    trade.fees += fees;
    trade.closedAt = Date.now();
    trade.status = "closed";

    // Calculate PnL
    if (trade.side === "buy") {
      trade.pnl = (exitPrice - trade.entryPrice) * trade.quantity - trade.fees;
    } else {
      trade.pnl = (trade.entryPrice - exitPrice) * trade.quantity - trade.fees;
    }

    // Remove from open trades
    const symbolTrades = this.openTradesBySymbol.get(trade.symbol) ?? [];
    const idx = symbolTrades.findIndex((t) => t.id === tradeId);
    if (idx >= 0) symbolTrades.splice(idx, 1);

    this.bus.publish({
      type: "trade.closed",
      data: { ...trade },
      source: "trade-engine",
      agentId: "execution",
    });

    return trade;
  }

  getTrade(tradeId: string): Trade | undefined {
    return this.trades.get(tradeId);
  }

  getOpenTrades(): Trade[] {
    return [...this.trades.values()].filter((t) => t.status === "open");
  }

  getClosedTrades(): Trade[] {
    return [...this.trades.values()].filter((t) => t.status === "closed");
  }

  getTradesBySymbol(symbol: string): Trade[] {
    return [...this.trades.values()].filter((t) => t.symbol === symbol.toUpperCase());
  }

  getTradesByStrategy(strategy: string): Trade[] {
    return [...this.trades.values()].filter((t) => t.strategy === strategy);
  }

  getAllTrades(): Trade[] {
    return [...this.trades.values()];
  }

  getStats(): {
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    totalPnl: number;
    winRate: number;
    avgPnl: number;
  } {
    const all = [...this.trades.values()];
    const closed = all.filter((t) => t.status === "closed");
    const wins = closed.filter((t) => t.pnl > 0);
    const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);

    return {
      totalTrades: all.length,
      openTrades: all.filter((t) => t.status === "open").length,
      closedTrades: closed.length,
      totalPnl,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      avgPnl: closed.length > 0 ? totalPnl / closed.length : 0,
    };
  }

  size(): number {
    return this.trades.size;
  }
}
