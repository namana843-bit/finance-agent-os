import type { TypedEventBus } from "@finance/core";
import type {
  LLMEvent,
  LLMMessage,
} from "@finance/shared";
import type { FinanceToolRegistry } from "./finance-tool-registry.js";
import { AgentPersistence } from "./persistence.js";
import type { EngineManager } from "./registry.js";
import { buildRoutePlan, resolveAttempts, streamWithFallback } from "./routing.js";

export type AgentStatus = "active" | "busy" | "idle" | "archived";

export interface AgentConcurrency {
  maxConcurrent?: number;
}

/** Metadata for one persistent conversation with a coworker. */
export interface ConversationMeta {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Mutable conversation record: id + message history + timestamps. */
export interface ConversationRecord {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messages: LLMMessage[];
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  role?: string;
  engine: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  permissions?: {
    execution?: boolean;
  };
  riskPermissions?: {
    allowTradeProposals?: boolean;
    maxOrderSize?: number;
  };
  avatar?: string;
  personality?: string;
  providerId?: string;
  memoryScope?: string;
  concurrency?: AgentConcurrency;
  /** Ordered fallback providers, tried only when the primary fails early. */
  fallbacks?: Array<{ providerId: string; model?: string }>;
  /** Lifecycle status: archived (soft-deleted) | busy (run in flight) | idle | active. */
  status?: AgentStatus;
  /** Soft-delete flag. Archived bots are hidden from default listings. */
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Built-in system agents. They can be updated but never archived or deleted. */
export const BUILT_IN_AGENT_IDS = [
  "btc-quant-agent",
  "risk-guardian-agent",
  "cline-cli-agent",
  "market-research-agent",
  "finance-lead-agent",
  "financebot-supervisor",
  "financebot-market-researcher",
  "financebot-quant-researcher",
  "financebot-risk-guardian",
  "financebot-portfolio-manager",
  "financebot-execution-analyst",
  "financebot-macro-economist",
];

export function isBuiltInAgent(id: string): boolean {
  return BUILT_IN_AGENT_IDS.includes(id);
}

export interface AgentRuntimeOptions {
  engineManager: EngineManager;
  toolRegistry: FinanceToolRegistry;
  bus?: TypedEventBus;
  persistence?: AgentPersistence;
}

export class AgentRuntime {
  private readonly engineManager: EngineManager;
  private readonly toolRegistry: FinanceToolRegistry;
  private readonly bus?: TypedEventBus;
  private readonly persistence: AgentPersistence;
  private readonly agentConfigs = new Map<string, AgentConfig>();
  /** Exclusive-run lock: only one agent streams/uses tools at a time.
   * A new run aborts all other agents; attached watchers stay subscribed
   * but take no action. */
  private readonly activeRuns = new Map<string, AbortController>();
  /** Per-agent persistent conversations: agentId -> conversationId -> record. */
  private readonly conversations = new Map<string, Map<string, ConversationRecord>>();

  constructor(opts: AgentRuntimeOptions) {
    this.engineManager = opts.engineManager;
    this.toolRegistry = opts.toolRegistry;
    this.bus = opts.bus;
    this.persistence = opts.persistence ?? new AgentPersistence();
    this.ensureDefaultAgents();
    void this.init();
  }

  private async init(): Promise<void> {
    const saved = await this.persistence.loadAgents();
    for (const a of saved) {
      this.agentConfigs.set(a.id, a);
      const loaded = await this.persistence.loadConversations(a.id);
      const convos = new Map<string, ConversationRecord>();
      const now = new Date();
      for (const [conversationId, messages] of loaded) {
        convos.set(conversationId, {
          id: conversationId,
          agentId: a.id,
          createdAt: messages.length > 0 ? new Date(messages[0].timestamp ?? now.getTime()).toISOString() : now.toISOString(),
          updatedAt: messages.length > 0 ? new Date(messages[messages.length - 1].timestamp ?? now.getTime()).toISOString() : now.toISOString(),
          messages,
        });
      }
      this.conversations.set(a.id, convos);
    }
    this.ensureDefaultAgents();
    this.ensureConversationDefaults();
  }

  private ensureConversationDefaults(): void {
    for (const id of this.agentConfigs.keys()) {
      if (!this.conversations.has(id)) this.conversations.set(id, new Map());
    }
  }

  /** All conversations for one coworker, most recently updated first. */
  async listConversations(agentId: string): Promise<ConversationMeta[]> {
    const map = this.conversations.get(agentId) ?? new Map<string, ConversationRecord>();
    const metas: ConversationMeta[] = [];
    for (const record of map.values()) {
      metas.push({
        id: record.id,
        agentId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
      });
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Create a fresh conversation for a coworker and persist it. */
  async createConversation(agentId: string): Promise<string> {
    const conversationId = `${agentId}-conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const map = this.conversations.get(agentId) ?? new Map<string, ConversationRecord>();
    map.set(conversationId, {
      id: conversationId,
      agentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    this.conversations.set(agentId, map);
    await this.saveConversation(agentId, conversationId, []);
    return conversationId;
  }

  /** Load one conversation's message history (defaults to the agent's default conversation). */
  async getConversation(agentId: string, conversationId?: string): Promise<LLMMessage[]> {
    const id = conversationId ?? agentId;
    const map = this.conversations.get(agentId);
    const record = map?.get(id);
    if (record) return record.messages;
    const loaded = await this.persistence.loadConversation(agentId, id);
    const fresh: ConversationRecord = {
      id,
      agentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: loaded,
    };
    this.conversations.get(agentId)?.set(id, fresh);
    return loaded;
  }

  async saveConversation(agentId: string, conversationId: string, messages: LLMMessage[]): Promise<void> {
    const map = this.conversations.get(agentId) ?? new Map<string, ConversationRecord>();
    const now = new Date().toISOString();
    let record = map.get(conversationId);
    if (!record) {
      record = {
        id: conversationId,
        agentId,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      map.set(conversationId, record);
    }
    record.messages = messages;
    record.updatedAt = now;
    this.conversations.set(agentId, map);
    await this.persistence.saveConversation(agentId, conversationId, messages);
  }

  async deleteConversation(agentId: string, conversationId: string): Promise<boolean> {
    const map = this.conversations.get(agentId);
    if (!map?.delete(conversationId)) return false;
    // Persist the now-empty conversation file shape without re-creating a record.
    await this.persistence.saveConversation(agentId, conversationId, []);
    return true;
  }

  /** Regenerate the reply for a conversation: truncate after the last user
   * message and re-run the same prompt. Returns the re-run prompt + history. */
  async regenerateConversation(agentId: string, conversationId: string): Promise<{ prompt: string; history: LLMMessage[] } | undefined> {
    const map = this.conversations.get(agentId);
    const record = map?.get(conversationId);
    const messages = record ? record.messages : await this.getConversation(agentId, conversationId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user") {
        const history = messages.slice(0, i);
        const prompt = message.content;
        await this.saveConversation(agentId, conversationId, history);
        return { prompt, history };
      }
    }
    return undefined;
  }

  /** Stop an agent's in-flight run (aborts the exclusive lock holder). */
  stopAgent(agentId: string): boolean {
    const ctrl = this.activeRuns.get(agentId);
    if (!ctrl) return false;
    try { ctrl.abort(); } catch { /* ignore */ }
    this.activeRuns.delete(agentId);
    return true;
  }

  /** Switch a custom (non built-in safety-critical) agent's model. */
  setAgentModel(agentId: string, model: string): AgentConfig | undefined {
    const existing = this.agentConfigs.get(agentId);
    if (!existing) return undefined;
    if (isBuiltInAgent(agentId)) return undefined;
    const updated: AgentConfig = { ...existing, model, updatedAt: new Date().toISOString() };
    this.agentConfigs.set(agentId, updated);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: "agent.updated",
        data: { agentId, name: updated.name, engine: updated.engine, model },
        source: "agent-runtime",
      });
    }
    return updated;
  }

  /** Search prior conversation messages for one coworker. */
  async searchConversations(agentId: string, query: string): Promise<Array<{ conversationId: string; messageId: string; role: string; content: string; timestamp: string }>> {
    const map = this.conversations.get(agentId) ?? new Map<string, ConversationRecord>();
    const needle = query.trim().toLowerCase();
    const hits: Array<{ conversationId: string; messageId: string; role: string; content: string; timestamp: string }> = [];
    if (!needle) return hits;
    for (const record of map.values()) {
      for (let i = 0; i < record.messages.length; i++) {
        const message = record.messages[i];
        const content = (message.content ?? "").toLowerCase();
        if (content.includes(needle)) {
          hits.push({
            conversationId: record.id,
            messageId: `msg-${i}`,
            role: message.role,
            content: message.content ?? "",
            timestamp: record.updatedAt,
          });
        }
      }
    }
    return hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50);
  }

  private ensureDefaultAgents(): void {
    const defaults: AgentConfig[] = [
      {
        id: "btc-quant-agent",
        name: "BTC Quant Agent",
        description: "Specialized BTC technical analyst and momentum trading strategy generator",
        role: "Quantitative Analyst",
        engine: "cline-cli",
        systemPrompt: "You are an expert BTC quantitative analyst agent for Finance Agent OS running via Cline CLI. Analyze prices, compute technical indicators (RSI, MACD, Supertrend), inspect portfolio state, and create structured trade proposals when high-probability setups exist.",
        tools: [
          "get_market_price",
          "get_ohlcv",
          "calculate_rsi",
          "calculate_macd",
          "calculate_supertrend",
          "get_portfolio",
          "create_trade_proposal",
        ],
        permissions: { execution: true },
        riskPermissions: { allowTradeProposals: true, maxOrderSize: 1.0 },
      },
      {
        id: "risk-guardian-agent",
        name: "Risk Guardian Agent",
        description: "Monitors portfolio leverage, drawdown, and validates trade candidates against risk policies",
        role: "Risk & Compliance Guardian",
        engine: "cline-cli",
        systemPrompt: "You are an automated risk guardian agent for Finance Agent OS running via Cline CLI. Monitor portfolio exposure, calculate risk metrics, and verify all trade proposals against hard risk parameters.",
        tools: ["get_portfolio", "get_market_price"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
      },
      {
        id: "cline-cli-agent",
        name: "Cline CLI Agent",
        description: "Local CLI execution engine driver",
        role: "Local CLI Execution Engine",
        engine: "cline-cli",
        systemPrompt: "You are a local CLI agent driver running via Cline CLI execution.",
        tools: ["get_market_price", "get_portfolio"],
        permissions: { execution: false },
      },
      {
        id: "market-research-agent",
        name: "Market Researcher",
        description: "Macro crypto market orderbook depth and sentiment scanner",
        role: "Market Researcher",
        engine: "cline-cli",
        systemPrompt: "You are a macro crypto market researcher running via Cline CLI. Inspect price history, volume trends, and market orderbook depth to deliver clear insights.",
        tools: ["get_market_price", "get_ohlcv"],
        permissions: { execution: false },
      },
      {
        id: "finance-lead-agent",
        name: "Finance Lead",
        description: "Treasury, capital allocation, and portfolio P&L reviewer for the paper-trading desk",
        role: "Finance Lead",
        engine: "cline-cli",
        systemPrompt:
          "You are the Finance Lead for Finance Agent OS, a paper-trading-only desk. " +
          "You own treasury and capital allocation: cash vs deployed capital, concentration, " +
          "NAV and P&L attribution, fees and slippage drag, and whether the portfolio matches " +
          "the user's stated risk budget. Use the finance tools to read the real paper portfolio " +
          "and market prices instead of guessing. Separate measured facts from assumptions, show " +
          "the arithmetic behind every allocation suggestion, and state what data is missing. " +
          "You are advisory only: never submit, approve, or execute an order, and never claim a " +
          "trade or backtest happened unless a tool actually ran it.",
        tools: ["get_portfolio", "get_market_price", "get_ohlcv"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
      },
      {
        id: "financebot-supervisor",
        name: "FinanceBot Supervisor",
        description: "Coordinates the FinanceBot coworker team and routes research, quant and risk work into supervised tasks.",
        role: "Supervisor",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Supervisor for Finance Agent OS. Coordinate the finance coworker team: assign research, quant and risk analysis tasks to the appropriate specialists, synthesize their findings, and produce an end-to-end plan before any paper-trading proposal is created.",
        tools: ["get_market_price", "get_ohlcv", "get_portfolio"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
        avatar: "FS",
        personality: "orchestrating",
        memoryScope: "coworker:supervisor",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-market-researcher",
        name: "Market Researcher",
        description: "Macro researcher scanning markets, price history, volume trends and orderbook depth.",
        role: "Market Researcher",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Market Researcher for Finance Agent OS. Scan markets, price history, volume trends and market orderbook depth via tools, and deliver concise evidence-based insights.",
        tools: ["get_market_price", "get_ohlcv"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
        avatar: "MR",
        personality: "analytical",
        memoryScope: "coworker:market",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-quant-researcher",
        name: "Quant Researcher",
        description: "Quant researcher generating testable strategy hypotheses and trade proposals from technical indicators.",
        role: "Quant Researcher",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Quant Researcher for Finance Agent OS. Analyze price data with technical indicators, inspect portfolio state, and draft structured trade proposals only for high-probability setups.",
        tools: [
          "get_market_price",
          "get_ohlcv",
          "calculate_rsi",
          "calculate_macd",
          "calculate_supertrend",
          "get_portfolio",
          "create_trade_proposal",
        ],
        permissions: { execution: true },
        riskPermissions: { allowTradeProposals: true, maxOrderSize: 1 },
        avatar: "QR",
        personality: "rigorous",
        memoryScope: "coworker:quant",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-risk-guardian",
        name: "Risk Guardian",
        description: "Risk and compliance guardian validating exposure and trade candidates against hard risk limits.",
        role: "Risk Guardian",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Risk Guardian for Finance Agent OS. Monitor portfolio exposure, leverage and drawdown and verify trade candidates against hard risk parameters; verdicts are advisory only.",
        tools: ["get_portfolio", "get_market_price"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
        avatar: "RG",
        personality: "cautious",
        memoryScope: "coworker:risk",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-portfolio-manager",
        name: "Portfolio Manager",
        description: "Portfolio manager tracking balances, positions, NAV and allocation.",
        role: "Portfolio Manager",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Portfolio Manager for Finance Agent OS. Track portfolio balances, positions, NAV and allocation using finance tools; no execution.",
        tools: ["get_portfolio", "get_market_price", "get_ohlcv"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
        avatar: "PM",
        personality: "steady",
        memoryScope: "coworker:portfolio",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-execution-analyst",
        name: "Execution Analyst",
        description: "Execution analyst that drafts small risk-capped execution slices for supervisor review.",
        role: "Execution Analyst",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Execution Analyst for Finance Agent OS. Check market state and portfolio before drafting small execution slices; proposals require stop-loss reasoning and stay capped.",
        tools: ["get_market_price", "get_portfolio", "create_trade_proposal"],
        permissions: { execution: true },
        riskPermissions: { allowTradeProposals: true, maxOrderSize: 0.5 },
        avatar: "EA",
        personality: "cautious",
        memoryScope: "coworker:execution",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
      {
        id: "financebot-macro-economist",
        name: "Macro Economist",
        description: "Macro economist producing scenario and sentiment analysis from market data.",
        role: "Macro Economist",
        engine: "cline-cli",
        systemPrompt:
          "You are the FinanceBot Macro Economist for Finance Agent OS. Produce macro-level market analysis: price history, volume, sentiment and scenarios, using tools for evidence only.",
        tools: ["get_market_price", "get_ohlcv"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
        avatar: "ME",
        personality: "curious",
        memoryScope: "coworker:macro",
        concurrency: { maxConcurrent: 1 },
        status: "active",
      },
    ];

    let updated = false;
    for (const agent of defaults) {
      if (!this.agentConfigs.has(agent.id)) {
        this.agentConfigs.set(agent.id, agent);
        updated = true;
      }
    }
    if (updated) {
      void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    }
  }

  registerAgent(config: AgentConfig): void {
    const now = new Date().toISOString();
    const stored: AgentConfig = {
      ...config,
      createdAt: config.createdAt ?? now,
      updatedAt: now,
    };
    this.agentConfigs.set(stored.id, stored);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: "agent.created",
        data: { agentId: stored.id, name: stored.name, engine: stored.engine },
        source: "agent-runtime",
      });
    }
  }

  /**
   * Full replacement update. Returns false when the agent does not exist.
   * `archived`/`createdAt` are always preserved from the stored record —
   * use setArchived() to (un)archive.
   */
  updateAgent(id: string, config: AgentConfig): boolean {
    const existing = this.agentConfigs.get(id);
    if (!existing) return false;
    const stored: AgentConfig = {
      ...config,
      id,
      archived: existing.archived,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.agentConfigs.set(id, stored);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: "agent.updated",
        data: { agentId: id, name: stored.name, engine: stored.engine },
        source: "agent-runtime",
      });
    }
    return true;
  }

  /**
   * Soft-delete (archive) or restore a bot. Archiving cancels any in-flight
   * run first so no orphaned execution survives. Built-in system agents can
   * never be archived. Returns the stored record, or undefined when the agent
   * does not exist (or is a built-in).
   */
  setArchived(id: string, archived: boolean): AgentConfig | undefined {
    const existing = this.agentConfigs.get(id);
    if (!existing) return undefined;
    if (isBuiltInAgent(id)) return undefined;
    if (archived) this.cancelAgent(id);
    const stored: AgentConfig = {
      ...existing,
      archived: archived ? true : undefined,
      updatedAt: new Date().toISOString(),
    };
    if (!archived) delete stored.archived;
    this.agentConfigs.set(id, stored);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: archived ? "agent.archived" : "agent.unarchived",
        data: { agentId: id, name: stored.name },
        source: "agent-runtime",
      });
    }
    return stored;
  }

  deleteAgent(id: string): boolean {
    // Built-in safety-critical agents cannot be silently deleted.
    if (isBuiltInAgent(id)) return false;
    this.cancelAgent(id);
    const deleted = this.agentConfigs.delete(id);
    if (deleted) {
      void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    }
    return deleted;
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agentConfigs.get(id);
  }

  /** Derived lifecycle status: archived | busy | idle | active. */
  getStatus(id: string): AgentStatus {
    const agent = this.agentConfigs.get(id);
    if (!agent) return "idle";
    if (agent.archived) return "archived";
    if (this.activeRuns.has(id)) return "busy";
    return agent.status === "idle" ? "idle" : "active";
  }

  /** Clone a coworker (custom or built-in) into a fresh editable copy. */
  duplicateAgent(id: string): AgentConfig | undefined {
    const source = this.agentConfigs.get(id);
    if (!source) return undefined;
    let newId = `${id}-copy`;
    let suffix = 2;
    while (this.agentConfigs.has(newId)) newId = `${id}-copy-${suffix++}`;
    const now = new Date().toISOString();
    const copy: AgentConfig = {
      ...source,
      id: newId,
      name: `${source.name} (Copy)`,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.agentConfigs.set(newId, copy);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: "agent.created",
        data: { agentId: newId, name: copy.name, engine: copy.engine },
        source: "agent-runtime",
      });
    }
    return copy;
  }

  /** Cancel a single agent's in-flight run (aborts its tool loop). */
  cancelAgent(id: string): void {
    this.activeRuns.get(id)?.abort();
    this.activeRuns.delete(id);
  }

  /** Cancel every agent except `exceptId`. Attached agents stay
   * connected but perform no further actions. */
  cancelOthers(exceptId: string): void {
    for (const [id, ctrl] of this.activeRuns) {
      if (id !== exceptId) {
        try { ctrl.abort(); } catch { /* ignore */ }
        this.activeRuns.delete(id);
      }
    }
  }

  cancelAll(): void {
    for (const [, ctrl] of this.activeRuns) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    this.activeRuns.clear();
  }

  isActive(id: string): boolean {
    return this.activeRuns.has(id);
  }

  listAgents(opts?: { includeArchived?: boolean }): AgentConfig[] {
    const all = Array.from(this.agentConfigs.values());
    if (opts?.includeArchived) return all;
    return all.filter((a) => !a.archived);
  }

  async loadConversationHistory(agentId: string): Promise<LLMMessage[]> {
    return this.persistence.loadConversation(agentId);
  }
  async saveConversationHistory(agentId: string, conversationId: string, messages: LLMMessage[]): Promise<void> {
    return this.persistence.saveConversation(agentId, conversationId, messages);
  }

  async *runAgentStream(
    agentIdOrConfig: string | AgentConfig,
    userPrompt: string,
    history: LLMMessage[] = [],
    opts?: { signal?: AbortSignal; conversationId?: string },
  ): AsyncIterable<LLMEvent> {
    let config: AgentConfig;
    let agentId: string;
    if (typeof agentIdOrConfig === "string") {
      agentId = agentIdOrConfig;
      const existing = this.agentConfigs.get(agentId);
      if (existing) {
        config = existing;
      } else {
        let fallbackEngine = "cline-cli";
        if (agentId.includes("ollama")) fallbackEngine = "ollama-local";
        else if (agentId.includes("gpt") || agentId.includes("openai")) fallbackEngine = "openai-gpt4";
        else if (agentId.includes("claude") || agentId.includes("openrouter")) fallbackEngine = "openrouter-claude";

        config = {
          id: agentId,
          name: agentId,
          engine: fallbackEngine,
          systemPrompt: "You are a Finance Agent assistant.",
        };
      }
    } else {
      config = agentIdOrConfig;
      agentId = config.id;
    }

    const conversationId = opts?.conversationId ?? agentId;

    // Exclusive execution: messaging one agent stops tool-calling/tasks
    // of all other agents. The previous runs observe the abort and stop
    // before their next LLM turn or tool call.
    this.cancelOthers(agentId);
    const runCtrl = new AbortController();
    this.activeRuns.set(agentId, runCtrl);
    const externalSignal = opts?.signal;
    const isAborted = () => runCtrl.signal.aborted || externalSignal?.aborted === true;
    if (externalSignal?.aborted) {
      this.activeRuns.delete(agentId);
      return;
    }
    const onExternalAbort = () => runCtrl.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    // Phase 4 routing: the coworker's configured provider first, then any
    // configured fallbacks. Resolution failures are reported per target so a
    // stale connection cannot abort the run.
    const plan = await buildRoutePlan(config, this.engineManager);
    const routed = await resolveAttempts(plan, this.engineManager);
    for (const failure of routed.errors) {
      if (this.bus) {
        this.bus.publish({
          type: "agent.provider_unavailable",
          data: { agentId: config.id, providerId: failure.providerId, error: failure.error },
          source: "agent-runtime",
        });
      }
    }
    const attempts = routed.attempts;
    const allToolDefs = this.toolRegistry.getDefinitions(config.tools);

    const historyMessages: LLMMessage[] =
      opts?.conversationId !== undefined ? await this.getConversation(agentId, conversationId) : history;
    const messages: LLMMessage[] = [];
    if (config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }
    messages.push(...historyMessages);
    messages.push({ role: "user", content: userPrompt });

    let iterations = 0;
    const maxIterations = 5;
    let lastAssistant: LLMMessage | null = null;

    try {
    while (iterations < maxIterations) {
      if (isAborted()) break;
      iterations++;
      let currentMessageId = `msg-${Date.now()}`;
      let completeText = "";
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }> = [];

      try {
        const stream = streamWithFallback(attempts, {
          signal: runCtrl.signal,
          botId: config.id,
          timeoutMs: plan.timeoutMs ?? 120_000,
          request: (model, activeProvider) => ({
            model,
            messages,
            tools: activeProvider.supportsTools() && allToolDefs.length > 0 ? allToolDefs : undefined,
          }),
          onAttemptError: (providerId, error) => {
            if (this.bus) {
              this.bus.publish({
                type: "agent.provider_fallback",
                data: { agentId: config.id, providerId, error, next: attempts.length > 1 },
                source: "agent-runtime",
              });
            }
          },
        });

        for await (const event of stream) {
          if (event.type === "message_start") {
            currentMessageId = event.messageId;
          } else if (event.type === "text_delta") {
            completeText += event.delta;
          } else if (event.type === "tool_call") {
            pendingToolCalls.push({
              id: event.toolCallId,
              name: event.name,
              arguments: event.arguments,
            });
          }

          // Publish to event bus if provided
          if (this.bus) {
            this.bus.publish({
              type: `agent.llm_event.${event.type}`,
              data: { agentId: config.id, event },
              source: "agent-runtime",
            });
          }

          yield event;
        }

        // Push assistant response to history
        lastAssistant = {
          role: "assistant",
          content: completeText,
          toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        };
        messages.push(lastAssistant);

        // If no tool calls requested, multi-turn loop is finished
        if (pendingToolCalls.length === 0) {
          break;
        }

        // Execute requested tool calls in parallel using Promise.all
        // Skip entirely if a newer agent run preempted this one.
        if (isAborted()) break;
        const toolExecutionResults = await Promise.all(
          pendingToolCalls.map(async (call) => {
            if (isAborted()) {
              return {
                call,
                result: { status: "CANCELLED", reason: "Superseded by a newer agent run" },
                isError: true,
                toolResultEvent: {
                  type: "tool_result",
                  messageId: currentMessageId,
                  toolCallId: call.id,
                  name: call.name,
                  result: { status: "CANCELLED" },
                  isError: true,
                  timestamp: Date.now(),
                } as LLMEvent,
              };
            }
            let result: unknown;
            let isError = false;

            try {
              // Check tool permission (e.g. execution permission / trade-proposal gating for trade proposals)
              if (
                call.name === "create_trade_proposal" &&
                (config.permissions?.execution === false ||
                  config.riskPermissions?.allowTradeProposals === false)
              ) {
                isError = true;
                result = {
                  status: "REJECTED",
                  decision: "REJECTED",
                  reason:
                    config.permissions?.execution === false
                      ? "Agent execution permission is disabled (Execution = OFF in agent configuration)"
                      : "Agent is not permitted to create trade proposals (riskPermissions.allowTradeProposals = false)",
                };
              } else {
                result = await this.toolRegistry.executeTool(call.name, call.arguments);
              }
            } catch (err) {
              isError = true;
              result = { error: err instanceof Error ? err.message : String(err) };
            }

            const toolResultEvent: LLMEvent = {
              type: "tool_result",
              messageId: currentMessageId,
              toolCallId: call.id,
              name: call.name,
              result,
              isError,
              timestamp: Date.now(),
            };

            return { call, result, isError, toolResultEvent };
          }),
        );

        for (const { call, result, isError, toolResultEvent } of toolExecutionResults) {
          if (this.bus) {
            this.bus.publish({
              type: "agent.llm_event.tool_result",
              data: { agentId: config.id, toolCallId: call.id, tool: call.name, result, isError },
              source: "agent-runtime",
            });
          }

          yield toolResultEvent;

          // Push tool result back into message history for LLM next turn
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: typeof result === "string" ? result : JSON.stringify(result),
          });
        }
      } catch (err) {
        yield {
          type: "error",
          messageId: currentMessageId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        break;
      }
    }

      // Persist conversation history (user + assistant) for this conversation.
      const userMessage: LLMMessage = { role: "user", content: userPrompt };
      const conversationMessages: LLMMessage[] = [...historyMessages, userMessage];
      if (lastAssistant) conversationMessages.push(lastAssistant);
      await this.saveConversation(agentId, conversationId, conversationMessages);
    } finally {
      if (this.activeRuns.get(agentId) === runCtrl) {
        this.activeRuns.delete(agentId);
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    // Conversation history persistence is handled via saveConversation above.
  }
}

