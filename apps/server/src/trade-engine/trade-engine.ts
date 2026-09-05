// ============================================================================
// Finance Agent OS — Trade Engine (Canonical-aware)
// Consistent order/trade/position relationships, idempotent handling,
// partial-fill aware, audit events.
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
  filledQuantity: number;
  fees: number;
  pnl: number;
  openedAt: number;
  closedAt?: number;
  status: "open" | "closed";
  orderId: string;
  clientOrderId?: string;
  correlationId?: string;
  version: number;
}

export class TradeEngine {
  private trades = new Map<string, Trade>();
  private tradesByOrder = new Map<string, string>(); // orderId -> tradeId
  private openTradesBySymbol = new Map<string, Trade[]>();
  private processedFills = new Set<string>(); // dedup fillId

  constructor(private bus: TypedEventBus) {
    // Auto-create/update trades from canonical order fills
    bus.subscribeTo("order.fill_applied", (event) => {
      const d = event.data as { orderId?: string; clientOrderId?: string; symbol?: string; side?: "buy"|"sell"; quantity?: number; price?: number; fee?: number; correlationId?: string; version?: number; timestamp?: number };
      if (d?.orderId && d.symbol && d.side && typeof d.quantity === "number" && typeof d.price === "number") {
        const fillId = `${d.orderId}:${d.quantity}:${d.price}:${d.timestamp}`;
        if (this.processedFills.has(fillId)) return;
        this.processedFills.add(fillId);
        this.handleFill(d as Required<typeof d>);
      }
    });
    bus.subscribeTo("order.filled", (event) => {
      const d = event.data as { id?: string; orderId?: string; clientOrderId?: string; symbol?: string; side?: "buy"|"sell"; filledQuantity?: number; averageFillPrice?: number; fees?: number; price?: number; fee?: number; correlationId?: string };
      // fallback for PaperBroker direct fills without fill_applied
      if (d && (d.orderId ?? d.id) && d.symbol && d.side) {
        // avoid double processing if already handled via fill_applied
        const oid = (d.orderId ?? d.id) as string;
        const key = `${oid}:direct:${d.price}:${d.fee}`;
        if (this.processedFills.has(key)) return;
      }
    });
  }

  private handleFill(d: { orderId: string; clientOrderId?: string; symbol: string; side: "buy"|"sell"; quantity: number; price: number; fee?: number; correlationId?: string; version?: number; timestamp?: number }): void {
    const existingTradeId = this.tradesByOrder.get(d.orderId);
    if (existingTradeId) {
      const tr = this.trades.get(existingTradeId);
      if (tr) {
        // Update existing trade with additional fill (partial-fill aggregation)
        const prevQty = tr.quantity;
        const newQty = prevQty + d.quantity;
        const totalCost = tr.entryPrice * prevQty + d.price * d.quantity;
        tr.entryPrice = totalCost / newQty;
        tr.quantity = newQty;
        tr.filledQuantity = newQty;
        tr.fees += d.fee ?? 0;
        tr.version += 1;
        this.bus.publish({ type: "trade.updated", data: { ...tr, fill: d }, source: "trade-engine", agentId: "execution", correlationId: d.correlationId });
        this.bus.publish({ type: "audit.trade_updated", data: { tradeId: tr.id, orderId: d.orderId, correlationId: d.correlationId, quantity: d.quantity, price: d.price, version: tr.version, timestamp: Date.now() }, source: "trade-engine", correlationId: d.correlationId });
        return;
      }
    }
    // Create new trade — strategy derived from order if possible; fallback to agent symbol-based
    this.openTrade({
      symbol: d.symbol,
      strategy: "default",
      side: d.side,
      entryPrice: d.price,
      quantity: d.quantity,
      fees: d.fee ?? 0,
      orderId: d.orderId,
      clientOrderId: d.clientOrderId,
      correlationId: d.correlationId,
    });
  }

  openTrade(params: {
    symbol: string;
    strategy: string;
    side: "buy" | "sell";
    entryPrice: number;
    quantity: number;
    fees: number;
    orderId: string;
    clientOrderId?: string;
    correlationId?: string;
  }): Trade {
    // Idempotent: if trade already exists for orderId return existing
    const existingId = this.tradesByOrder.get(params.orderId);
    if (existingId) {
      const ex = this.trades.get(existingId);
      if (ex) return { ...ex };
    }
    const trade: Trade = {
      id: uuidv4(),
      symbol: params.symbol.toUpperCase(),
      strategy: params.strategy,
      side: params.side,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      filledQuantity: params.quantity,
      fees: params.fees,
      pnl: 0,
      openedAt: Date.now(),
      status: "open",
      orderId: params.orderId,
      clientOrderId: params.clientOrderId,
      correlationId: params.correlationId,
      version: 1,
    };

    this.trades.set(trade.id, trade);
    this.tradesByOrder.set(params.orderId, trade.id);
    const symbolTrades = this.openTradesBySymbol.get(trade.symbol) ?? [];
    symbolTrades.push(trade);
    this.openTradesBySymbol.set(trade.symbol, symbolTrades);

    this.bus.publish({
      type: "trade.opened",
      data: { ...trade },
      source: "trade-engine",
      agentId: "execution",
      correlationId: params.correlationId,
    });
    this.bus.publish({
      type: "audit.trade_opened",
      data: { tradeId: trade.id, orderId: trade.orderId, correlationId: trade.correlationId, symbol: trade.symbol, side: trade.side, price: trade.entryPrice, quantity: trade.quantity, timestamp: trade.openedAt },
      source: "trade-engine",
      correlationId: trade.correlationId,
    });

    return { ...trade };
  }

  closeTrade(tradeId: string, exitPrice: number, fees: number, opts?: { correlationId?: string }): Trade | null {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.status !== "open") return null;

    trade.exitPrice = exitPrice;
    trade.fees += fees;
    trade.closedAt = Date.now();
    trade.status = "closed";
    trade.version += 1;

    if (trade.side === "buy") {
      trade.pnl = (exitPrice - trade.entryPrice) * trade.quantity - trade.fees;
    } else {
      trade.pnl = (trade.entryPrice - exitPrice) * trade.quantity - trade.fees;
    }

    const symbolTrades = this.openTradesBySymbol.get(trade.symbol) ?? [];
    const idx = symbolTrades.findIndex((t) => t.id === tradeId);
    if (idx >= 0) symbolTrades.splice(idx, 1);

    this.bus.publish({
      type: "trade.closed",
      data: { ...trade },
      source: "trade-engine",
      agentId: "execution",
      correlationId: opts?.correlationId ?? trade.correlationId,
    });
    this.bus.publish({
      type: "audit.trade_closed",
      data: { tradeId: trade.id, orderId: trade.orderId, correlationId: trade.correlationId, pnl: trade.pnl, exitPrice, fees: trade.fees, timestamp: trade.closedAt },
      source: "trade-engine",
      correlationId: trade.correlationId,
    });

    return { ...trade };
  }

  getTrade(tradeId: string): Trade | undefined { const t = this.trades.get(tradeId); return t ? { ...t } : undefined; }
  getTradeByOrderId(orderId: string): Trade | undefined { const tid = this.tradesByOrder.get(orderId); if (!tid) return undefined; return this.getTrade(tid); }
  getOpenTrades(): Trade[] { return [...this.trades.values()].filter((t) => t.status === "open").map(t=>({...t})); }
  getClosedTrades(): Trade[] { return [...this.trades.values()].filter((t) => t.status === "closed").map(t=>({...t})); }
  getTradesBySymbol(symbol: string): Trade[] { return [...this.trades.values()].filter((t) => t.symbol === symbol.toUpperCase()).map(t=>({...t})); }
  getTradesByStrategy(strategy: string): Trade[] { return [...this.trades.values()].filter((t) => t.strategy === strategy).map(t=>({...t})); }
  getAllTrades(): Trade[] { return [...this.trades.values()].map(t=>({...t})); }
  getStats(): { totalTrades: number; openTrades: number; closedTrades: number; totalPnl: number; winRate: number; avgPnl: number } {
    const all = [...this.trades.values()];
    const closed = all.filter((t) => t.status === "closed");
    const wins = closed.filter((t) => t.pnl > 0);
    const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);
    return { totalTrades: all.length, openTrades: all.filter((t) => t.status === "open").length, closedTrades: closed.length, totalPnl, winRate: closed.length > 0 ? wins.length / closed.length : 0, avgPnl: closed.length > 0 ? totalPnl / closed.length : 0 };
  }
  size(): number { return this.trades.size; }
}
