import { EventBus, eventBus as defaultBus, type FinanceEvent } from "../../core/eventBus.js";
import { v4 as uuidv4 } from "uuid";
import {
  createExchange,
  createExchangeSync,
  createOrder as ccxtCreateOrder,
  fetchBalance as ccxtFetchBalance,
  type Exchange,
} from "./ccxtWrapper.js";

export { createExchange, createExchangeSync, ccxtCreateOrder, ccxtFetchBalance };
export type { Exchange };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionMode = "paper" | "live";

export interface ExecutionConfig {
  mode: ExecutionMode;
  slippage: number; // 0.0005 = 0.05%
  fee: number; // 0.001 = 0.1%
  latency: number; // ms
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
  // allow extra fields
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
  // optional notional/slippage diagnostics
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

// ---------------------------------------------------------------------------
// ExecutionAgent
// ---------------------------------------------------------------------------

export class ExecutionAgent {
  public readonly name = "Execution Agent";

  private bus: EventBus;
  private config: ExecutionConfig;
  private fills: Fill[] = [];
  private rejected: Rejected[] = [];
  private unsubscribe: (() => void) | null = null;
  private maxHistory = 500;
  private exchange: Exchange | null = null;

  constructor(bus?: EventBus, config?: Partial<ExecutionConfig>) {
    this.bus = bus ?? defaultBus;

    const envMode = (process.env.EXECUTION_MODE as ExecutionMode | undefined)?.toLowerCase() as
      | ExecutionMode
      | undefined;
    const mode: ExecutionMode =
      config?.mode ??
      (envMode === "live" || envMode === "paper" ? envMode : undefined) ??
      "paper";

    this.config = {
      mode,
      slippage: config?.slippage ?? 0.0005, // 0.05%
      fee: config?.fee ?? 0.001, // 0.1%
      latency: config?.latency ?? 100,
    };

    // init mock/live exchange placeholder synchronously for paper
    // async real exchange will be lazily created on first live execute
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      if (event.type === "portfolio:order") {
        const order = event.data as Order | null;
        if (order) {
          // fire-and-forget async execute
          void this.execute(order).catch((err) => {
            console.error(`[ExecutionAgent] execute error:`, err);
          });
        }
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  isRunning(): boolean {
    return this.unsubscribe !== null;
  }

  // -------------------------------------------------------------------------
  // Core: execute
  // -------------------------------------------------------------------------

  /**
   * Execute an order.
   * - Validates qty/price/symbol/side
   * - Generates orderId uuid if missing
   * - In paper mode: simulate slippage/fee + latency, publish execution:filled
   * - In live mode: placeholder for CCXT binance (falls back to mock if no keys)
   * - On invalid order: publish execution:rejected
   */
  async execute(order: Order): Promise<Fill | null> {
    const now = Date.now();

    // --- validation ---
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
        side: side ?? (typeof sideRaw === "string" ? String(sideRaw).toLowerCase() : undefined),
        reason: validation.reason!,
        timestamp: now,
        mode: this.config.mode,
      };
      this.rejected.push(rejected);
      if (this.rejected.length > this.maxHistory) {
        this.rejected.splice(0, this.rejected.length - this.maxHistory);
      }
      try {
        this.bus.publish({ type: "execution:rejected", data: rejected });
      } catch (err) {
        console.error("[ExecutionAgent] publish execution:rejected failed:", err);
      }
      console.warn(`[ExecutionAgent] rejected ${orderId} reason=${validation.reason}`);
      return null;
    }

    // At this point order is valid
    const qty = order.qty as number;
    const rawPrice = order.price as number;
    const validSide = side as "buy" | "sell";
    const validSymbol = symbol!;

    // Simulate latency
    if (this.config.latency > 0) {
      await this.sleep(this.config.latency);
    }

    let fillPrice: number;
    let fee: number;

    if (this.config.mode === "paper") {
      // --- paper simulation ---
      const slippage = this.config.slippage;
      // buy pays higher, sell receives lower
      fillPrice = validSide === "buy" ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage);
      fillPrice = Math.round(fillPrice * 100) / 100; // 2 decimals
      fee = Math.round(fillPrice * qty * this.config.fee * 100) / 100;
    } else {
      // --- live mode: CCXT placeholder ---
      // ensure exchange initialized
      if (!this.exchange) {
        // Try async real exchange; fallback to sync mock
        try {
          this.exchange = await createExchange("binance");
        } catch {
          this.exchange = createExchangeSync("binance");
        }
      }

      // If mock, simulate same as paper but tag mode live
      if (this.exchange.isMock) {
        const slippage = this.config.slippage;
        fillPrice = validSide === "buy" ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage);
        fillPrice = Math.round(fillPrice * 100) / 100;
        fee = Math.round(fillPrice * qty * this.config.fee * 100) / 100;
        console.log(`[ExecutionAgent] live mode mock fill for ${validSymbol} ${validSide} qty=${qty} price=${fillPrice}`);
      } else {
        // Real CCXT call
        try {
          const ccxtOrder = await ccxtCreateOrder(
            this.exchange,
            validSymbol,
            "market",
            validSide,
            qty,
            rawPrice,
          );
          // Real fill price may differ; use returned price or rawPrice
          fillPrice = typeof ccxtOrder.price === "number" && ccxtOrder.price > 0 ? ccxtOrder.price : rawPrice;
          // fee from ccxt if available
          const ccxtFee = ccxtOrder.fee?.cost;
          fee =
            typeof ccxtFee === "number" && Number.isFinite(ccxtFee)
              ? Math.round(ccxtFee * 100) / 100
              : Math.round(fillPrice * qty * this.config.fee * 100) / 100;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const rejected: Rejected = {
            orderId,
            symbol: validSymbol,
            side: validSide,
            reason: `live execution failed: ${reason}`,
            timestamp: Date.now(),
            mode: this.config.mode,
          };
          this.rejected.push(rejected);
          try {
            this.bus.publish({ type: "execution:rejected", data: rejected });
          } catch (e) {
            console.error("[ExecutionAgent] publish execution:rejected failed:", e);
          }
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

    try {
      this.bus.publish({ type: "execution:filled", data: { ...fill } });
    } catch (err) {
      console.error("[ExecutionAgent] publish execution:filled failed:", err);
    }

    console.log(
      `[ExecutionAgent] filled ${orderId} ${validSymbol} ${validSide} qty=${qty} price=${fillPrice} fee=${fee} mode=${this.config.mode}`,
    );

    return fill;
  }

  // -------------------------------------------------------------------------
  // Mode / Config
  // -------------------------------------------------------------------------

  setMode(mode: ExecutionMode): void {
    if (mode !== "paper" && mode !== "live") {
      throw new Error(`Invalid mode ${mode}, expected paper|live`);
    }
    this.config.mode = mode;
    // Reset exchange so next live execute re-creates with correct mode
    if (mode === "paper") {
      // optionally keep mock
    } else {
      // will lazy init real exchange on next execute
      this.exchange = null;
    }
  }

  getMode(): ExecutionMode {
    return this.config.mode;
  }

  getConfig(): ExecutionConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<ExecutionConfig>): void {
    if (patch.mode !== undefined) this.setMode(patch.mode);
    if (patch.slippage !== undefined && Number.isFinite(patch.slippage)) this.config.slippage = patch.slippage;
    if (patch.fee !== undefined && Number.isFinite(patch.fee)) this.config.fee = patch.fee;
    if (patch.latency !== undefined && Number.isFinite(patch.latency)) this.config.latency = patch.latency;
  }

  // -------------------------------------------------------------------------
  // History / Stats
  // -------------------------------------------------------------------------

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

  clearFills(): void {
    this.fills = [];
    this.rejected = [];
  }

  size(): number {
    return this.fills.length;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

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

  // Convenience handler for event subscription (exposed for testing)
  async handleOrder(event: FinanceEvent): Promise<Fill | null> {
    const order = event.data as Order;
    return this.execute(order);
  }
}

export const executionAgent = new ExecutionAgent();

export default ExecutionAgent;
