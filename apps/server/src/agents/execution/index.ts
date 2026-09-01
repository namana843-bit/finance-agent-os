import { BaseAgent } from "@finance/core";
import type { Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { v4 as uuidv4 } from "uuid";
import {
  createExchange,
  createExchangeSync,
  createOrder as ccxtCreateOrder,
  type Exchange,
} from "./ccxtWrapper.js";

export { createExchange, createExchangeSync, ccxtCreateOrder };

export type ExecutionMode = "paper" | "live";

export interface ExecutionConfig {
  mode: ExecutionMode;
  slippage: number;
  fee: number;
  latency: number;
}

export interface Order {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  confidence?: number;
  timestamp?: number;
  id?: string;
  orderId?: string;
  [key: string]: unknown;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fee: number;
  timestamp: number;
  mode: ExecutionMode;
  slippage?: number;
  rawPrice?: number;
}

export interface Rejected {
  orderId: string;
  symbol?: string;
  side?: string;
  reason: string;
  timestamp: number;
  mode: ExecutionMode;
}

export interface ExecutionStats {
  mode: ExecutionMode;
  totalFills: number;
  totalVolume: number;
  totalFees: number;
  totalNotional: number;
  avgFee: number;
  avgSlippage: number;
}

export class ExecutionAgent extends BaseAgent implements Agent {
  private bus: TypedEventBus;
  private config: ExecutionConfig;
  private fills: Fill[] = [];
  private rejected: Rejected[] = [];
  private unsubscribe: (() => void) | null = null;
  private maxHistory = 500;
  private exchange: Exchange | null = null;

  constructor(bus?: TypedEventBus, config?: Partial<ExecutionConfig>) {
    super({
      id: "execution",
      name: "Execution Agent",
      version: "0.1.0",
      description: "Order execution with paper and live trading support",
      capabilities: ["order-execution", "paper-trading", "live-trading"],
    });
    this.bus = bus ?? new TypedEventBus();

    const envMode = (process.env.EXECUTION_MODE as ExecutionMode | undefined)?.toLowerCase() as
      | ExecutionMode
      | undefined;
    const mode: ExecutionMode =
      config?.mode ??
      (envMode === "live" || envMode === "paper" ? envMode : undefined) ??
      "paper";

    this.config = {
      mode,
      slippage: config?.slippage ?? 0.0005,
      fee: config?.fee ?? 0.001,
      latency: config?.latency ?? 100,
    };
  }

  async start(): Promise<void> {
    await super.start();
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "order.created") {
        const order = event.data as Order | null;
        if (order) {
          void this.execute(order).catch((err) => this.recordError(err));
        }
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
    if (event.type === "order.created") {
      const order = event.data as Order;
      await this.execute(order);
    }
  }

  async execute(order: Order): Promise<Fill | null> {
    this.recordActivity();
    const now = Date.now();
    const validation = this.validateOrder(order);
    const orderId = (order.id as string) ?? (order.orderId as string) ?? uuidv4();
    const symbol = typeof order.symbol === "string" ? order.symbol.toUpperCase() : undefined;
    const sideRaw = (order.side as string) ?? (order as unknown as { action?: string }).action;
    const side: "buy" | "sell" | undefined =
      sideRaw?.toString().toLowerCase() === "sell" ? "sell" : sideRaw?.toString().toLowerCase() === "buy" ? "buy" : undefined;

    if (!validation.valid) {
      const rejected: Rejected = {
        orderId,
        symbol,
        side: side ?? undefined,
        reason: validation.reason!,
        timestamp: now,
        mode: this.config.mode,
      };
      this.rejected.push(rejected);
      if (this.rejected.length > this.maxHistory) {
        this.rejected.splice(0, this.rejected.length - this.maxHistory);
      }
      this.bus.publish({
        type: "order.rejected",
        data: rejected,
        source: "execution-agent",
        agentId: "execution",
      });
      return null;
    }

    const qty = order.qty as number;
    const rawPrice = order.price as number;
    const validSide = side as "buy" | "sell";
    const validSymbol = symbol!;

    if (this.config.latency > 0) {
      await this.sleep(this.config.latency);
    }

    let fillPrice: number;
    let fee: number;

    if (this.config.mode === "paper") {
      const slippage = this.config.slippage;
      fillPrice = validSide === "buy" ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage);
      fillPrice = Math.round(fillPrice * 100) / 100;
      fee = Math.round(fillPrice * qty * this.config.fee * 100) / 100;
    } else {
      if (!this.exchange) {
        try {
          this.exchange = await createExchange("binance");
        } catch {
          this.exchange = createExchangeSync("binance");
        }
      }

      if (this.exchange.isMock) {
        const slippage = this.config.slippage;
        fillPrice = validSide === "buy" ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage);
        fillPrice = Math.round(fillPrice * 100) / 100;
        fee = Math.round(fillPrice * qty * this.config.fee * 100) / 100;
      } else {
        try {
          const ccxtOrder = await ccxtCreateOrder(this.exchange, validSymbol, "market", validSide, qty, rawPrice);
          fillPrice = typeof ccxtOrder.price === "number" && ccxtOrder.price > 0 ? ccxtOrder.price : rawPrice;
          const ccxtFee = ccxtOrder.fee?.cost;
          fee = typeof ccxtFee === "number" && Number.isFinite(ccxtFee)
            ? Math.round(ccxtFee * 100) / 100
            : Math.round(fillPrice * qty * this.config.fee * 100) / 100;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.rejected.push({ orderId, symbol: validSymbol, side: validSide, reason: `live execution failed: ${reason}`, timestamp: Date.now(), mode: this.config.mode });
          this.bus.publish({ type: "order.rejected", data: { orderId, symbol: validSymbol, side: validSide, reason, timestamp: Date.now() }, source: "execution-agent", agentId: "execution" });
          return null;
        }
      }
    }

    const fill: Fill = {
      orderId,
      symbol: validSymbol,
      side: validSide,
      qty,
      price: fillPrice,
      fee,
      timestamp: Date.now(),
      mode: this.config.mode,
      slippage: this.config.slippage,
      rawPrice,
    };

    this.fills.push({ ...fill });
    if (this.fills.length > this.maxHistory) {
      this.fills.splice(0, this.fills.length - this.maxHistory);
    }

    this.bus.publish({
      type: "order.filled",
      data: { ...fill },
      source: "execution-agent",
      agentId: "execution",
    });

    console.log(`[ExecutionAgent] filled ${orderId} ${validSymbol} ${validSide} qty=${qty} price=${fillPrice} fee=${fee} mode=${this.config.mode}`);
    return fill;
  }

  setMode(mode: ExecutionMode): void {
    this.config.mode = mode;
    if (mode === "paper") {
      // keep mock
    } else {
      this.exchange = null;
    }
  }

  getMode(): ExecutionMode {
    return this.config.mode;
  }

  getConfig(): ExecutionConfig {
    return { ...this.config };
  }

  getFills(limit?: number, symbol?: string): Fill[] {
    let out = this.fills;
    if (symbol) {
      const sym = symbol.toUpperCase();
      out = out.filter((f) => f.symbol === sym);
    }
    if (limit !== undefined && limit !== null && limit > 0) {
      out = out.slice(-limit);
    }
    return [...out];
  }

  getRejected(limit?: number): Rejected[] {
    let out = this.rejected;
    if (limit !== undefined && limit !== null && limit > 0) {
      out = out.slice(-limit);
    }
    return [...out];
  }

  getStats(): ExecutionStats {
    const totalFills = this.fills.length;
    let totalVolume = 0;
    let totalFees = 0;
    let totalNotional = 0;
    let slippageSum = 0;

    for (const f of this.fills) {
      totalVolume += f.qty;
      totalFees += f.fee;
      totalNotional += f.price * f.qty;
      slippageSum += f.slippage ?? this.config.slippage;
    }

    return {
      mode: this.config.mode,
      totalFills,
      totalVolume: Math.round(totalVolume * 100000) / 100000,
      totalFees: Math.round(totalFees * 100) / 100,
      totalNotional: Math.round(totalNotional * 100) / 100,
      avgFee: totalFills > 0 ? Math.round((totalFees / totalFills) * 100) / 100 : 0,
      avgSlippage: totalFills > 0 ? Math.round((slippageSum / totalFills) * 100000) / 100000 : this.config.slippage,
    };
  }

  private validateOrder(order: Order): { valid: boolean; reason?: string } {
    if (!order || typeof order !== "object") return { valid: false, reason: "order is null or not an object" };
    if (!order.symbol || typeof order.symbol !== "string" || order.symbol.trim() === "")
      return { valid: false, reason: "symbol is required" };
    const sideRaw = (order.side as string) ?? (order as unknown as { action?: string }).action;
    if (!sideRaw || (sideRaw.toString().toLowerCase() !== "buy" && sideRaw.toString().toLowerCase() !== "sell"))
      return { valid: false, reason: "side must be buy or sell" };
    if (typeof order.qty !== "number" || !Number.isFinite(order.qty) || order.qty <= 0)
      return { valid: false, reason: "qty must be > 0" };
    if (typeof order.price !== "number" || !Number.isFinite(order.price) || order.price <= 0)
      return { valid: false, reason: "price must be > 0" };
    return { valid: true };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
