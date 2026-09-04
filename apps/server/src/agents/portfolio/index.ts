import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { kellyCriterion, positionSizing, rebalanceWeights, type RebalanceTrade } from "./allocation.js";

export { kellyCriterion, positionSizing, rebalanceWeights, type RebalanceTrade };

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
  currentPrice: number;
}

export interface Order {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  confidence: number;
  timestamp: number;
  id?: string;
}

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  timestamp: number;
  orderId?: string;
  fee?: number;
}

export interface Tick {
  symbol: string;
  price: number;
  timestamp?: number;
  change?: number;
  volume?: number;
}

export interface PortfolioSnapshot {
  cash: number;
  positions: Map<string, Position>;
  realizedPnL: number;
  unrealizedPnL: number;
  totalValue: number;
  positionCount: number;
}

export interface PnL {
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  totalValue: number;
  cash: number;
}

export interface Allocation {
  [symbol: string]: number;
}

interface RiskApprovedData {
  signal?: { symbol: string; action?: string; side?: string; price: number; confidence?: number };
  symbol?: string;
  side?: string;
  action?: string;
  price?: number;
  confidence?: number;
}

export class PortfolioAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private cash: number;
  private positions = new Map<string, Position>();
  private realizedPnL = 0;
  private unrealizedPnL = 0;
  private orderHistory: Order[] = [];
  private fillHistory: Fill[] = [];
  private unsubscribe: (() => void) | null = null;
  private maxHistory = 500;

  constructor(bus?: TypedEventBus, initialCash = 100000) {
    super({
      id: "portfolio",
      name: "Portfolio Agent",
      version: "0.1.0",
      description: "Portfolio management with position tracking, PnL, and allocation",
      capabilities: ["portfolio-management", "position-sizing", "pnl-tracking"],
    });
    this.bus = bus ?? new TypedEventBus();
    this.cash = Number.isFinite(initialCash) ? initialCash : 100000;
  }

  async start(): Promise<void> {
    await super.start();
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      try {
        if (event.type === "risk.approved") {
          this.handleApproved(event);
        } else if (event.type === "order.filled") {
          this.handleFilled(event);
        } else if (event.type === "market.tick") {
          this.handleTick(event);
        }
      } catch (err) {
        this.recordError(err);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await super.stop();
  }

  async handleEvent(event: FinanceEvent): Promise<void> {
    if (event.type === "risk.approved") {
      this.handleApproved(event);
    } else if (event.type === "order.filled") {
      this.handleFilled(event);
    } else if (event.type === "market.tick") {
      this.handleTick(event);
    }
  }

  handleApproved(event: FinanceEvent): Order | null {
    this.recordActivity();
    const data = event.data as RiskApprovedData | null;
    if (!data) return null;

    let symbol: string | undefined;
    let price: number | undefined;
    let confidence = 0.5;
    let side: "buy" | "sell" = "buy";

    if (data.signal && typeof data.signal.symbol === "string") {
      symbol = data.signal.symbol;
      price = data.signal.price;
      if (typeof data.signal.confidence === "number") confidence = data.signal.confidence;
      const act = (data.signal.action ?? data.signal.side ?? "buy").toString().toLowerCase();
      side = act === "sell" ? "sell" : "buy";
    } else if (typeof data.symbol === "string") {
      symbol = data.symbol;
      if (typeof data.price === "number") price = data.price;
      if (typeof data.confidence === "number") confidence = data.confidence;
      const act = (data.action ?? data.side ?? "buy").toString().toLowerCase();
      side = act === "sell" ? "sell" : "buy";
    } else {
      return null;
    }

    if (!symbol || typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    symbol = symbol.toUpperCase();
    const qty = positionSizing(this.cash, price, 0.01);
    if (qty <= 0) return null;

    const order: Order = {
      symbol,
      side,
      qty,
      price,
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
    };

    this.orderHistory.push({ ...order });
    if (this.orderHistory.length > this.maxHistory) {
      this.orderHistory.splice(0, this.orderHistory.length - this.maxHistory);
    }

    this.bus.publish({
      type: "order.created",
      data: { ...order },
      source: "portfolio-agent",
      agentId: "portfolio",
    });

    return order;
  }

  handleFilled(event: FinanceEvent): Fill | null {
    this.recordActivity();
    const data = event.data as Partial<Fill> & { fill?: Partial<Fill> } | null;
    if (!data) return null;

    const raw: Partial<Fill> = data.fill ?? data;
    const symbol = typeof raw.symbol === "string" ? raw.symbol.toUpperCase() : undefined;
    const side: "buy" | "sell" = raw.side === "sell" ? "sell" : "buy";
    const qty = typeof raw.qty === "number" ? raw.qty : undefined;
    const price = typeof raw.price === "number" ? raw.price : undefined;

    if (!symbol || typeof qty !== "number" || typeof price !== "number") return null;
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return null;

    const fill: Fill = {
      symbol,
      side,
      qty,
      price,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
      orderId: raw.orderId,
      fee: raw.fee,
    };

    if (side === "buy") {
      const existing = this.positions.get(symbol);
      if (existing) {
        const totalQty = existing.qty + qty;
        const totalCost = existing.avgPrice * existing.qty + price * qty;
        const newAvg = totalCost / totalQty;
        this.positions.set(symbol, { symbol, qty: totalQty, avgPrice: Number(newAvg.toFixed(6)), currentPrice: price });
      } else {
        this.positions.set(symbol, { symbol, qty, avgPrice: price, currentPrice: price });
      }
      this.cash -= price * qty;
      if (typeof fill.fee === "number" && Number.isFinite(fill.fee)) this.cash -= fill.fee;
    } else {
      const existing = this.positions.get(symbol);
      if (existing) {
        const closeQty = Math.min(qty, existing.qty);
        const realized = (price - existing.avgPrice) * closeQty;
        this.realizedPnL += realized;
        const remaining = existing.qty - qty;
        if (remaining <= 0.0000001) {
          this.positions.delete(symbol);
        } else {
          this.positions.set(symbol, { symbol, qty: remaining, avgPrice: existing.avgPrice, currentPrice: price });
        }
        this.cash += price * closeQty;
        if (typeof fill.fee === "number" && Number.isFinite(fill.fee)) this.cash -= fill.fee;
      } else {
        this.cash += price * qty;
        if (typeof fill.fee === "number" && Number.isFinite(fill.fee)) this.cash -= fill.fee;
      }
    }

    this.cash = Math.round(this.cash * 100) / 100;
    this.realizedPnL = Math.round(this.realizedPnL * 100) / 100;
    this.recalcUnrealized();

    this.fillHistory.push({ ...fill });
    if (this.fillHistory.length > this.maxHistory) {
      this.fillHistory.splice(0, this.fillHistory.length - this.maxHistory);
    }

    this.publishUpdate();
    return fill;
  }

  handleTick(event: FinanceEvent): void {
    const tick = event.data as Tick | null;
    if (!tick || typeof tick.symbol !== "string" || typeof tick.price !== "number") return;
    if (!Number.isFinite(tick.price) || tick.price <= 0) return;

    const sym = tick.symbol.toUpperCase();
    const pos = this.positions.get(sym);
    if (pos) {
      pos.currentPrice = tick.price;
      this.positions.set(sym, { ...pos });
      this.recalcUnrealized();
      this.publishUpdate();
    }
  }

  getPortfolio(): PortfolioSnapshot {
    return {
      cash: this.cash,
      positions: new Map(this.positions),
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      totalValue: this.getTotalValue(),
      positionCount: this.positions.size,
    };
  }

  getPositionsArray(): Position[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  getPnL(): PnL {
    return {
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      totalPnL: Math.round((this.realizedPnL + this.unrealizedPnL) * 100) / 100,
      totalValue: this.getTotalValue(),
      cash: this.cash,
    };
  }

  getAllocation(): Allocation {
    const total = this.getTotalValue();
    const alloc: Allocation = {};
    if (total <= 0) return alloc;
    for (const [sym, pos] of this.positions.entries()) {
      const val = pos.qty * pos.currentPrice;
      alloc[sym] = Math.round((val / total) * 10000) / 10000;
    }
    return alloc;
  }

  getOrderHistory(): Order[] {
    return [...this.orderHistory];
  }

  getFillHistory(): Fill[] {
    return [...this.fillHistory];
  }

  setCash(cash: number): void {
    if (Number.isFinite(cash)) this.cash = Math.round(cash * 100) / 100;
  }

  getCash(): number {
    return this.cash;
  }

  private getTotalValue(): number {
    let posValue = 0;
    for (const pos of this.positions.values()) {
      posValue += pos.qty * pos.currentPrice;
    }
    return Math.round((this.cash + posValue) * 100) / 100;
  }

  private recalcUnrealized(): void {
    let unreal = 0;
    for (const pos of this.positions.values()) {
      unreal += (pos.currentPrice - pos.avgPrice) * pos.qty;
    }
    this.unrealizedPnL = Math.round(unreal * 100) / 100;
  }

  private publishUpdate(): void {
    const snapshot = this.getPortfolio();
    const positionsObj: Record<string, Position> = {};
    for (const [k, v] of snapshot.positions.entries()) positionsObj[k] = { ...v };
    this.bus.publish({
      type: "portfolio.updated",
      data: {
        cash: snapshot.cash,
        positions: positionsObj,
        realizedPnL: snapshot.realizedPnL,
        unrealizedPnL: snapshot.unrealizedPnL,
        totalValue: snapshot.totalValue,
        positionCount: snapshot.positionCount,
        timestamp: Date.now(),
      },
      source: "portfolio-agent",
      agentId: "portfolio",
    });
  }
}
