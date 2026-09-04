// ============================================================================
// Finance Environment — Paper Trading Adapter
// Exchange-specific (paper only): wraps PaperBroker.
// Implements PaperTradingPort + PortfolioPort for the FinanceEnvironment.
// No live orders — all orders go through PaperBroker simulation.
// ============================================================================

import type { PaperTradingPort, PortfolioPort, CreateOrderParams } from "../types.js";
import type { BalanceMap, ProviderPosition, ProviderPortfolio } from "../../providers/types.js";
import type { PaperOrder } from "../../broker/paper-broker.js";
import { PaperBroker } from "../../broker/paper-broker.js";
import type { TypedEventBus } from "@finance/core";

export class PaperTradingAdapter implements PaperTradingPort, PortfolioPort {
  readonly id = "paper-trading";
  private broker: PaperBroker;

  constructor(bus: TypedEventBus, broker?: PaperBroker) {
    this.broker = broker ?? new PaperBroker(bus);
  }

  // -------------------------------------------------------------------------
  // PaperTradingPort
  // -------------------------------------------------------------------------

  async createOrder(params: CreateOrderParams): Promise<PaperOrder> {
    const symbol = String(params.symbol ?? "").trim();
    if (!symbol) throw new Error("symbol is required");
    const side = params.side;
    if (side !== "buy" && side !== "sell") throw new Error("side must be 'buy' or 'sell'");
    const quantity = Number(params.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be a positive number");
    const type = params.type ?? "market";
    if (type !== "market" && type !== "limit") throw new Error("type must be 'market' or 'limit'");
    if (type === "limit" && (params.price === undefined || !Number.isFinite(Number(params.price)))) {
      throw new Error("price is required for limit orders");
    }
    return this.broker.createOrder(symbol, side, quantity, type, params.price);
  }

  async cancelOrder(_orderId: string): Promise<{ orderId: string; status: string }> {
    // PaperBroker currently auto-fills; cancellation is a no-op but we expose it for API parity.
    // In future, this will interact with order-manager. For now, return cancelled if order exists.
    const id = String(_orderId ?? "").trim();
    if (!id) throw new Error("orderId is required");
    // Check open orders
    const open = this.broker.getOpenOrders();
    const found = open.find((o) => o.id === id);
    if (found) {
      // No real cancellation in current PaperBroker — simulate
      return { orderId: id, status: "cancelled" };
    }
    return { orderId: id, status: "not_found" };
  }

  async getOrders(): Promise<PaperOrder[]> {
    return this.broker.getOrderHistory();
  }

  async getOpenOrders(): Promise<PaperOrder[]> {
    return this.broker.getOpenOrders();
  }

  // -------------------------------------------------------------------------
  // PortfolioPort (delegated to PaperBroker)
  // -------------------------------------------------------------------------

  async getBalance(): Promise<BalanceMap> {
    const portfolio = this.broker.getPortfolio();
    const posValue = portfolio.positions.reduce((s, p) => s + p.currentPrice * p.quantity, 0);
    return {
      USDT: { free: portfolio.cash, used: posValue, total: portfolio.equity },
      USD: { free: portfolio.cash, used: 0, total: portfolio.cash },
    };
  }

  async getPositions(): Promise<ProviderPosition[]> {
    const portfolio = this.broker.getPortfolio();
    return portfolio.positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      markPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl,
      openedAt: p.openedAt,
      updatedAt: Date.now(),
    }));
  }

  async getPortfolio(): Promise<ProviderPortfolio> {
    const p = this.broker.getPortfolio();
    return {
      cash: p.cash,
      equity: p.equity,
      positions: p.positions.map((pos) => ({
        symbol: pos.symbol,
        side: pos.side,
        quantity: pos.quantity,
        entryPrice: pos.entryPrice,
        markPrice: pos.currentPrice,
        unrealizedPnl: pos.unrealizedPnl,
        openedAt: pos.openedAt,
        updatedAt: Date.now(),
      })),
      realizedPnl: p.realizedPnl,
      unrealizedPnl: p.unrealizedPnl,
      totalPnl: p.totalPnl,
      timestamp: Date.now(),
    };
  }

  getBroker(): PaperBroker {
    return this.broker;
  }

  /** Direct price seeding for tests (paper broker uses priceCache) */
  seedPrice(symbol: string, price: number): void {
    // Publish a synthetic tick so PaperBroker's priceCache updates
    // Use the broker's bus if available; fallback to direct map manipulation
    const anyBroker = this.broker as unknown as { priceCache: Map<string, number> };
    if (anyBroker.priceCache) {
      anyBroker.priceCache.set(symbol.toUpperCase(), price);
    }
  }
}
