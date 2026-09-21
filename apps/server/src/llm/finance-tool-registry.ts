import type { LLMToolDefinition } from "@finance/shared";
import type { ExecutionPipeline } from "../execution-pipeline/pipeline.js";
import {
  executeBollingerBands,
  executeEMA,
  executeMACDIndicator,
  executeSMA,
} from "../tools/indicators.js";
import {
  executeCalculateRSI,
  executeSupertrend,
} from "../tools/finance-tools.js";

export interface FinanceTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface FinanceToolRegistryOptions {
  pipeline?: ExecutionPipeline;
  marketState?: Map<string, { price: number; timestamp: number }>;
  portfolioState?: { cash: number; positions: Map<string, { qty: number; avgPrice: number; currentPrice: number }> };
}

export class FinanceToolRegistry {
  private readonly tools = new Map<string, FinanceTool>();
  private pipeline?: ExecutionPipeline;
  private marketState: Map<string, { price: number; timestamp: number }>;
  private portfolioState: { cash: number; positions: Map<string, { qty: number; avgPrice: number; currentPrice: number }> };

  constructor(opts: FinanceToolRegistryOptions = {}) {
    this.pipeline = opts.pipeline;
    this.marketState = opts.marketState ?? new Map([
      ["BTCUSDT", { price: 68500, timestamp: Date.now() }],
      ["ETHUSDT", { price: 3500, timestamp: Date.now() }],
      ["SOLUSDT", { price: 145, timestamp: Date.now() }],
    ]);
    this.portfolioState = opts.portfolioState ?? {
      cash: 100_000,
      positions: new Map([
        ["BTCUSDT", { qty: 0.5, avgPrice: 65000, currentPrice: 68500 }],
      ]),
    };

    this.registerDefaultTools();
  }

  setPipeline(pipeline: ExecutionPipeline): void {
    this.pipeline = pipeline;
  }

  registerTool(tool: FinanceTool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): FinanceTool | undefined {
    return this.tools.get(name);
  }

  listTools(): FinanceTool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(toolNames?: string[]): LLMToolDefinition[] {
    const activeTools = toolNames && toolNames.length > 0
      ? toolNames.map((name) => this.tools.get(name)).filter((t): t is FinanceTool => Boolean(t))
      : Array.from(this.tools.values());

    return activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found in FinanceToolRegistry`);
    }
    return tool.execute(input);
  }

  private registerDefaultTools(): void {
    // 1. Market Data — Price
    this.registerTool({
      name: "get_market_price",
      description: "Get current price and ticker information for a cryptocurrency symbol (e.g. BTCUSDT, ETHUSDT)",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. BTCUSDT" },
        },
        required: ["symbol"],
      },
      execute: async (input) => {
        const symbol = String(input.symbol || "BTCUSDT").toUpperCase();
        const state = this.marketState.get(symbol);
        const price = state ? state.price : symbol === "ETHUSDT" ? 3500 : 68500;
        return {
          symbol,
          price,
          timestamp: Date.now(),
          bid: price * 0.9999,
          ask: price * 1.0001,
          volume24h: 125000000,
        };
      },
    });

    // 2. Market Data — OHLCV Candles
    this.registerTool({
      name: "get_ohlcv",
      description: "Get historical OHLCV candlestick data for technical analysis",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. BTCUSDT" },
          timeframe: { type: "string", description: "Timeframe e.g. 1m, 5m, 1h, 1d", default: "1m" },
          limit: { type: "number", description: "Number of candles to return", default: 20 },
        },
        required: ["symbol"],
      },
      execute: async (input) => {
        const symbol = String(input.symbol || "BTCUSDT").toUpperCase();
        const limit = Math.min(Number(input.limit || 20), 100);
        const timeframe = String(input.timeframe || "1m");
        const state = this.marketState.get(symbol);
        const basePrice = state ? state.price : 68500;
        const now = Date.now();

        const candles = Array.from({ length: limit }, (_, i) => {
          const drift = (Math.random() - 0.48) * basePrice * 0.005;
          const open = basePrice + drift;
          const close = open + (Math.random() - 0.49) * open * 0.004;
          return {
            symbol,
            timeframe,
            open: Math.round(open * 100) / 100,
            high: Math.round(Math.max(open, close) * 1.001 * 100) / 100,
            low: Math.round(Math.min(open, close) * 0.999 * 100) / 100,
            close: Math.round(close * 100) / 100,
            volume: Math.round(Math.random() * 500 * 100) / 100,
            timestamp: now - (limit - i) * 60_000,
          };
        });

        return { symbol, timeframe, candlesCount: candles.length, candles };
      },
    });

    // 3. Technical Indicator — RSI
    this.registerTool({
      name: "calculate_rsi",
      description: "Calculate Relative Strength Index (RSI) momentum indicator for price array",
      inputSchema: {
        type: "object",
        properties: {
          prices: { type: "array", items: { type: "number" }, description: "Price series" },
          period: { type: "number", default: 14 },
        },
        required: ["prices"],
      },
      execute: async (input) => {
        return executeCalculateRSI(input);
      },
    });

    // 4. Technical Indicator — MACD
    this.registerTool({
      name: "calculate_macd",
      description: "Calculate Moving Average Convergence Divergence (MACD) indicator",
      inputSchema: {
        type: "object",
        properties: {
          prices: { type: "array", items: { type: "number" }, description: "Price series" },
          fast: { type: "number", default: 12 },
          slow: { type: "number", default: 26 },
          signal: { type: "number", default: 9 },
        },
        required: ["prices"],
      },
      execute: async (input) => {
        return executeMACDIndicator(input);
      },
    });

    // 5. Technical Indicator — Supertrend
    this.registerTool({
      name: "calculate_supertrend",
      description: "Calculate Supertrend trend indicator with upper and lower bands",
      inputSchema: {
        type: "object",
        properties: {
          prices: { type: "array", items: { type: "number" }, description: "Price series" },
          period: { type: "number", default: 10 },
          multiplier: { type: "number", default: 3 },
        },
        required: ["prices"],
      },
      execute: async (input) => {
        return executeSupertrend(input);
      },
    });

    // 6. Portfolio & Balance
    this.registerTool({
      name: "get_portfolio",
      description: "Get current paper portfolio snapshot including available cash, active positions, and unrealized PnL",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const positions = Array.from(this.portfolioState.positions.entries()).map(([symbol, p]) => ({
          symbol,
          quantity: p.qty,
          entryPrice: p.avgPrice,
          currentPrice: p.currentPrice,
          value: p.qty * p.currentPrice,
          unrealizedPnl: (p.currentPrice - p.avgPrice) * p.qty,
        }));
        const posValue = positions.reduce((sum, p) => sum + p.value, 0);
        return {
          cash: this.portfolioState.cash,
          positionsValue: posValue,
          totalEquity: this.portfolioState.cash + posValue,
          positions,
        };
      },
    });

    // 7. CRITICAL STEP 14: Structured Trade Proposal Tool
    this.registerTool({
      name: "create_trade_proposal",
      description: "Create a structured trade proposal for evaluation by the Execution Pipeline, Risk Engine, and Hard Safety Limits. MUST be called when initiating a trade.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Asset symbol e.g. BTCUSDT" },
          side: { type: "string", enum: ["BUY", "SELL", "buy", "sell"], description: "Order side" },
          quantity: { type: "number", description: "Order quantity" },
          orderType: { type: "string", enum: ["MARKET", "LIMIT", "market", "limit"], default: "MARKET" },
          price: { type: "number", description: "Target price (required for limit, optional for market)" },
          reason: { type: "string", description: "Quantitative reasoning or signal trigger for the trade" },
          confidence: { type: "number", description: "Model confidence rating between 0 and 1", default: 0.8 },
        },
        required: ["symbol", "side", "quantity"],
      },
      execute: async (input) => {
        const symbol = String(input.symbol).toUpperCase();
        const side = String(input.side).toLowerCase() as "buy" | "sell";
        const quantity = Number(input.quantity);
        const orderType = String(input.orderType || "market").toLowerCase() as "market" | "limit";
        const price = Number(input.price) || (this.marketState.get(symbol)?.price ?? 68500);
        const confidence = Number(input.confidence) || 0.8;
        const reason = String(input.reason || "LLM strategy trade proposal");

        if (quantity <= 0) {
          return {
            status: "REJECTED",
            decision: "REJECTED",
            reason: "Quantity must be greater than zero",
          };
        }

        const signalPayload = {
          id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          symbol,
          side,
          quantity,
          type: orderType,
          price,
          confidence,
          reasoning: reason,
          agentId: "llm-agent",
          strategy: "llm-quant",
          timestamp: Date.now(),
        };

        if (!this.pipeline) {
          return {
            status: "SIMULATED_APPROVED",
            decision: "APPROVED",
            proposal: signalPayload,
            note: "ExecutionPipeline not attached — trade simulated",
          };
        }

        // Enforce existing safety pipeline: Kill Switch -> Hard Limits -> Risk Engine -> Permission -> Paper Broker
        const pipelineResult = await this.pipeline.execute(signalPayload);

        if (pipelineResult.success) {
          return {
            status: "EXECUTED",
            decision: "APPROVED",
            stage: pipelineResult.stage,
            order: pipelineResult.order,
            correlationId: pipelineResult.correlationId,
            signalId: pipelineResult.signalId,
            durationMs: pipelineResult.durationMs,
            riskDecision: pipelineResult.riskDecision,
          };
        }

        return {
          status: "REJECTED",
          decision: "REJECTED",
          stage: pipelineResult.stage,
          reason: pipelineResult.reason,
          correlationId: pipelineResult.correlationId,
          signalId: pipelineResult.signalId,
          riskDecision: pipelineResult.riskDecision,
        };
      },
    });
  }
}
