import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";
import { Storage } from "../core/storage.js";
import type { Thread, Message } from "../core/storage.js";
import { DEFAULT_BOTS } from "./bots.js";
import { BotRegistry } from "./bots.js";
import type { BotConfig, ChatCoreOptions, SendResult, SubmitTaskFn } from "./types.js";

// ---------------------------------------------------------------------------
// Optional LLM replies.
// Runtime must pass `getLlm` lazily (avoids a runtime.ts cycle).
// ChatCoreOptions gains:
//   getLlm?: () => Pick<import("../llm/llm-service.js").LlmService, "complete" | "isConfigured"> | undefined
// BotConfig.llm (parallel-owned) is accessed via BotWithOptionalLlm cast so
// this file compiles whether or not `BotConfig` declares `llm`.
// ---------------------------------------------------------------------------

import type { LlmConfig } from "../llm/types.js";

type LlmServiceLike = Pick<
  import("../llm/llm-service.js").LlmService,
  "complete" | "isConfigured"
>;

type ChatCoreOptionsWithLlm = ChatCoreOptions & {
  getLlm?: () => LlmServiceLike | undefined;
};

type BotWithOptionalLlm = BotConfig & {
  llm?: LlmConfig;
};

const MIRRORED_TYPES = new Set<string>([
  "supervisor.plan_created",
  "supervisor.plan_completed",
  "supervisor.plan_failed",
  "quant.signal",
  "risk.approved",
  "risk.rejected",
  "order.filled",
  "execution.pipeline_completed",
  "execution.pipeline_rejected",
  "trade.proposal_created",
  "trade.proposal_approved",
  "trade.proposal_rejected",
  "trade.proposal_expired",
  "risk.held",
]);

import { asRecord, asString, asArray } from "../utils/validation-helpers.js";
import { asNumberString as asNumber } from "../utils/validation-helpers.js";

function deriveAgentId(event: FinanceEvent): string {
  if (typeof event.agentId === "string" && event.agentId.length > 0) {
    return event.agentId;
  }
  const prefix = event.type.split(".")[0] ?? "";
  // Order events are produced by the execution path.
  if (prefix === "order") return "execution";
  return prefix || "system";
}

function summarize(event: FinanceEvent): string {
  const d = asRecord(event.data);
  switch (event.type) {
    case "supervisor.plan_created": {
      const kind = asString(d["kind"], "plan");
      const symbol = asString(d["symbol"], "?");
      const steps = asArray(d["steps"]);
      return `📋 Plan ${kind} on ${symbol} — ${steps.length} steps.`;
    }
    case "supervisor.plan_completed": {
      const success = d["success"];
      const task = asString(d["task"], asString(d["planId"], "unknown"));
      if (success === false) {
        const failedSteps = asArray(d["failedSteps"]).map((s) => String(s));
        return `❌ Plan failed: ${task} — ${failedSteps.join(", ")}`;
      }
      const stepCount = asNumber(d["stepCount"], "?");
      const durationMs = asNumber(d["durationMs"], "?");
      return `✅ Plan done: ${task} (${stepCount} steps, ${durationMs}ms).`;
    }
    case "supervisor.plan_failed": {
      const task = asString(d["task"], asString(d["planId"], "unknown"));
      const failedSteps = asArray(d["failedSteps"]).map((s) => String(s));
      return `❌ Plan failed: ${task} — ${failedSteps.join(", ")}`;
    }
    case "quant.signal": {
      const action = asString(d["action"], "?");
      const symbol = asString(d["symbol"], "?");
      const price = asNumber(d["price"], "?");
      const confidence = asNumber(d["confidence"], "?");
      const reason = asString(d["reason"], "");
      return `🔔 ${action.toUpperCase()} ${symbol} @ ${price} (conf ${confidence}) — ${reason}`;
    }
    case "risk.approved": {
      const signal = asRecord(d["signal"]);
      const label = asString(d["reason"], asString(signal["symbol"], "?"));
      return `🛡️ Approved: ${label}`;
    }
    case "risk.rejected": {
      const reason = asString(d["reason"], "no reason given");
      return `🛡️ Blocked: ${reason}`;
    }
    case "order.filled": {
      const side = asString(d["side"], "?");
      const qty =
        d["qty"] !== undefined && d["qty"] !== null ? String(d["qty"]) : asString(d["quantity"], "?");
      const symbol = asString(d["symbol"], "?");
      const price =
        d["price"] !== undefined && d["price"] !== null
          ? String(d["price"])
          : asString(d["filledPrice"], "?");
      return `⚡ Filled ${side} ${qty} ${symbol} @ ${price}`;
    }
    case "execution.pipeline_completed": {
      const signalId = asString(d["signalId"], "?");
      return `⚡ Trade completed (${signalId})`;
    }
    case "execution.pipeline_rejected": {
      const reason = asString(d["reason"], "no reason given");
      return `⛔ Trade rejected: ${reason}`;
    }
    case "trade.proposal_created": {
      const p = asRecord(d["proposal"]);
      const side = asString(p["side"], "?");
      const quantity = asNumber(p["quantity"], "?");
      const symbol = asString(p["symbol"], "?");
      const price = asNumber(p["price"], "?");
      const reason = asString(p["reason"], "");
      const id = asString(p["id"], "?");
      return `✋ Approval needed: ${side} ${quantity} ${symbol} @ ${price} — ${reason} [${id}]`;
    }
    case "trade.proposal_approved": {
      const proposal = asRecord(d["proposal"]);
      const proposalId = asString(d["proposalId"], asString(proposal["id"], "?"));
      const side = asString(d["side"], asString(proposal["side"], "?"));
      const quantity =
        d["quantity"] !== undefined && d["quantity"] !== null
          ? String(d["quantity"])
          : asString(proposal["quantity"], "?");
      const symbol = asString(d["symbol"], asString(proposal["symbol"], "?"));
      return `👍 Approved ${side} ${quantity} ${symbol} [${proposalId}]`;
    }
    case "trade.proposal_rejected": {
      const proposalId = asString(d["proposalId"], asString(asRecord(d["proposal"])["id"], "?"));
      const reason = asString(d["reason"], "no reason given");
      return `👎 Rejected [${proposalId}]: ${reason}`;
    }
    case "trade.proposal_expired": {
      const proposalId = asString(d["proposalId"], asString(asRecord(d["proposal"])["id"], "?"));
      return `⌛ Proposal expired [${proposalId}]`;
    }
    case "risk.held": {
      const signal = asRecord(d["signal"]);
      const src = signal["symbol"] !== undefined || signal["side"] !== undefined || signal["action"] !== undefined ? signal : d;
      const symbol = asString(src["symbol"], "?");
      const action = asString(src["action"], asString(src["side"], "?"));
      return `⏸️ Held for approval: ${symbol} ${action}`;
    }
    default:
      return `${event.type}`;
  }
}

export class ChatCore {
  private readonly bus: TypedEventBus;
  private readonly storage: Storage;
  private readonly submitTask?: SubmitTaskFn;
  private readonly getLlm?: () => LlmServiceLike | undefined;
  private readonly registry: BotRegistry;
  private readonly planThreads = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(opts: ChatCoreOptionsWithLlm) {
    this.bus = opts.bus;
    this.storage = opts.storage ?? new Storage();
    this.submitTask = opts.submitTask;
    this.getLlm = opts.getLlm;
    this.registry = new BotRegistry(DEFAULT_BOTS);
  }

  get bots(): BotRegistry {
    return this.registry;
  }

  async createThread(input: { title?: string; channelId?: string; botId?: string }): Promise<Thread> {
    const now = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const thread: Thread = {
      id: `thread-${now}-${random}`,
      channelId: input.channelId ?? "general",
      title: input.title ?? "New conversation",
      createdAt: now,
      metadata: input.botId !== undefined ? { botId: input.botId } : undefined,
    };
    await this.storage.saveThread(thread);
    return thread;
  }

  async getThreads(channelId?: string): Promise<Thread[]> {
    return this.storage.getThreads(channelId);
  }

  async getMessages(threadId: string, limit = 100): Promise<Message[]> {
    return this.storage.getMessages({ threadId, limit });
  }

  async sendUserMessage(
    threadId: string,
    content: string,
    opts?: { agentId?: string },
  ): Promise<SendResult> {
    const thread = await this.storage.getThread(threadId);
    if (thread === null || thread === undefined) {
      throw new Error("thread not found");
    }

    const message: Message = {
      id: `msg-${Date.now()}-u`,
      threadId,
      channelId: thread.channelId,
      role: "user",
      content,
      timestamp: Date.now(),
      agentId: opts?.agentId ?? "user",
    };
    await this.storage.saveMessage(message);

    // Exclusive targeting: if this thread is bound to one specific bot
    // (DM), only that agent acts. Never fan out to the supervisor pipeline
    // or other agents from a DM thread (supervisor DMs still coordinate).
    const threadBotIdRaw = thread.metadata?.["botId"];
    const threadBot =
      typeof threadBotIdRaw === "string" && threadBotIdRaw.length > 0
        ? (this.bots.get(threadBotIdRaw) as BotWithOptionalLlm | undefined)
        : undefined;
    const isExclusiveDm =
      threadBot !== undefined && threadBot.agentId !== "supervisor";

    let planId: string | null = null;
    if (this.submitTask) {
      try {
        const res = await this.submitTask(content, threadId);
        const rec = asRecord(res);
        const extracted = rec["planId"] ?? asRecord(rec["plan"])["id"];
        planId = typeof extracted === "string" && extracted.length > 0 ? extracted : null;
      } catch {
        planId = null;
      }
    }

    // Always publish so the supervisor can pick the task up itself —
    // except from exclusive DM threads, where only the addressed agent acts.
    if (!isExclusiveDm) {
      this.bus.publish({
        type: "supervisor.task",
        data: { task: content, correlationId: threadId },
        source: "chat",
        threadId,
        agentId: "user",
      });
    }

    if (planId !== null) {
      this.planThreads.set(planId, threadId);
    }

    // Optional LLM reply. Never throws and never changes the SendResult shape.
    // Runtime wiring passes `getLlm` lazily (see note at top of file).
    try {
      const botIdRaw = thread.metadata?.["botId"];
      if (typeof botIdRaw === "string" && botIdRaw.length > 0) {
        const bot = this.bots.get(botIdRaw) as BotWithOptionalLlm | undefined;
        const llmCfg = bot?.llm;
        if (bot !== undefined && llmCfg !== undefined) {
          const service = this.getLlm?.();
          if (service !== undefined && service.isConfigured(llmCfg)) {
            const recent = await this.storage.getMessages({ threadId, limit: 5 });
            const context = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
            const prompt =
              `You are ${bot.name} (${bot.personality ?? "a finance agent"}). ` +
              `User asked: "${content}". Plan ${planId ?? "unknown"} finished. ` +
              `Recent context:\n${context}`;
            const reply = await service.complete(llmCfg, prompt, { botId: botIdRaw });
            if (typeof reply === "string" && reply.length > 0) {
              await this.storage.saveMessage({
                id: `msg-${Date.now()}-llm`,
                threadId,
                channelId: thread.channelId,
                role: "assistant",
                content: reply,
                timestamp: Date.now(),
                agentId: bot.agentId,
              });
            }
          }
        }
      }
    } catch {
      // Keep existing behavior on ANY LLM error.
    }
    return { message, planId };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      void this.handleEvent(event);
    });
  }

  stop(): void {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        // ignore unsubscribe errors
      }
      this.unsubscribe = null;
    }
    this.started = false;
  }

  private async handleEvent(event: FinanceEvent): Promise<void> {
    try {
      if (!MIRRORED_TYPES.has(event.type)) return;
      const data = asRecord(event.data);

      // Track planId -> thread mapping on plan creation.
      if (event.type === "supervisor.plan_created") {
        const planId = data["planId"];
        if (typeof planId === "string" && planId.length > 0) {
          if (typeof event.correlationId === "string" && event.correlationId.length > 0) {
            const corrThread = await this.storage.getThread(event.correlationId);
            if (corrThread !== null && corrThread !== undefined) {
              this.planThreads.set(planId, corrThread.id);
            }
          }
        }
      }

      let thread: Thread | undefined | null = null;
      if (typeof event.threadId === "string" && event.threadId.length > 0) {
        thread = await this.storage.getThread(event.threadId);
      }
      if (thread === null || thread === undefined) {
        const byCorrelation =
          typeof event.correlationId === "string"
            ? this.planThreads.get(event.correlationId)
            : undefined;
        const planIdFromData =
          typeof data["planId"] === "string" ? (data["planId"] as string) : undefined;
        const byPlan = planIdFromData !== undefined ? this.planThreads.get(planIdFromData) : undefined;
        const resolvedId = byCorrelation ?? byPlan;
        if (resolvedId !== undefined) {
          thread = await this.storage.getThread(resolvedId);
        }
      }
      if (thread === null || thread === undefined) return;

      const assistant: Message = {
        id: `msg-${event.id}`,
        threadId: thread.id,
        channelId: thread.channelId,
        role: "assistant",
        content: summarize(event),
        timestamp: Date.now(),
        agentId: deriveAgentId(event),
        data: event.data,
      };
      await this.storage.appendMessage(assistant);
    } catch {
      // Never throw out of the event handler.
    }
  }
}

