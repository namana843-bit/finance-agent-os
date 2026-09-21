import type { BotConfig } from "./types.js";

declare module "./types.js" {
  interface BotConfig {
    llm?: import("../llm/types.js").LlmConfig;
  }
}

export const DEFAULT_BOTS: BotConfig[] = [
  {
    id: "chief",
    name: "Chief",
    avatar: "🎯",
    personality:
      "Trading-desk chief of staff that plans and routes. Breaks goals into steps and delegates to the right specialist.",
    agentId: "supervisor",
    account: "paper",
    llm: {
      provider: "cli",
      command: "opencode",
      args: ["run", "--auto", "{prompt}"],
    },
  },
  {
    id: "market",
    name: "Market",
    avatar: "📈",
    personality:
      "Market data specialist that watches ticks, candles and order flow. Summarizes what the market is doing right now.",
    agentId: "market",
    account: "paper",
  },
  {
    id: "quant",
    name: "Quant",
    avatar: "🧠",
    personality:
      "Quantitative strategist that analyzes price action and emits BUY/SELL/HOLD signals with confidence and reasoning.",
    agentId: "quant",
    account: "paper",
  },
  {
    id: "risk",
    name: "Risk",
    avatar: "🛡️",
    personality:
      "Risk guardian that enforces limits and position sizing. Approves safe trades and blocks anything that breaches policy.",
    agentId: "risk",
    account: "paper",
  },
  {
    id: "portfolio",
    name: "Portfolio",
    avatar: "💼",
    personality:
      "Portfolio manager that tracks positions, allocation and performance. Keeps the book balanced toward its targets.",
    agentId: "portfolio",
    account: "paper",
  },
  {
    id: "execution",
    name: "Execution",
    avatar: "⚡",
    personality:
      "Execution specialist that routes approved orders to the broker and reports fills with speed and precision.",
    agentId: "execution",
    account: "paper",
  },
];

export class BotRegistry {
  private readonly bots: BotConfig[];

  constructor(bots?: BotConfig[]) {
    this.bots = bots ?? [...DEFAULT_BOTS];
  }

  list(): BotConfig[] {
    return [...this.bots];
  }

  get(id: string): BotConfig | undefined {
    return this.bots.find((b) => b.id === id);
  }

  getByAgentId(agentId: string): BotConfig | undefined {
    return this.bots.find((b) => b.agentId === agentId);
  }

  updateBot(id: string, patch: { model?: string }): BotConfig | undefined {
    const bot = this.get(id);
    if (bot === undefined) return undefined;
    if (patch.model !== undefined && bot.llm !== undefined) {
      bot.llm.model = patch.model;
    }
    return bot;
  }

  updateEngine(id: string, llm: import("../llm/types.js").LlmConfig | undefined): BotConfig | undefined {
    const bot = this.get(id);
    if (bot === undefined) return undefined;
    if (llm === undefined) {
      delete bot.llm;
    } else {
      bot.llm = llm;
    }
    return bot;
  }
}
