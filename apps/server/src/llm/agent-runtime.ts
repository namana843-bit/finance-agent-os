import type { TypedEventBus } from "@finance/core";
import type {
  LLMEvent,
  LLMMessage,
} from "@finance/shared";
import type { FinanceToolRegistry } from "./finance-tool-registry.js";
import { AgentPersistence } from "./persistence.js";
import type { EngineManager } from "./registry.js";

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
    }
    this.ensureDefaultAgents();
  }

  private ensureDefaultAgents(): void {
    const defaults: AgentConfig[] = [
      {
        id: "btc-quant-agent",
        name: "BTC Quant Agent",
        description: "Specialized BTC technical analyst and momentum trading strategy generator",
        role: "Quantitative Analyst",
        engine: "opencode-cli",
        model: "opencode",
        systemPrompt: "You are an expert BTC quantitative analyst agent for Finance Agent OS running via OpenCode CLI. Analyze prices, compute technical indicators (RSI, MACD, Supertrend), inspect portfolio state, and create structured trade proposals when high-probability setups exist.",
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
        engine: "opencode-cli",
        model: "opencode",
        systemPrompt: "You are an automated risk guardian agent for Finance Agent OS running via OpenCode CLI. Monitor portfolio exposure, calculate risk metrics, and verify all trade proposals against hard risk parameters.",
        tools: ["get_portfolio", "get_market_price"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: false },
      },
      {
        id: "opencode-cli-agent",
        name: "OpenCode CLI Agent",
        description: "Local CLI execution engine driver",
        role: "Local CLI Execution Engine",
        engine: "opencode-cli",
        model: "opencode",
        systemPrompt: "You are a local CLI agent driver running via OpenCode CLI execution.",
        tools: ["get_market_price", "get_portfolio"],
        permissions: { execution: false },
      },
      {
        id: "market-research-agent",
        name: "Market Researcher",
        description: "Macro crypto market orderbook depth and sentiment scanner",
        role: "Market Researcher",
        engine: "opencode-cli",
        model: "opencode",
        systemPrompt: "You are a macro crypto market researcher running via OpenCode CLI. Inspect price history, volume trends, and market orderbook depth to deliver clear insights.",
        tools: ["get_market_price", "get_ohlcv"],
        permissions: { execution: false },
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
    this.agentConfigs.set(config.id, config);
    void this.persistence.saveAgents(Array.from(this.agentConfigs.values()));
    if (this.bus) {
      this.bus.publish({
        type: "agent.created",
        data: { agentId: config.id, name: config.name, engine: config.engine },
        source: "agent-runtime",
      });
    }
  }

  deleteAgent(id: string): boolean {
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

  listAgents(): AgentConfig[] {
    return Array.from(this.agentConfigs.values());
  }

  async loadConversationHistory(agentId: string): Promise<LLMMessage[]> {
    return this.persistence.loadConversation(agentId);
  }

  async saveConversationHistory(agentId: string, messages: LLMMessage[]): Promise<void> {
    return this.persistence.saveConversation(agentId, messages);
  }

  async *runAgentStream(
    agentIdOrConfig: string | AgentConfig,
    userPrompt: string,
    history: LLMMessage[] = [],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<LLMEvent> {
    let config: AgentConfig;
    if (typeof agentIdOrConfig === "string") {
      const existing = this.agentConfigs.get(agentIdOrConfig);
      if (existing) {
        config = existing;
      } else {
        let fallbackEngine = "opencode-cli";
        if (agentIdOrConfig.includes("ollama")) fallbackEngine = "ollama-local";
        else if (agentIdOrConfig.includes("gpt") || agentIdOrConfig.includes("openai")) fallbackEngine = "openai-gpt4";
        else if (agentIdOrConfig.includes("claude") || agentIdOrConfig.includes("openrouter")) fallbackEngine = "openrouter-claude";

        config = {
          id: agentIdOrConfig,
          name: agentIdOrConfig,
          engine: fallbackEngine,
          systemPrompt: "You are a Finance Agent assistant.",
        };
      }
    } else {
      config = agentIdOrConfig;
    }

    // Exclusive execution: messaging one agent stops tool-calling/tasks
    // of all other agents. The previous runs observe the abort and stop
    // before their next LLM turn or tool call.
    this.cancelOthers(config.id);
    const runCtrl = new AbortController();
    this.activeRuns.set(config.id, runCtrl);
    const externalSignal = opts?.signal;
    const isAborted = () => runCtrl.signal.aborted || externalSignal?.aborted === true;
    if (externalSignal?.aborted) {
      this.activeRuns.delete(config.id);
      return;
    }
    const onExternalAbort = () => runCtrl.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const { provider, model: defaultModel } = this.engineManager.getProviderForEngine(config.engine);
    const selectedModel = config.model || defaultModel;

    const toolDefs = provider.supportsTools()
      ? this.toolRegistry.getDefinitions(config.tools)
      : [];

    const messages: LLMMessage[] = [];
    if (config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }
    messages.push(...history);
    messages.push({ role: "user", content: userPrompt });

    let iterations = 0;
    const maxIterations = 5;

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
        const stream = provider.chat(
          {
            model: selectedModel,
            messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
          },
          { ...opts, botId: config.id },
        );

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
        messages.push({
          role: "assistant",
          content: completeText,
          toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        });

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
              // Check tool permission (e.g. execution permission for trade proposal)
              if (
                call.name === "create_trade_proposal" &&
                config.permissions?.execution === false
              ) {
                isError = true;
                result = {
                  status: "REJECTED",
                  decision: "REJECTED",
                  reason: "Agent execution permission is disabled (Execution = OFF in agent configuration)",
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
    } finally {
      if (this.activeRuns.get(config.id) === runCtrl) {
        this.activeRuns.delete(config.id);
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    // Automatically persist conversation after streaming completes
    void this.saveConversationHistory(config.id, messages.filter((m) => m.role !== "system"));
  }
}
