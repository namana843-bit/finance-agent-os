// ============================================================================
// Finance Agent OS — Shared Types
// Central type definitions for the entire platform
// ============================================================================

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

export interface FinanceEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
  source?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  // Legacy compatibility
  channelId?: string;
  threadId?: string;
  agentId?: string;
  runId?: string;
}

export type EventInput = Omit<FinanceEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: number;
};

export type EventHandler = (event: FinanceEvent) => void | Promise<void>;

export interface HistoryFilter {
  type?: string;
  source?: string;
  correlationId?: string;
  channelId?: string;
  threadId?: string;
  agentId?: string;
  runId?: string;
  since?: number;
  until?: number;
}

// Finance event categories
export const EventCategories = {
  MARKET: {
    TICK: "market.tick",
    CANDLE: "market.candle",
    ORDERBOOK: "market.orderbook",
    TRADE: "market.trade",
  },
  QUANT: {
    ANALYSIS: "quant.analysis",
    SIGNAL: "quant.signal",
  },
  RISK: {
    CHECK: "risk.check",
    APPROVED: "risk.approved",
    REJECTED: "risk.rejected",
    ALERT: "risk.alert",
  },
  PORTFOLIO: {
    UPDATED: "portfolio.updated",
    POSITION_CHANGED: "portfolio.position_changed",
  },
  EXECUTION: {
    CREATED: "order.created",
    SUBMITTED: "order.submitted",
    PARTIALLY_FILLED: "order.partially_filled",
    FILLED: "order.filled",
    CANCELLED: "order.cancelled",
    REJECTED: "order.rejected",
    FAILED: "order.failed",
  },
  TRADE: {
    OPENED: "trade.opened",
    CLOSED: "trade.closed",
  },
  AGENT: {
    STARTED: "agent.started",
    STOPPED: "agent.stopped",
    ERROR: "agent.error",
  },
  SYSTEM: {
    HEALTH: "system.health",
    ERROR: "system.error",
  },
} as const;

// ---------------------------------------------------------------------------
// Market Types
// ---------------------------------------------------------------------------

export type SupportedSymbol = string;

export interface Ticker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  changePercent24h: number;
  timestamp: number;
  source: string;
}

export interface Tick {
  symbol: string;
  price: number;
  change: number;
  volume: number;
  timestamp: number;
  source: "binance" | "synthetic" | string;
}

export interface Candle {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  closed: boolean;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface MarketTrade {
  symbol: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Strategy Types
// ---------------------------------------------------------------------------

export type SignalSide = "buy" | "sell" | "hold";

export interface Signal {
  id: string;
  symbol: string;
  side: SignalSide;
  strategy: string;
  timeframe: string;
  price: number;
  confidence: number;
  timestamp: number;
  indicators: Record<string, unknown>;
  reasoning: string;
  expiration: number;
}

export interface StrategyConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  timeframe: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Risk Types
// ---------------------------------------------------------------------------

export type RiskDecisionType = "APPROVED" | "REJECTED";

export interface RiskDecision {
  id: string;
  decision: RiskDecisionType;
  reason: string;
  rulesChecked: string[];
  requestedQuantity: number;
  approvedQuantity: number;
  riskMetrics: RiskMetrics;
  ticket?: unknown;
  timestamp: number;
  correlationId: string;
}

export interface RiskConfig {
  maxPositionPct: number;
  maxOrderSize: number;
  maxPortfolioExposure: number;
  maxSymbolExposure: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxOpenPositions: number;
  maxLeverage: number;
  cooldownMs: number;
  confidenceThreshold: number;
}

export interface RiskMetrics {
  exposure: number;
  drawdown: number;
  concentration: number;
  var: number;
  sharpe: number;
  totalValue: number;
  cash: number;
  positionCount: number;
  peakValue: number;
  dailyPnL: number;
  leverage: number;
}

// ---------------------------------------------------------------------------
// Portfolio Types
// ---------------------------------------------------------------------------

export interface Position {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: number;
  updatedAt: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface PortfolioSnapshot {
  id: string;
  cash: number;
  equity: number;
  positions: Position[];
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  exposure: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Order Types
// ---------------------------------------------------------------------------

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type OrderStatus =
  | "CREATED"
  | "PENDING"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED";

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  stopPrice?: number;
  status: OrderStatus;
  strategy?: string;
  agent?: string;
  executionMode: "paper" | "live";
  filledQuantity: number;
  averageFillPrice: number;
  fees: number;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
}

// ---------------------------------------------------------------------------
// Trade Types
// ---------------------------------------------------------------------------

export interface Trade {
  id: string;
  symbol: string;
  strategy: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  fees: number;
  pnl: number;
  openedAt: number;
  closedAt?: number;
  status: "open" | "closed";
}

// ---------------------------------------------------------------------------
// Exchange Types
// ---------------------------------------------------------------------------

export type ExchangeId = "binance" | "bybit" | "okx" | "coinbase" | string;

export interface ExchangeConfig {
  id: ExchangeId;
  apiKey?: string;
  secret?: string;
  sandbox?: boolean;
}

// ---------------------------------------------------------------------------
// Agent Types
// ---------------------------------------------------------------------------

export type AgentStatus = "idle" | "running" | "stopped" | "error";

export interface AgentHealth {
  status: AgentStatus;
  uptime: number;
  lastActivity: number;
  errorCount: number;
  eventsProcessed: number;
}

/**
 * AgentManifest — full metadata that an agent exposes to the runtime.
 * Returned by agents to describe their capabilities, required tools,
 * event subscriptions, and permissions.
 */
export interface AgentManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  /** Tool IDs this agent requires or uses. */
  tools: string[];
  /** Event types this agent subscribes to. */
  subscriptions: string[];
  /** Permissions the agent needs (e.g., "trade", "read-market"). */
  permissions: string[];
}

// ---------------------------------------------------------------------------
// Tool Types
// ---------------------------------------------------------------------------

export interface ToolPermission {
  required: boolean;
  roles?: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  permissions: ToolPermission;
}

// ---------------------------------------------------------------------------
// Plugin Types
// ---------------------------------------------------------------------------

export type PluginStatus = "registered" | "initialized" | "active" | "stopped" | "error";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: PluginStatus;
}

/**
 * PluginManifest — full metadata that a plugin exposes to the runtime.
 * Describes what the plugin provides and its capabilities.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Capabilities this plugin provides (e.g., "market-data", "order-execution"). */
  capabilities: string[];
  /** Exchange or provider ID if applicable. */
  provider?: string;
}

// ---------------------------------------------------------------------------
// Audit Types
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  timestamp: number;
  eventType: string;
  source: string;
  agentId?: string;
  correlationId?: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API Types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  uptime: number;
  timestamp: number;
  version: string;
  agents: Record<string, AgentHealth>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// LLM & Engine Types (Phase 4)
// ---------------------------------------------------------------------------

export type LLMEventType =
  | "message_start"
  | "text_delta"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "message_complete"
  | "error";

export type LLMEvent =
  | { type: "message_start"; messageId: string; model: string; timestamp: number }
  | { type: "text_delta"; messageId: string; delta: string; timestamp: number }
  | { type: "reasoning_delta"; messageId: string; delta: string; timestamp: number }
  | { type: "tool_call"; messageId: string; toolCallId: string; name: string; arguments: Record<string, unknown>; timestamp: number }
  | { type: "tool_result"; messageId: string; toolCallId: string; name: string; result: unknown; isError?: boolean; timestamp: number }
  | { type: "message_complete"; messageId: string; text: string; finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number }; timestamp: number }
  | { type: "error"; messageId?: string; error: string; code?: string; timestamp: number };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  description?: string;
}

export interface ProviderHealth {
  providerId: string;
  status: "ok" | "degraded" | "error" | "unreachable";
  message?: string;
  latencyMs?: number;
  modelsCount?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export type LLMProviderType =
  | "openai"
  | "openrouter"
  | "ollama"
  | "openai-compatible"
  | "cli"
  | "acp";

export interface OpenAIEngineConfig {
  type: "api";
  provider: "openai";
  model: string;
  apiKeyEnv?: string;
}

export interface OpenRouterEngineConfig {
  type: "api";
  provider: "openrouter";
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface OllamaEngineConfig {
  type: "api";
  provider: "ollama";
  model: string;
  baseUrl?: string;
}

export interface OpenAICompatibleEngineConfig {
  type: "api";
  provider: "openai-compatible";
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
}

export interface CliEngineConfig {
  type: "cli";
  provider: "cli";
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
}

export interface AcpEngineConfig {
  type: "acp";
  provider: "acp";
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type EngineConfig =
  | OpenAIEngineConfig
  | OpenRouterEngineConfig
  | OllamaEngineConfig
  | OpenAICompatibleEngineConfig
  | CliEngineConfig
  | AcpEngineConfig;

