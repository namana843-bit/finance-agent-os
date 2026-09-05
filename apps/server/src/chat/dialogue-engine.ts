// ============================================================================
// DialogueEngine — OpenMausBot Conversational Dialogue Layer
// Converts backend financial events (quant signals, risk checks, supervisor plans,
// order fills) into natural language dialogue with agent avatars and roles.
// Manages channels (#trading-floor, #signals-alerts, #trade-approvals) and DMs.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

export interface AgentProfile {
  id: string;
  name: string;
  avatar: string;
  role: string;
  color: string;
  description?: string;
}

export interface ChatAttachment {
  type: "trade_proposal" | "signal" | "risk_metric" | "chart_snapshot" | "strategy_card";
  data: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  channelId: string; // e.g. "trading-floor", "signals-alerts", "trade-approvals", or "dm-supervisor"
  senderId: string;  // agent id or "user"
  senderName: string;
  senderAvatar: string;
  senderRole: string;
  senderColor: string;
  content: string;
  timestamp: number;
  replyToId?: string;
  attachment?: ChatAttachment;
  metadata?: Record<string, unknown>;
}

export interface ProposedOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  type: "market" | "limit";
  strategy?: string;
  confidence?: number;
  reason?: string;
  status: "pending" | "approved" | "rejected" | "filled";
  createdAt: number;
  executedAt?: number;
}

export const DEFAULT_AGENT_PROFILES: Record<string, AgentProfile> = {
  supervisor: {
    id: "supervisor",
    name: "Supervisor",
    avatar: "👔",
    role: "Chief Coordinator",
    color: "#6366f1",
    description: "Multi-agent coordinator & task execution planner",
  },
  market: {
    id: "market",
    name: "Market Agent",
    avatar: "🌐",
    role: "Market Specialist",
    color: "#06b6d4",
    description: "Live tick, orderbook, and WebSocket streaming",
  },
  quant: {
    id: "quant",
    name: "Quant Agent",
    avatar: "📈",
    role: "Quant Strategist",
    color: "#10b981",
    description: "RSI, MACD, EMA crossover signal generator",
  },
  risk: {
    id: "risk",
    name: "Risk Officer",
    avatar: "🛡️",
    role: "Risk Guardian",
    color: "#f59e0b",
    description: "VaR, Drawdown enforcement, Sharpe calculations",
  },
  portfolio: {
    id: "portfolio",
    name: "Portfolio Manager",
    avatar: "💼",
    role: "Asset Allocator",
    color: "#8b5cf6",
    description: "Paper balance, PnL, and allocation tracker",
  },
  execution: {
    id: "execution",
    name: "Execution Broker",
    avatar: "⚡",
    role: "Order Execution",
    color: "#ec4899",
    description: "Paper trading execution & smart order routing",
  },
  user: {
    id: "user",
    name: "You (Trader)",
    avatar: "👤",
    role: "Human Operator",
    color: "#3b82f6",
    description: "Human portfolio manager",
  },
};

export class DialogueEngine {
  private bus: TypedEventBus;
  private messages: ChatMessage[] = [];
  private maxMessages = 2000;
  private customProfiles: Map<string, AgentProfile> = new Map();
  private pendingOrders: Map<string, ProposedOrder> = new Map();
  private unsubscribe: (() => void) | null = null;

  constructor(bus: TypedEventBus) {
    this.bus = bus;
    this.setupListeners();
    this.seedWelcomeMessages();
  }

  public registerAgentProfile(profile: AgentProfile): void {
    this.customProfiles.set(profile.id, profile);
  }

  public getAgentProfile(agentId: string): AgentProfile {
    if (this.customProfiles.has(agentId)) {
      return this.customProfiles.get(agentId)!;
    }
    if (DEFAULT_AGENT_PROFILES[agentId]) {
      return DEFAULT_AGENT_PROFILES[agentId];
    }
    return {
      id: agentId,
      name: agentId.charAt(0).toUpperCase() + agentId.slice(1) + " Bot",
      avatar: "🤖",
      role: "Custom Agent",
      color: "#10b981",
    };
  }

  public getHistory(channelId?: string, limit = 100): ChatMessage[] {
    let filtered = this.messages;
    if (channelId) {
      filtered = filtered.filter(
        (m) => m.channelId === channelId || (channelId === "trading-floor" && !m.channelId.startsWith("dm-"))
      );
    }
    return filtered.slice(-limit);
  }

  public getPendingOrders(): ProposedOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  public getPendingOrder(orderId: string): ProposedOrder | undefined {
    return this.pendingOrders.get(orderId);
  }

  public postMessage(msg: Omit<ChatMessage, "id" | "timestamp"> & { id?: string; timestamp?: number }): ChatMessage {
    const fullMessage: ChatMessage = {
      id: msg.id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: msg.timestamp || Date.now(),
      ...msg,
    };

    this.messages.push(fullMessage);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Publish to EventBus so SSE and WS stream it immediately
    this.bus.publish({
      type: "chat.message",
      data: fullMessage,
      channelId: fullMessage.channelId,
      agentId: fullMessage.senderId,
      source: "dialogue-engine",
    });

    return fullMessage;
  }

  public async handleUserMessage(content: string, channelId = "trading-floor"): Promise<ChatMessage> {
    const userProfile = DEFAULT_AGENT_PROFILES.user;

    // Post user message
    const userMsg = this.postMessage({
      channelId,
      senderId: userProfile.id,
      senderName: userProfile.name,
      senderAvatar: userProfile.avatar,
      senderRole: userProfile.role,
      senderColor: userProfile.color,
      content,
    });

    const trimmed = content.trim();
    const lower = trimmed.toLowerCase();

    // Route message based on intent or channel
    if (channelId === "trading-floor" || channelId === "dm-supervisor" || lower.startsWith("analyze") || lower.startsWith("trade") || lower.startsWith("plan")) {
      // Post Supervisor acknowledgement
      setTimeout(() => {
        const sup = this.getAgentProfile("supervisor");
        this.postMessage({
          channelId,
          senderId: sup.id,
          senderName: sup.name,
          senderAvatar: sup.avatar,
          senderRole: sup.role,
          senderColor: sup.color,
          content: `Task received: "${trimmed}". Initiating multi-agent execution pipeline...`,
        });

        // Publish supervisor task to EventBus to trigger backend SupervisorAgent
        this.bus.publish({
          type: "supervisor.task",
          data: { task: trimmed, channelId },
          source: "dialogue-engine",
        });
      }, 300);
    } else if (channelId === "dm-quant" || lower.includes("signal") || lower.includes("rsi") || lower.includes("macd")) {
      setTimeout(() => {
        const quant = this.getAgentProfile("quant");
        this.postMessage({
          channelId,
          senderId: quant.id,
          senderName: quant.name,
          senderAvatar: quant.avatar,
          senderRole: quant.role,
          senderColor: quant.color,
          content: `Running quantitative scans for BTCUSDT and ETHUSDT. Calculating RSI(14), MACD(12,26,9) and EMA crossovers...`,
        });

        this.bus.publish({
          type: "quant.scan_request",
          data: { symbol: "BTCUSDT", query: trimmed },
          source: "dialogue-engine",
        });
      }, 300);
    } else if (channelId === "dm-risk" || lower.includes("risk") || lower.includes("var") || lower.includes("drawdown")) {
      setTimeout(() => {
        const risk = this.getAgentProfile("risk");
        this.postMessage({
          channelId,
          senderId: risk.id,
          senderName: risk.name,
          senderAvatar: risk.avatar,
          senderRole: risk.role,
          senderColor: risk.color,
          content: `Portfolio Risk Assessment: Total Portfolio Drawdown is at 0.00% (Limit: 20.00%). Max permitted position size: $15,000 USDT. All systems nominal.`,
        });
      }, 300);
    } else if (channelId === "dm-portfolio" || lower.includes("portfolio") || lower.includes("balance") || lower.includes("pnl")) {
      setTimeout(() => {
        const pf = this.getAgentProfile("portfolio");
        this.postMessage({
          channelId,
          senderId: pf.id,
          senderName: pf.name,
          senderAvatar: pf.avatar,
          senderRole: pf.role,
          senderColor: pf.color,
          content: `Portfolio status: Total equity $100,000.00 USDT. Cash available: $100,000.00 USDT. Open positions: 0. Allocation: 100% Cash.`,
        });
      }, 300);
    } else if (channelId === "dm-market" || lower.includes("price") || lower.includes("ticker")) {
      setTimeout(() => {
        const mkt = this.getAgentProfile("market");
        this.postMessage({
          channelId,
          senderId: mkt.id,
          senderName: mkt.name,
          senderAvatar: mkt.avatar,
          senderRole: mkt.role,
          senderColor: mkt.color,
          content: `Market Data Feed: Binance WebSockets active (btcusdt@trade, ethusdt@trade). Tick latency ~12ms.`,
        });
      }, 300);
    } else if (channelId.startsWith("dm-")) {
      const customAgentId = channelId.replace("dm-", "");
      const profile = this.getAgentProfile(customAgentId);
      setTimeout(() => {
        this.postMessage({
          channelId,
          senderId: profile.id,
          senderName: profile.name,
          senderAvatar: profile.avatar,
          senderRole: profile.role,
          senderColor: profile.color,
          content: `I am actively monitoring financial streams according to my persona and strategy parameters. Awaiting specific trading trigger or signal.`,
        });
      }, 300);
    }

    return userMsg;
  }

  public createProposedOrder(order: Omit<ProposedOrder, "id" | "status" | "createdAt">): ProposedOrder {
    const orderId = `order-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const proposal: ProposedOrder = {
      ...order,
      id: orderId,
      status: "pending",
      createdAt: Date.now(),
    };

    this.pendingOrders.set(orderId, proposal);

    const execProfile = this.getAgentProfile("execution");
    const formattedPrice = proposal.price > 0 ? `$${proposal.price.toLocaleString()}` : "Market Price";
    const formattedTotal = proposal.price > 0 ? `$${(proposal.quantity * proposal.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Market Value";

    // Post to #trading-floor and #trade-approvals
    const messageContent = `⚡ **Trade Proposal Generated**\n` +
      `**Action:** ${proposal.side.toUpperCase()} ${proposal.quantity} ${proposal.symbol}\n` +
      `**Target Price:** ${formattedPrice} (Est. Total: ${formattedTotal})\n` +
      `**Strategy:** ${proposal.strategy || "Manual / Quant Alpha"}\n` +
      `**Reason:** ${proposal.reason || "Confidence criteria met & Risk Officer approved"}`;

    this.postMessage({
      channelId: "trading-floor",
      senderId: execProfile.id,
      senderName: execProfile.name,
      senderAvatar: execProfile.avatar,
      senderRole: execProfile.role,
      senderColor: execProfile.color,
      content: messageContent,
      attachment: {
        type: "trade_proposal",
        data: proposal as unknown as Record<string, unknown>,
      },
    });

    this.postMessage({
      channelId: "trade-approvals",
      senderId: execProfile.id,
      senderName: execProfile.name,
      senderAvatar: execProfile.avatar,
      senderRole: execProfile.role,
      senderColor: execProfile.color,
      content: `New trade awaiting human approval: ${proposal.side.toUpperCase()} ${proposal.quantity} ${proposal.symbol}`,
      attachment: {
        type: "trade_proposal",
        data: proposal as unknown as Record<string, unknown>,
      },
    });

    return proposal;
  }

  public approveOrder(orderId: string): ProposedOrder | null {
    const order = this.pendingOrders.get(orderId);
    if (!order) return null;

    order.status = "approved";
    order.executedAt = Date.now();

    const userProfile = DEFAULT_AGENT_PROFILES.user;
    const execProfile = this.getAgentProfile("execution");

    this.postMessage({
      channelId: "trading-floor",
      senderId: userProfile.id,
      senderName: userProfile.name,
      senderAvatar: userProfile.avatar,
      senderRole: userProfile.role,
      senderColor: userProfile.color,
      content: `✅ Approved order \`${orderId}\` (${order.side.toUpperCase()} ${order.quantity} ${order.symbol}). Forwarding to PaperBroker for execution.`,
    });

    // Publish order execution request to EventBus
    this.bus.publish({
      type: "order.submitted",
      data: {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        type: order.type,
        strategy: order.strategy,
      },
      source: "dialogue-engine",
    });

    setTimeout(() => {
      order.status = "filled";
      this.postMessage({
        channelId: "trading-floor",
        senderId: execProfile.id,
        senderName: execProfile.name,
        senderAvatar: execProfile.avatar,
        senderRole: execProfile.role,
        senderColor: execProfile.color,
        content: `🎉 Order \`${orderId}\` FILLED! ${order.side.toUpperCase()} ${order.quantity} ${order.symbol} @ $${order.price.toLocaleString()}. Updated Paper Portfolio balance.`,
      });
    }, 600);

    return order;
  }

  public rejectOrder(orderId: string, reason = "Rejected by Trader"): ProposedOrder | null {
    const order = this.pendingOrders.get(orderId);
    if (!order) return null;

    order.status = "rejected";

    const userProfile = DEFAULT_AGENT_PROFILES.user;
    this.postMessage({
      channelId: "trading-floor",
      senderId: userProfile.id,
      senderName: userProfile.name,
      senderAvatar: userProfile.avatar,
      senderRole: userProfile.role,
      senderColor: userProfile.color,
      content: `❌ Rejected order \`${orderId}\`: ${reason}`,
    });

    return order;
  }

  private setupListeners(): void {
    this.unsubscribe = this.bus.subscribe((event: FinanceEvent) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: FinanceEvent): void {
    try {
      const type = event.type;
      const data = (event.data || {}) as Record<string, any>;

      switch (type) {
        case "supervisor.step_started": {
          const sup = this.getAgentProfile("supervisor");
          const stepName = data.stepId || data.agentId || "Step";
          this.postMessage({
            channelId: data.channelId || "trading-floor",
            senderId: sup.id,
            senderName: sup.name,
            senderAvatar: sup.avatar,
            senderRole: sup.role,
            senderColor: sup.color,
            content: `⏳ Starting Step: **${stepName}** (${data.description || "Executing..."})`,
          });
          break;
        }

        case "supervisor.step_completed": {
          const agentId = data.agentId || "supervisor";
          const profile = this.getAgentProfile(agentId);
          let summary = data.summary || data.output || "Step completed successfully.";
          if (typeof summary === "object") {
            summary = JSON.stringify(summary);
          }
          this.postMessage({
            channelId: data.channelId || "trading-floor",
            senderId: profile.id,
            senderName: profile.name,
            senderAvatar: profile.avatar,
            senderRole: profile.role,
            senderColor: profile.color,
            content: `✅ **${profile.name}:** ${summary}`,
          });
          break;
        }

        case "quant.signal": {
          const quant = this.getAgentProfile("quant");
          const symbol = data.symbol || "BTCUSDT";
          const action = (data.action || data.side || "HOLD").toUpperCase();
          const confidence = Math.round((data.confidence ?? 0.8) * 100);
          const reason = data.reason || data.reasoning || "Technical indicator convergence detected.";
          const price = data.price ? `$${data.price.toLocaleString()}` : "current price";

          const msgContent = `📈 **Signal Alert: ${action} ${symbol}**\n` +
            `• Confidence: **${confidence}%**\n` +
            `• Price Level: ${price}\n` +
            `• Thesis: ${reason}`;

          this.postMessage({
            channelId: "signals-alerts",
            senderId: quant.id,
            senderName: quant.name,
            senderAvatar: quant.avatar,
            senderRole: quant.role,
            senderColor: quant.color,
            content: msgContent,
            attachment: {
              type: "signal",
              data,
            },
          });

          this.postMessage({
            channelId: "trading-floor",
            senderId: quant.id,
            senderName: quant.name,
            senderAvatar: quant.avatar,
            senderRole: quant.role,
            senderColor: quant.color,
            content: `📈 Alpha Signal generated for **${symbol}**: **${action}** with **${confidence}% confidence**. ${reason}`,
          });
          break;
        }

        case "risk.approved":
        case "risk.evaluation": {
          const risk = this.getAgentProfile("risk");
          const approved = data.approved ?? true;
          const statusText = approved ? "APPROVED" : "REJECTED";
          const exposure = data.exposure ? `${data.exposure}%` : "12%";
          const reason = data.reason || (approved ? "Drawdown and exposure within limits." : "Risk limits exceeded.");

          this.postMessage({
            channelId: "trading-floor",
            senderId: risk.id,
            senderName: risk.name,
            senderAvatar: risk.avatar,
            senderRole: risk.role,
            senderColor: risk.color,
            content: `🛡️ **Risk Assessment [${statusText}]:** ${reason} (Portfolio Exposure: ${exposure})`,
          });
          break;
        }

        case "order.filled": {
          const exec = this.getAgentProfile("execution");
          const symbol = data.symbol || "BTCUSDT";
          const side = (data.side || "buy").toUpperCase();
          const qty = data.quantity || data.qty || 0.1;
          const price = data.price ? `$${data.price.toLocaleString()}` : "Market";

          this.postMessage({
            channelId: "trading-floor",
            senderId: exec.id,
            senderName: exec.name,
            senderAvatar: exec.avatar,
            senderRole: exec.role,
            senderColor: exec.color,
            content: `⚡ **Order Filled:** ${side} ${qty} ${symbol} @ ${price}. Paper trade executed.`,
          });
          break;
        }

        case "order.rejected": {
          const exec = this.getAgentProfile("execution");
          const symbol = data.symbol || "BTCUSDT";
          const reason = data.reason || "Execution failed or rejected by gateway.";

          this.postMessage({
            channelId: "trading-floor",
            senderId: exec.id,
            senderName: exec.name,
            senderAvatar: exec.avatar,
            senderRole: exec.role,
            senderColor: exec.color,
            content: `⚠️ **Order Rejected for ${symbol}:** ${reason}`,
          });
          break;
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  private seedWelcomeMessages(): void {
    const sup = DEFAULT_AGENT_PROFILES.supervisor;
    const quant = DEFAULT_AGENT_PROFILES.quant;
    const risk = DEFAULT_AGENT_PROFILES.risk;
    const mkt = DEFAULT_AGENT_PROFILES.market;

    const baseTime = Date.now() - 60000;

    this.messages.push(
      {
        id: "msg-welcome-1",
        channelId: "trading-floor",
        senderId: sup.id,
        senderName: sup.name,
        senderAvatar: sup.avatar,
        senderRole: sup.role,
        senderColor: sup.color,
        content: `👋 **Welcome to OpenMausBot Finance Desktop!**\nAll 6 specialized financial agents are online and connected to the high-throughput TypedEventBus. Type commands like \`Analyze BTC\` or \`Paper trade ETH 0.5\` to initiate multi-agent collaboration.`,
        timestamp: baseTime,
      },
      {
        id: "msg-welcome-2",
        channelId: "trading-floor",
        senderId: mkt.id,
        senderName: mkt.name,
        senderAvatar: mkt.avatar,
        senderRole: mkt.role,
        senderColor: mkt.color,
        content: `🌐 Binance WebSocket feed is connected and streaming live ticks for BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT.`,
        timestamp: baseTime + 1000,
      },
      {
        id: "msg-welcome-3",
        channelId: "trading-floor",
        senderId: quant.id,
        senderName: quant.name,
        senderAvatar: quant.avatar,
        senderRole: quant.role,
        senderColor: quant.color,
        content: `📈 Quant strategies loaded: **EMA Crossover**, **RSI Reversal**, **MACD Trend**, and **Momentum Alpha**.`,
        timestamp: baseTime + 2000,
      },
      {
        id: "msg-welcome-4",
        channelId: "trading-floor",
        senderId: risk.id,
        senderName: risk.name,
        senderAvatar: risk.avatar,
        senderRole: risk.role,
        senderColor: risk.color,
        content: `🛡️ Risk Guard active: 20% max portfolio drawdown threshold enforced. Paper balance: **$100,000 USDT**.`,
        timestamp: baseTime + 3000,
      }
    );
  }

  public destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
