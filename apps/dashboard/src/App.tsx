import React, { useState, useEffect, useRef } from "react";
import {
  Activity,
  ArrowUp,
  BarChart2,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  Command,
  Copy,
  Cpu,
  DollarSign,
  Ellipsis,
  FileCode,
  Layers,
  Maximize2,
  Mic,
  Monitor,
  Paperclip,
  Phone,
  PieChart,
  Pin,
  Plus,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Smile,
  Sparkles,
  Terminal,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";
import { API_BASE, type ChatMessage } from "./lib/api";

export interface TradingAgent {
  id: string;
  name: string;
  role: string;
  model: string;
  provider: "claude" | "codex" | "grok";
  lastMessage: string;
  lastTime: string;
  unread?: number;
  status: "working" | "idle" | "offline";
  pinned?: boolean;
  avatarColor: string;
  badge: string;
}

export interface MultiAgentMessage {
  id: string;
  agentId?: string;
  agentName?: string;
  agentBadge?: string;
  agentColor?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  tools?: Array<{ id: string; name: string; status: "done" | "running" | "failed" }>;
  code?: { lang: string; code: string };
  approval?: { id: string; type: "trade" | "risk" | "order"; title: string; content: string };
  reactions?: string[];
}

const TRADING_AGENTS: TradingAgent[] = [
  {
    id: "alpha-quant",
    name: "AlphaQuant",
    role: "Quantitative & Strategy Lead",
    model: "Claude Opus 4.5",
    provider: "claude",
    lastMessage: "RSI Mean-Reversion model signal generated for BTC/USDT...",
    lastTime: "1m",
    unread: 2,
    status: "working",
    pinned: true,
    avatarColor: "from-blue-600 to-indigo-700",
    badge: "QUANT",
  },
  {
    id: "risk-sentinel",
    name: "RiskSentinel",
    role: "Risk & Compliance Guardian",
    model: "Claude Sonnet 4",
    provider: "claude",
    lastMessage: "Portfolio VaR within 1.8% threshold. Max drawdown safe.",
    lastTime: "3m",
    status: "working",
    pinned: true,
    avatarColor: "from-amber-600 to-rose-700",
    badge: "RISK",
  },
  {
    id: "exec-router",
    name: "ExecRouter",
    role: "Smart Execution & Routing",
    model: "GPT-5 Codex",
    provider: "codex",
    lastMessage: "TWAP order batch routed across Binance & Bybit liquidity pools.",
    lastTime: "8m",
    status: "idle",
    avatarColor: "from-emerald-600 to-teal-800",
    badge: "EXEC",
  },
  {
    id: "market-intel",
    name: "MarketIntel",
    role: "Order Book & Market Microstructure",
    model: "Grok 4",
    provider: "grok",
    lastMessage: "Orderbook depth anomaly detected at $68,200 support wall.",
    lastTime: "14m",
    status: "idle",
    avatarColor: "from-purple-600 to-violet-800",
    badge: "INTEL",
  },
  {
    id: "portfolio-lead",
    name: "PortfolioLead",
    role: "Portfolio Orchestrator & Allocator",
    model: "Claude Sonnet 4",
    provider: "claude",
    lastMessage: "Current Net Asset Value: $184,250.00 (+4.82% today).",
    lastTime: "25m",
    status: "idle",
    avatarColor: "from-amber-500 to-yellow-600",
    badge: "PORTFOLIO",
  },
];

const MULTI_AGENT_ROOMS = [
  {
    id: "room-trading-floor",
    name: "Live Trading Floor",
    description: "Multi-agent autonomous market debate & execution pipeline",
    activeAgents: ["AlphaQuant", "RiskSentinel", "ExecRouter", "MarketIntel"],
  },
  {
    id: "room-alpha-lab",
    name: "Alpha Strategy Lab",
    description: "Backtesting quantitative alphas and statistical arbitrage",
    activeAgents: ["AlphaQuant", "MarketIntel"],
  },
  {
    id: "room-risk-committee",
    name: "Risk & Margin Committee",
    description: "Real-time collateral audits and liquidation prevention",
    activeAgents: ["RiskSentinel", "PortfolioLead"],
  },
];

const INITIAL_CONVERSATIONS: Record<string, MultiAgentMessage[]> = {
  "room-trading-floor": [
    {
      id: "tf-1",
      agentId: "market-intel",
      agentName: "MarketIntel",
      agentBadge: "INTEL",
      agentColor: "from-purple-600 to-violet-800",
      role: "assistant",
      content: "🚨 **Market Alert:** Order book imbalance detected on BTC/USDT. Heavy bid absorption of 420 BTC at $68,150. CVD (Cumulative Volume Delta) shifting sharply bullish.",
      timestamp: "10:41 AM",
      tools: [
        { id: "t1", name: "Scan Binance Depth 500ms", status: "done" },
        { id: "t2", name: "Calculate Order Flow Delta", status: "done" },
      ],
    },
    {
      id: "tf-2",
      agentId: "alpha-quant",
      agentName: "AlphaQuant",
      agentBadge: "QUANT",
      agentColor: "from-blue-600 to-indigo-700",
      role: "assistant",
      content: "Confirmed @MarketIntel. My multi-factor RSI-Momentum model has triggered a **BUY Signal**.\n\n- **Target Entry:** $68,220.00\n- **Take Profit (TP):** $69,450.00 (+1.80%)\n- **Stop Loss (SL):** $67,650.00 (-0.83%)\n- **Calculated Sharpe Ratio:** 2.45\n\nPassing trade candidate to @RiskSentinel for margin and VaR compliance check.",
      timestamp: "10:42 AM",
      code: {
        lang: "json",
        code: `{\n  "signal": "BUY_LONG",\n  "symbol": "BTC/USDT",\n  "leverage": 3,\n  "targetEntry": 68220.0,\n  "stopLoss": 67650.0,\n  "takeProfit": 69450.0,\n  "riskReward": 2.16\n}`,
      },
    },
    {
      id: "tf-3",
      agentId: "risk-sentinel",
      agentName: "RiskSentinel",
      agentBadge: "RISK",
      agentColor: "from-amber-600 to-rose-700",
      role: "assistant",
      content: "🛡️ **Risk Audit Passed.**\n\n- **Current Portfolio Exposure:** 42.5% (Max allowed: 65%)\n- **Projected Drawdown at SL:** 0.41% of total portfolio equity\n- **Stress Test Scenario (Flash Crash -5%):** Safe, liquidation buffer is 34.2%\n\n@ExecRouter you are authorized to construct a 1.25 BTC TWAP order ticket.",
      timestamp: "10:42 AM",
      tools: [
        { id: "t3", name: "Run VaR Simulation (99% conf)", status: "done" },
        { id: "t4", name: "Check Maximum Drawdown Cap", status: "done" },
      ],
    },
    {
      id: "tf-4",
      agentId: "exec-router",
      agentName: "ExecRouter",
      agentBadge: "EXEC",
      agentColor: "from-emerald-600 to-teal-800",
      role: "assistant",
      content: "Order route prepared across primary liquidity bridges. Awaiting manual execution confirmation or autonomous policy pass.",
      timestamp: "10:43 AM",
      approval: {
        id: "app-trade-1",
        type: "trade",
        title: "Execute Long Position: 1.25 BTC/USDT @ $68,220",
        content: "Route: 60% Binance Depth / 40% Bybit • Est. Slippage: 0.012% • Required Margin: $28,425.00 USDT",
      },
      reactions: ["🔥", "🚀"],
    },
  ],
  "alpha-quant": [
    {
      id: "aq-1",
      role: "user",
      content: "What is your highest conviction quantitative setup right now?",
      timestamp: "10:30 AM",
    },
    {
      id: "aq-2",
      agentId: "alpha-quant",
      agentName: "AlphaQuant",
      agentBadge: "QUANT",
      agentColor: "from-blue-600 to-indigo-700",
      role: "assistant",
      content: "Currently monitoring **ETH/USDT 4H Mean Reversion**.\n\nBollinger Band width is at a 30-day low (0.042) indicating extreme volatility compression. @MarketIntel is seeing whale bids stacked at $3,520, and @RiskSentinel has approved a 5% allocation.",
      timestamp: "10:31 AM",
      tools: [
        { id: "t1", name: "Fetch 4H Historical OHLCV", status: "done" },
        { id: "t2", name: "Compute Bollinger Band Squeeze Index", status: "done" },
      ],
      code: {
        lang: "python",
        code: `# Alpha Quant Strategy: Bollinger Squeeze Breakout
def evaluate_entry(df):
    bandwidth = (df['upper_bb'] - df['lower_bb']) / df['middle_bb']
    if bandwidth.iloc[-1] < 0.05 and df['volume_zscore'].iloc[-1] > 2.0:
        return {"action": "ENTER_LONG", "stop": df['lower_bb'].iloc[-1]}
    return {"action": "WAIT"}`,
      },
      reactions: ["💡", "📈"],
    },
  ],
  "risk-sentinel": [
    {
      id: "rs-1",
      role: "user",
      content: "Show me our current risk exposure and stress test results.",
      timestamp: "09:50 AM",
    },
    {
      id: "rs-2",
      agentId: "risk-sentinel",
      agentName: "RiskSentinel",
      agentBadge: "RISK",
      agentColor: "from-amber-600 to-rose-700",
      role: "assistant",
      content: "Here is the real-time risk profile for all open positions:\n\n- **Total Portfolio Value:** $184,250.00\n- **Total Gross Exposure:** $78,300.00 (42.5%)\n- **Daily 99% Value-at-Risk (VaR):** $3,120.00 (1.69%)\n- **Max Drawdown (Month-to-Date):** 1.42%\n- **Status:** 🟢 **OPTIMAL & SAFE**\n\nAll stop-losses are strictly synced with @ExecRouter.",
      timestamp: "09:51 AM",
      tools: [
        { id: "t1", name: "Audit Open Exchange Positions", status: "done" },
        { id: "t2", name: "Calculate Monte Carlo Drawdowns", status: "done" },
      ],
    },
  ],
  "exec-router": [
    {
      id: "er-1",
      role: "user",
      content: "Check exchange API latency and current routing slippage.",
      timestamp: "08:15 AM",
    },
    {
      id: "er-2",
      agentId: "exec-router",
      agentName: "ExecRouter",
      agentBadge: "EXEC",
      agentColor: "from-emerald-600 to-teal-800",
      role: "assistant",
      content: "Execution routing performance:\n\n- **Binance WebSocket Latency:** 14ms\n- **Bybit WebSocket Latency:** 18ms\n- **Average Slippage Today:** 0.008%\n- **Active TWAP Batches:** 0 active (ready for orders)",
      timestamp: "08:16 AM",
    },
  ],
  "market-intel": [
    {
      id: "mi-1",
      role: "user",
      content: "Scan top 10 cryptos for volume divergence.",
      timestamp: "07:30 AM",
    },
    {
      id: "mi-2",
      agentId: "market-intel",
      agentName: "MarketIntel",
      agentBadge: "INTEL",
      agentColor: "from-purple-600 to-violet-800",
      role: "assistant",
      content: "Top volume divergence findings:\n\n1. **SOL/USDT (+8.4% Volume Spike)** — Institutional sweep on $148 support.\n2. **AVAX/USDT (+6.1% Spike)** — Aggressive spot buying vs perp funding neutral.\n3. **BTC/USDT** — Consistent whale accumulation between $68,000 and $68,300.",
      timestamp: "07:31 AM",
      reactions: ["👍", "🔥"],
    },
  ],
  "portfolio-lead": [
    {
      id: "pl-1",
      role: "user",
      content: "Summarize today's performance and asset allocation.",
      timestamp: "07:00 AM",
    },
    {
      id: "pl-2",
      agentId: "portfolio-lead",
      agentName: "PortfolioLead",
      agentBadge: "PORTFOLIO",
      agentColor: "from-amber-500 to-yellow-600",
      role: "assistant",
      content: "Good morning! Here is the portfolio overview:\n\n- **Total Portfolio:** $184,250.00\n- **Daily PnL:** +$8,420.00 (+4.78%)\n- **Holdings:** 55% BTC, 25% ETH, 10% SOL, 10% Cash USDT\n- **Multi-Agent Health:** All 5 trading agents active and synchronized.",
      timestamp: "07:01 AM",
    },
  ],
};

function AgentAvatar({
  name,
  badge,
  avatarColor,
  size = 32,
  status,
}: {
  name: string;
  badge?: string;
  avatarColor?: string;
  size?: number;
  status?: "working" | "idle" | "offline";
}) {
  const color = avatarColor || "from-blue-600 to-indigo-700";
  const initial = name ? name[0].toUpperCase() : "A";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className={`w-full h-full rounded-[10px] bg-gradient-to-br ${color} border border-white/20 flex items-center justify-center shadow-sm font-bold text-white tracking-wider`}
        style={{ fontSize: size * 0.4 }}
      >
        {initial}
      </div>
      {status && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-[9px] h-[9px] rounded-full border-[1.5px] border-[#111] ${
            status === "working"
              ? "bg-emerald-400 animate-pulse"
              : status === "idle"
              ? "bg-zinc-400"
              : "bg-zinc-700"
          }`}
        />
      )}
    </div>
  );
}

export function App() {
  const [agents, setAgents] = useState<TradingAgent[]>(TRADING_AGENTS);
  const [activeChatId, setActiveChatId] = useState<string>("room-trading-floor");
  const [conversations, setConversations] = useState<Record<string, MultiAgentMessage[]>>(INITIAL_CONVERSATIONS);
  const [inputVal, setInputVal] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isComputerOpen, setIsComputerOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isTasksDropdownOpen, setIsTasksDropdownOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; agentId: string } | null>(null);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // New agent modal
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("Statistical Arbitrage Engine");
  const [newAgentModel, setNewAgentModel] = useState("Claude Opus 4.5 • Quant rail");
  const [newAgentPrompt, setNewAgentPrompt] = useState("");

  const activeAgent = agents.find((a) => a.id === activeChatId);
  const activeRoom = MULTI_AGENT_ROOMS.find((r) => r.id === activeChatId);
  const isRoom = !!activeRoom;

  const currentTitle = isRoom ? activeRoom.name : activeAgent?.name || "Finance Agent";
  const currentRole = isRoom ? activeRoom.description : activeAgent?.role || "Trading Agent";

  const activeMessages = conversations[activeChatId] || [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeMessages, isTyping]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [inputVal]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsCommandOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setIsCommandOpen(false);
        setContextMenu(null);
        setIsModelDropdownOpen(false);
        setIsTasksDropdownOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredAgents = agents.filter((a) =>
    searchQuery
      ? a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.role.toLowerCase().includes(searchQuery.toLowerCase())
      : true
  );
  const pinnedAgents = filteredAgents.filter((a) => a.pinned);
  const unpinnedAgents = filteredAgents.filter((a) => !a.pinned);

  // Send message & trigger multi-agent inter-communication
  const handleSend = () => {
    if (!inputVal.trim()) return;

    const userMsg: MultiAgentMessage = {
      id: Date.now().toString(),
      role: "user",
      content: inputVal.trim(),
      timestamp: "now",
    };

    setConversations((prev) => ({
      ...prev,
      [activeChatId]: [...(prev[activeChatId] || []), userMsg],
    }));
    setInputVal("");
    setIsTyping(true);

    if (isRoom) {
      // Step 1: AlphaQuant responds with strategy breakdown
      setTimeout(() => {
        const quantMsg: MultiAgentMessage = {
          id: (Date.now() + 1).toString(),
          agentId: "alpha-quant",
          agentName: "AlphaQuant",
          agentBadge: "QUANT",
          agentColor: "from-blue-600 to-indigo-700",
          role: "assistant",
          content: `Analyzing trade thesis: "${userMsg.content.slice(0, 60)}".\n\nI've calculated the optimal entry price and mean-reversion probability (84.2%). Passing parameters to @RiskSentinel for portfolio limit approval.`,
          timestamp: "now",
          tools: [
            { id: "t1", name: "Calculate Volatility Surface", status: "done" },
            { id: "t2", name: "Estimate Expected Return", status: "done" },
          ],
        };

        setConversations((prev) => ({
          ...prev,
          [activeChatId]: [...(prev[activeChatId] || []), quantMsg],
        }));

        // Step 2: RiskSentinel audits margin and gives clearance
        setTimeout(() => {
          const riskMsg: MultiAgentMessage = {
            id: (Date.now() + 2).toString(),
            agentId: "risk-sentinel",
            agentName: "RiskSentinel",
            agentBadge: "RISK",
            agentColor: "from-amber-600 to-rose-700",
            role: "assistant",
            content: `🛡️ **Risk Clearance:** Position size is approved within 2.0% maximum risk budget.\n\n@ExecRouter please route order across lowest latency liquidity books.`,
            timestamp: "now",
            tools: [{ id: "t3", name: "Verify Margin Coverage & Liquidation Distance", status: "done" }],
          };

          setConversations((prev) => ({
            ...prev,
            [activeChatId]: [...(prev[activeChatId] || []), riskMsg],
          }));

          // Step 3: ExecRouter presents live trade execution ticket
          setTimeout(() => {
            const execMsg: MultiAgentMessage = {
              id: (Date.now() + 3).toString(),
              agentId: "exec-router",
              agentName: "ExecRouter",
              agentBadge: "EXEC",
              agentColor: "from-emerald-600 to-teal-800",
              role: "assistant",
              content: "Order route constructed. Confirm execution ticket below:",
              timestamp: "now",
              approval: {
                id: "app-" + Date.now(),
                type: "trade",
                title: "Execute Order Ticket: 1.0 BTC/USDT",
                content: "TWAP Strategy • 4 Slices over 120s • Est. Slippage: 0.009% • Exchange: Binance/Bybit Bridge",
              },
            };

            setConversations((prev) => ({
              ...prev,
              [activeChatId]: [...(prev[activeChatId] || []), execMsg],
            }));
            setIsTyping(false);
          }, 1000);
        }, 900);
      }, 800);
    } else {
      // 1-on-1 Chat with specific trading agent
      setTimeout(() => {
        const agentResp: MultiAgentMessage = {
          id: (Date.now() + 1).toString(),
          agentId: activeAgent?.id,
          agentName: activeAgent?.name,
          agentBadge: activeAgent?.badge,
          agentColor: activeAgent?.avatarColor,
          role: "assistant",
          content: `Received query. Processing with ${activeAgent?.name} quantitative engine.\n\nCoordinates synced with peer agents @AlphaQuant & @RiskSentinel. All live telemetry within target bounds.`,
          timestamp: "now",
          tools: [
            { id: "t1", name: `Query ${activeAgent?.name} Engine`, status: "done" },
            { id: "t2", name: "Synchronize Agent State", status: "done" },
          ],
        };

        setConversations((prev) => ({
          ...prev,
          [activeChatId]: [...(prev[activeChatId] || []), agentResp],
        }));
        setIsTyping(false);
      }, 900);
    }
  };

  const handleCopyCode = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleCreateAgent = () => {
    if (!newAgentName.trim()) return;
    const newAgent: TradingAgent = {
      id: newAgentName.toLowerCase().replace(/\s+/g, "-"),
      name: newAgentName,
      role: newAgentRole,
      model: newAgentModel.split(" • ")[0],
      provider: newAgentModel.includes("Claude") ? "claude" : newAgentModel.includes("Codex") ? "codex" : "grok",
      lastMessage: "Finance Agent ready for strategy formulation.",
      lastTime: "just now",
      status: "idle",
      avatarColor: "from-cyan-600 to-blue-700",
      badge: "AGENT",
    };
    setAgents((prev) => [...prev, newAgent]);
    setActiveChatId(newAgent.id);
    setIsCreateModalOpen(false);
    setNewAgentName("");
    setNewAgentPrompt("");
  };

  const handleAddReaction = (msgId: string, emoji: string) => {
    setConversations((prev) => {
      const msgs = (prev[activeChatId] || []).map((m) => {
        if (m.id === msgId) {
          const current = m.reactions || [];
          return {
            ...m,
            reactions: current.includes(emoji) ? current : [...current, emoji],
          };
        }
        return m;
      });
      return { ...prev, [activeChatId]: msgs };
    });
  };

  return (
    <div className="h-screen w-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col overflow-hidden select-none antialiased font-sans">
      {/* 1. Header / Window Top Bar */}
      <div className="h-[32px] shrink-0 flex items-center px-3 bg-[#111111] border-b border-[#222] relative z-20">
        <div className="flex items-center gap-[8px]">
          <span className="w-[12px] h-[12px] rounded-full bg-[#ff5f57] border border-[#e0443e] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)]" />
          <span className="w-[12px] h-[12px] rounded-full bg-[#ffbd2e] border border-[#d9a01f] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)]" />
          <span className="w-[12px] h-[12px] rounded-full bg-[#28ca42] border border-[#1aa22f] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)]" />
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 text-[12.5px] font-[600] tracking-[-0.01em] text-[#a1a1a1]">
          <div className="w-4 h-4 rounded-[4px] bg-gradient-to-br from-emerald-400 to-blue-500 flex items-center justify-center">
            <Activity className="w-3 h-3 text-black font-bold" />
          </div>
          Finance Agent OS — Autonomous Trading Platform
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-[#666] bg-[#1a1a1a] border border-[#222] rounded-md px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Fastify Engine :4132 • Live
          </div>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 min-h-0 relative">
        {/* 2. Sidebar Navigation */}
        <aside
          className={`
          w-[320px] shrink-0 bg-[#111111] border-r border-[#222] flex flex-col z-10
          md:relative fixed inset-y-0 left-0 top-[32px] md:top-0 h-[calc(100vh-32px)] md:h-auto
          transition-transform duration-200 ease-out
          ${isMobileNavOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
        >
          {/* Search & New Agent Button */}
          <div className="p-3 flex items-center gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#666]" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search Finance Agents"
                className="w-full h-8 pl-8 pr-14 bg-[#1a1a1a] border border-[#222] rounded-[10px] text-[13px] placeholder:text-[#666] focus:outline-none focus:border-[#333] focus:bg-[#1e1e1e] transition-colors"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] bg-[#222] border border-[#2a2a2a] rounded-[5px] px-1.5 py-0.5 text-[#888] flex items-center gap-0.5">
                <Command className="w-3 h-3" />K
              </span>
            </div>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="w-8 h-8 rounded-[10px] bg-white text-black flex items-center justify-center hover:bg-zinc-200 transition-colors"
              title="Create New Finance Agent"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Navigation Items List */}
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-5">
            {/* Multi-Agent Trading Rooms */}
            <div>
              <div className="flex items-center gap-1.5 px-2 mb-1.5">
                <Users className="w-3 h-3 text-[#666]" />
                <span className="text-[11px] font-semibold tracking-widest uppercase text-[#666]">
                  Multi-Agent Rooms
                </span>
              </div>
              <div className="space-y-0.5">
                {MULTI_AGENT_ROOMS.map((room) => (
                  <div
                    key={room.id}
                    onClick={() => {
                      setActiveChatId(room.id);
                      setIsMobileNavOpen(false);
                    }}
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] cursor-pointer transition-colors ${
                      activeChatId === room.id
                        ? "bg-[#1e1e1e] border border-[#2a2a2a]"
                        : "hover:bg-[#1a1a1a] text-[#aaa] hover:text-[#fff]"
                    }`}
                  >
                    <div className="flex -space-x-1.5">
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 border border-[#111]" />
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-600 to-rose-700 border border-[#111]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-tight truncate">{room.name}</div>
                      <div className="text-[11px] text-[#666] truncate">{room.activeAgents.join(", ")}</div>
                    </div>
                    <span className="text-[10px] bg-[#222] border border-[#333] px-1.5 py-0.5 rounded-full text-emerald-400 font-mono">
                      LIVE
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Pinned Trading Agents */}
            {pinnedAgents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 mb-1.5">
                  <Pin className="w-3 h-3 text-[#666]" />
                  <span className="text-[11px] font-semibold tracking-widest uppercase text-[#666]">
                    Pinned Trading Agents
                  </span>
                </div>
                <div className="space-y-0.5">
                  {pinnedAgents.map((agent) => (
                    <div
                      key={agent.id}
                      onClick={() => {
                        setActiveChatId(agent.id);
                        setIsMobileNavOpen(false);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, agentId: agent.id });
                      }}
                      className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-[12px] cursor-pointer transition-colors ${
                        activeChatId === agent.id
                          ? "bg-[#1e1e1e] border border-[#2a2a2a]"
                          : "border border-transparent hover:bg-[#1a1a1a] hover:border-[#1e1e1e]"
                      }`}
                    >
                      <AgentAvatar
                        name={agent.name}
                        badge={agent.badge}
                        avatarColor={agent.avatarColor}
                        size={28}
                        status={agent.status}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="text-[13px] font-[500] truncate leading-tight">{agent.name}</span>
                          <span className="text-[9px] px-1 py-0 rounded bg-[#222] border border-[#333] text-[#888] font-mono">
                            {agent.badge}
                          </span>
                          {agent.unread ? (
                            <span className="ml-auto w-4 h-4 rounded-full bg-white text-black text-[10px] font-semibold flex items-center justify-center">
                              {agent.unread}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11.5px] text-[#888] truncate leading-tight mt-0.5">
                          {agent.lastMessage}
                        </div>
                      </div>
                      <button className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded-full bg-[#222] flex items-center justify-center text-[#666] hover:text-[#ccc]">
                        <Ellipsis className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* All Trading Agents */}
            <div>
              <div className="flex items-center justify-between px-2 mb-1.5">
                <div className="flex items-center gap-1.5">
                  <Activity className="w-3 h-3 text-[#666]" />
                  <span className="text-[11px] font-semibold tracking-widest uppercase text-[#666]">
                    All Trading Agents
                  </span>
                  <span className="text-[10px] bg-[#1e1e1e] border border-[#222] rounded-full px-1.5 py-0.5 text-[#888]">
                    {agents.length}
                  </span>
                </div>
              </div>
              <div className="space-y-0.5">
                {unpinnedAgents.map((agent) => (
                  <div
                    key={agent.id}
                    onClick={() => {
                      setActiveChatId(agent.id);
                      setIsMobileNavOpen(false);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, agentId: agent.id });
                    }}
                    className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-[12px] cursor-pointer transition-colors ${
                      activeChatId === agent.id
                        ? "bg-[#1e1e1e] border border-[#2a2a2a]"
                        : "border border-transparent hover:bg-[#1a1a1a] hover:border-[#1e1e1e]"
                    }`}
                  >
                    <AgentAvatar
                      name={agent.name}
                      badge={agent.badge}
                      avatarColor={agent.avatarColor}
                      size={28}
                      status={agent.status}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="text-[13px] font-[500] truncate leading-tight">{agent.name}</span>
                        <span className="text-[9px] px-1 py-0 rounded bg-[#222] border border-[#333] text-[#888] font-mono">
                          {agent.badge}
                        </span>
                      </div>
                      <div className="text-[11.5px] text-[#888] truncate leading-tight mt-0.5">
                        {agent.lastMessage}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Automated Routines */}
            <div>
              <div className="flex items-center gap-1.5 px-2 mb-1.5">
                <CalendarClock className="w-3 h-3 text-[#666]" />
                <span className="text-[11px] font-semibold tracking-widest uppercase text-[#666]">
                  Automated Routines
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[10px] hover:bg-[#1a1a1a] cursor-pointer text-[13px] text-[#999]">
                  <CalendarClock className="w-4 h-4 text-[#555]" /> Market Open Scan • 9:30 AM
                </div>
                <div className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[10px] hover:bg-[#1a1a1a] cursor-pointer text-[13px] text-[#999]">
                  <CalendarClock className="w-4 h-4 text-[#555]" /> EOD Risk Reconciliation • 4:00 PM
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar Footer */}
          <div className="p-2 border-t border-[#222] space-y-2 bg-[#111]">
            <div className="rounded-[12px] bg-[#1a1a1a] border border-[#2a2a2a] p-3 flex gap-2.5">
              <div className="w-8 h-8 rounded-[8px] bg-white flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-black" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium leading-tight">Finance Agent OS v2.4</div>
                <div className="text-[11px] text-[#888] leading-tight mt-0.5">
                  Multi-agent trading engine & fast tools active
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 px-1">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 border border-[#222] flex items-center justify-center text-[13px] font-bold">
                N
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium leading-none truncate">Naman</div>
                <div className="text-[11px] text-[#888]">Portfolio NAV: $184,250</div>
              </div>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="w-7 h-7 rounded-[8px] bg-[#1a1a1a] border border-[#222] flex items-center justify-center text-[#888] hover:text-[#ccc] hover:bg-[#222]"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>

        {isMobileNavOpen && (
          <div className="fixed inset-0 bg-black/50 z-0 md:hidden" onClick={() => setIsMobileNavOpen(false)} />
        )}

        {/* 3. Main Center Workspace */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a]">
          {/* Header Bar */}
          <div className="h-[56px] shrink-0 border-b border-[#222] flex items-center px-3 md:px-4 gap-3 bg-[#0a0a0a]/90 backdrop-blur">
            <button
              className="md:hidden w-8 h-8 rounded-[8px] bg-[#1a1a1a] border border-[#222] flex items-center justify-center"
              onClick={() => setIsMobileNavOpen(true)}
            >
              <Layers className="w-4 h-4" />
            </button>

            {isRoom ? (
              <div className="flex -space-x-2">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 border-2 border-[#0a0a0a]" />
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-600 to-rose-700 border-2 border-[#0a0a0a]" />
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-600 to-teal-800 border-2 border-[#0a0a0a]" />
              </div>
            ) : (
              <AgentAvatar
                name={activeAgent?.name || "A"}
                badge={activeAgent?.badge}
                avatarColor={activeAgent?.avatarColor}
                size={34}
                status={activeAgent?.status}
              />
            )}

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-[600] tracking-tight">{currentTitle}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[11px] text-[#888]">
                  {isRoom ? "Multi-Agent Coordination Active" : `${activeAgent?.badge} Online`}
                </span>
              </div>
              <div className="text-[11px] text-[#666] -mt-0.5 truncate">{currentRole}</div>
            </div>

            {/* Model & Task Actions */}
            <div className="ml-auto flex items-center gap-1.5">
              <div className="relative">
                <button
                  onClick={() => setIsModelDropdownOpen((prev) => !prev)}
                  className="h-7 px-2.5 rounded-full bg-[#1a1a1a] border border-[#222] flex items-center gap-1.5 text-[12px] hover:bg-[#222] transition-colors"
                >
                  <Cpu className="w-3.5 h-3.5 text-blue-400" />
                  Claude Opus 4.5
                  <ChevronDown className="w-3 h-3 text-[#666]" />
                </button>

                {isModelDropdownOpen && (
                  <div className="absolute top-[36px] right-0 w-[360px] rounded-[14px] bg-[#151515] border border-[#2a2a2a] shadow-[0_16px_40px_rgba(0,0,0,0.6)] z-30 overflow-hidden">
                    <div className="p-3 border-b border-[#222] flex gap-2">
                      <div className="flex-1 rounded-[10px] bg-[#1a1a1a] border border-[#222] p-2">
                        <div className="text-[11px] font-semibold tracking-widest uppercase text-[#666] mb-2 flex items-center gap-1">
                          <Cpu className="w-3 h-3" /> Quant Rail
                        </div>
                        <div className="space-y-1">
                          {["Claude Opus 4.5", "Claude Sonnet 4", "Claude Haiku 3.5"].map((m) => (
                            <div
                              key={m}
                              onClick={() => setIsModelDropdownOpen(false)}
                              className="px-2.5 py-1.5 rounded-[8px] text-[12.5px] cursor-pointer hover:bg-[#222] text-[#ccc]"
                            >
                              {m}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex-1 rounded-[10px] bg-[#1a1a1a] border border-[#222] p-2">
                        <div className="text-[11px] font-semibold tracking-widest uppercase text-[#666] mb-2 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> Execution Rail
                        </div>
                        <div className="space-y-1">
                          {["GPT-5 Codex", "GPT-4o", "Grok 4"].map((m) => (
                            <div
                              key={m}
                              onClick={() => setIsModelDropdownOpen(false)}
                              className="px-2.5 py-1.5 rounded-[8px] text-[12.5px] cursor-pointer hover:bg-[#222] text-[#ccc]"
                            >
                              {m}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Tasks / Signals Trigger */}
              <div className="relative hidden sm:flex">
                <button
                  onClick={() => setIsTasksDropdownOpen((prev) => !prev)}
                  className="h-7 px-2.5 rounded-full bg-[#1a1a1a] border border-[#222] flex items-center gap-1.5 text-[12px] hover:bg-[#222]"
                >
                  <Zap className="w-3 h-3 text-amber-400" /> Alphas
                  <span className="bg-[#222] border border-[#2a2a2a] rounded-full px-1.5 py-0 text-[10px] text-[#aaa]">
                    3 active
                  </span>
                </button>

                {isTasksDropdownOpen && (
                  <div className="absolute top-[36px] right-0 w-[320px] rounded-[12px] bg-[#151515] border border-[#2a2a2a] shadow-xl z-30 p-2">
                    <div className="text-[11px] uppercase tracking-widest font-semibold text-[#666] px-2 py-1">
                      Active Trading Alphas
                    </div>
                    {[
                      { name: "BTC/USDT RSI Squeeze Long", pnl: "+$2,840.00" },
                      { name: "ETH/USDT Mean Reversion", pnl: "+$1,420.50" },
                      { name: "SOL/USDT Liquidity Sweep", pnl: "+$680.00" },
                    ].map((t) => (
                      <div
                        key={t.name}
                        className="px-2.5 py-2 rounded-[8px] hover:bg-[#1e1e1e] cursor-pointer flex items-center justify-between"
                      >
                        <span className="text-[12.5px]">{t.name}</span>
                        <span className="text-[11px] text-emerald-400 font-mono">{t.pnl}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Computer / Live Telemetry Trigger */}
              <button
                onClick={() => {
                  setIsComputerOpen((prev) => !prev);
                  setIsSettingsOpen(false);
                }}
                className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${
                  isComputerOpen
                    ? "bg-white text-black border-white"
                    : "bg-[#1a1a1a] border-[#222] text-[#999] hover:bg-[#222]"
                }`}
                title="Live Market Terminal & Activity"
              >
                <Monitor className="w-3.5 h-3.5" />
              </button>

              <button className="w-7 h-7 rounded-full bg-[#1a1a1a] border border-[#222] text-[#999] flex items-center justify-center hover:bg-[#222]">
                <Mic className="w-3.5 h-3.5" />
              </button>
              <button className="w-7 h-7 rounded-full bg-[#1a1a1a] border border-[#222] text-[#999] flex items-center justify-center hover:bg-[#222]">
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Message Feed */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 md:px-6 py-6 space-y-6">
            <div className="flex justify-center">
              <span className="text-[11px] px-3 py-1 rounded-full bg-[#1a1a1a] border border-[#222] text-[#888]">
                Multi-Agent Secure Channel • {currentTitle}
              </span>
            </div>

            {activeMessages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "user" ? (
                  <div className="max-w-[72%] bg-[#1e1e1e] border border-[#2a2a2a] rounded-[18px] rounded-br-[6px] px-4 py-2.5 text-[13.5px] leading-[1.5] whitespace-pre-wrap">
                    {msg.content}
                  </div>
                ) : (
                  <div className="flex gap-2.5 max-w-[85%] group">
                    <AgentAvatar
                      name={msg.agentName || "A"}
                      badge={msg.agentBadge}
                      avatarColor={msg.agentColor}
                      size={30}
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-[600] text-white">{msg.agentName || "Finance Agent"}</span>
                        {msg.agentBadge && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#222] border border-[#333] text-emerald-400 font-mono">
                            {msg.agentBadge}
                          </span>
                        )}
                        <span className="text-[11px] text-[#666] ml-1">{msg.timestamp}</span>
                      </div>

                      {/* Tool Executions */}
                      {msg.tools && (
                        <div className="space-y-2">
                          <button
                            onClick={() => setOpenTools((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#1a1a1a] border border-[#222] text-[11.5px] text-[#aaa] hover:bg-[#222] transition-colors"
                          >
                            <Terminal className="w-3 h-3 text-blue-400" />
                            Executed {msg.tools.length} quantitative tools
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${openTools[msg.id] ? "rotate-180" : ""}`}
                            />
                          </button>

                          {openTools[msg.id] && (
                            <div className="rounded-[12px] bg-[#111] border border-[#222] p-2 space-y-1">
                              {msg.tools.map((t) => (
                                <div
                                  key={t.id}
                                  className="flex items-center gap-2 text-[12px] px-2 py-1 rounded-[8px] hover:bg-[#1a1a1a]"
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                  <span className="text-[#aaa] font-mono text-[11.5px]">{t.name}</span>
                                  <Check className="w-3 h-3 text-emerald-400 ml-auto" />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Content Text */}
                      {msg.content && (
                        <div className="text-[13.5px] leading-[1.6] text-[#e5e5e5] whitespace-pre-wrap">
                          {msg.content}
                        </div>
                      )}

                      {/* Interactive Trade / Risk Approval Card */}
                      {msg.approval && (
                        <div className="rounded-[12px] border border-emerald-500/30 bg-[#071a10] overflow-hidden shadow-lg">
                          <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/20 bg-[#0c2a1b]">
                            <TrendingUp className="w-4 h-4 text-emerald-400" />
                            <span className="text-[12px] font-semibold text-emerald-200">{msg.approval.title}</span>
                            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase font-mono">
                              {msg.approval.type}
                            </span>
                          </div>
                          <div className="p-3">
                            <code className="text-[12px] font-mono text-[#e5e5e5] bg-black/40 border border-[#222] rounded-[8px] px-2.5 py-1.5 block">
                              {msg.approval.content}
                            </code>
                            <div className="flex gap-2 mt-3">
                              <button
                                onClick={() => alert("Trade Order Executed on Liquidity Bridge!")}
                                className="h-7 px-3 rounded-full bg-emerald-400 text-black text-[12px] font-semibold hover:bg-emerald-300 transition-colors"
                              >
                                Authorize Execution
                              </button>
                              <button
                                onClick={() => alert("Trade Cancelled.")}
                                className="h-7 px-3 rounded-full bg-[#222] border border-[#333] text-[#ccc] text-[12px] hover:bg-[#2a2a2a]"
                              >
                                Reject Order
                              </button>
                              <button className="ml-auto text-[11px] text-[#666] hover:text-[#999]">
                                Set Auto-Execution Policy
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Code Block */}
                      {msg.code && (
                        <div className="rounded-[12px] border border-[#222] overflow-hidden bg-[#111]">
                          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#222] bg-[#151515]">
                            <span className="text-[11px] font-mono text-[#666]">{msg.code.lang}</span>
                            <button
                              onClick={() => handleCopyCode(msg.code!.code, msg.id)}
                              className="flex items-center gap-1 text-[11px] text-[#888] hover:text-[#ccc]"
                            >
                              {copiedId === msg.id ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              {copiedId === msg.id ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <pre className="p-3 text-[12px] leading-[1.6] font-mono overflow-x-auto text-[#ccc]">
                            <code>{msg.code.code}</code>
                          </pre>
                        </div>
                      )}

                      {/* Emoji Reactions */}
                      <div className="flex items-center gap-1 pt-1">
                        {["🔥", "📈", "👏", "💡", "🚀"].map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => handleAddReaction(msg.id, emoji)}
                            className="w-6 h-6 rounded-full bg-[#1a1a1a] border border-[#222] flex items-center justify-center text-[12px] hover:bg-[#222] hover:scale-110 transition-all"
                          >
                            {emoji}
                          </button>
                        ))}
                        {msg.reactions && (
                          <div className="ml-2 flex gap-1">
                            {msg.reactions.map((r, i) => (
                              <span
                                key={i}
                                className="text-[11px] bg-[#1e1e1e] border border-[#222] rounded-full px-1.5 py-0.5"
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className="flex gap-2.5 items-center">
                <div className="w-7 h-7 rounded-[8px] bg-gradient-to-br from-emerald-400 to-blue-500 flex items-center justify-center text-[11px] font-bold text-black">
                  FA
                </div>
                <div className="flex items-center gap-2 text-[12.5px] text-[#888]">
                  <span className="flex gap-1">
                    <span className="w-1 h-1 bg-emerald-400 rounded-full animate-bounce" />
                    <span className="w-1 h-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <span className="w-1 h-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </span>
                  Finance Agents coordinating strategy & risk parameters...
                </div>
              </div>
            )}
          </div>

          {/* 4. Chat Input Bar */}
          <div className="shrink-0 p-3 md:p-4">
            <div className="relative rounded-[20px] border bg-[#151515] transition-all shadow-[0_0_0_1px_rgba(255,255,255,0.06)] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_0_24px_rgba(255,255,255,0.06)] border-[#222] focus-within:border-[#333] overflow-hidden">
              <textarea
                ref={textareaRef}
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask trading agents or formulate strategy (e.g. Backtest BTC RSI breakout and evaluate risk)..."
                className="w-full min-h-[48px] max-h-[160px] bg-transparent px-4 pt-3.5 pb-12 text-[14px] placeholder:text-[#666] outline-none resize-none leading-[1.5]"
                rows={1}
              />
              <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <button className="w-7 h-7 rounded-full bg-[#1e1e1e] border border-[#222] flex items-center justify-center text-[#888] hover:text-[#ccc] hover:bg-[#222]">
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <button className="w-7 h-7 rounded-full bg-[#1e1e1e] border border-[#222] flex items-center justify-center text-[#888] hover:text-[#ccc] hover:bg-[#222]">
                    <Mic className="w-4 h-4" />
                  </button>
                  <div className="hidden sm:flex items-center gap-1 ml-1 text-[11px] text-[#555]">
                    <span className="w-px h-3 bg-[#222] mr-1" />
                    Finance Agent Multi-Orchestrator • {inputVal.length > 0 ? `${inputVal.length} chars` : "Enter to send"}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isTyping && <span className="text-[11px] text-emerald-400 font-mono hidden sm:block">Agents debating...</span>}
                  <button
                    onClick={handleSend}
                    disabled={!inputVal.trim()}
                    className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-200 transition-colors shadow-sm"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-center gap-2 text-[10px] text-[#555]">
              <span>Finance Agent OS Autonomous Execution Engine. Verify live orders.</span>
              <span className="hidden sm:inline-flex items-center gap-1">
                <div className="w-1 h-1 rounded-full bg-emerald-400" /> Fastify Backend Connected
              </span>
            </div>
          </div>
        </main>

        {/* 5. Right Companion & Settings Drawer */}
        {(isComputerOpen || isSettingsOpen) && (
          <aside className="w-[360px] shrink-0 border-l border-[#222] bg-[#111111] flex flex-col">
            <div className="h-[56px] border-b border-[#222] flex items-center px-4 justify-between">
              <div className="flex items-center gap-2">
                {isComputerOpen ? <BarChart2 className="w-4 h-4 text-emerald-400" /> : <Settings className="w-4 h-4 text-[#888]" />}
                <span className="text-[13px] font-medium">{isComputerOpen ? "Live Market Telemetry" : "Agent Settings"}</span>
              </div>
              <button
                onClick={() => {
                  setIsComputerOpen(false);
                  setIsSettingsOpen(false);
                }}
                className="w-6 h-6 rounded-full bg-[#1a1a1a] border border-[#222] flex items-center justify-center text-[#666] hover:text-[#ccc]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {isComputerOpen ? (
                <div className="space-y-3">
                  <div className="rounded-[12px] bg-[#151515] border border-[#222] p-3 space-y-3">
                    <div className="text-[11px] uppercase tracking-widest font-semibold text-[#888] flex items-center justify-between">
                      <span>Portfolio Statistics</span>
                      <span className="text-emerald-400 font-mono">+4.78% Today</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-[#111] p-2.5 rounded-[8px] border border-[#222]">
                        <div className="text-[11px] text-[#666]">Net Asset Value</div>
                        <div className="text-[15px] font-bold text-white font-mono">$184,250.00</div>
                      </div>
                      <div className="bg-[#111] p-2.5 rounded-[8px] border border-[#222]">
                        <div className="text-[11px] text-[#666]">Available Margin</div>
                        <div className="text-[15px] font-bold text-emerald-400 font-mono">$105,950.00</div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[10px] bg-[#151515] border border-[#222] p-2.5 space-y-2">
                    <div className="text-[11px] uppercase tracking-widest font-semibold text-[#666]">
                      Inter-Agent Telemetry Stream
                    </div>
                    <div className="space-y-2 text-[12px]">
                      <div className="flex gap-2">
                        <span className="text-purple-400 font-mono">[INTEL]</span>
                        <span className="text-[#aaa]">Whale absorption detected at $68,150</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-blue-400 font-mono">[QUANT]</span>
                        <span className="text-[#aaa]">Alpha signal BUY triggered (Sharpe 2.45)</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-amber-400 font-mono">[RISK]</span>
                        <span className="text-[#aaa]">VaR 1.69% verified. Risk clearance granted</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-emerald-400 font-mono">[EXEC]</span>
                        <span className="text-[#aaa]">TWAP routing ready on Binance/Bybit</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-2.5 rounded-[12px] bg-[#151515] border border-[#222]">
                    <div className="w-10 h-10 rounded-[10px] bg-gradient-to-br from-emerald-400 to-blue-500 flex items-center justify-center font-bold text-black">
                      FA
                    </div>
                    <div>
                      <div className="text-[13px] font-medium">Finance Agent OS</div>
                      <div className="text-[11px] text-[#888]">Autonomous Multi-Agent Runtime</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold tracking-widest uppercase text-[#666] mb-2 px-1">
                      Exchange Connectivity
                    </div>
                    <div className="space-y-1.5">
                      {["Binance Spot & Futures", "Bybit Derivatives", "Coinbase Pro", "OKX Global"].map((ex) => (
                        <div
                          key={ex}
                          className="flex items-center justify-between px-2.5 py-2 rounded-[10px] bg-[#151515] border border-[#222] text-[12.5px]"
                        >
                          <span>{ex}</span>
                          <span className="text-[11px] text-emerald-400 font-mono">• CONNECTED</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* 6. Context Menu on Agent Right-Click */}
      {contextMenu && (
        <div
          className="fixed z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <div className="w-[200px] rounded-[12px] bg-[#1a1a1a] border border-[#2a2a2a] shadow-[0_12px_32px_rgba(0,0,0,0.6)] p-1 text-[12.5px]">
            {[
              { label: "Pin agent", icon: Pin },
              { label: "View Alphas", icon: Zap },
              { label: "Edit strategy", icon: Settings },
              { label: "Duplicate agent", icon: Copy },
              { label: "Copy ID", icon: Activity },
            ].map((item) => (
              <div
                key={item.label}
                onClick={() => {
                  if (item.label === "Pin agent") {
                    setAgents((prev) =>
                      prev.map((a) => (a.id === contextMenu.agentId ? { ...a, pinned: !a.pinned } : a))
                    );
                  }
                  setContextMenu(null);
                }}
                className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[8px] cursor-pointer text-[#ccc] hover:bg-[#222]"
              >
                <item.icon className="w-3.5 h-3.5" /> {item.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 7. Command Palette Modal (Cmd+K) */}
      {isCommandOpen && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[18vh] px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setIsCommandOpen(false)} />
          <div className="relative w-full max-w-[560px] rounded-[16px] bg-[#151515] border border-[#2a2a2a] shadow-[0_24px_64px_rgba(0,0,0,0.7)] overflow-hidden">
            <div className="flex items-center gap-3 px-4 h-12 border-b border-[#222]">
              <Search className="w-4 h-4 text-[#666]" />
              <input
                autoFocus
                placeholder="Jump to Finance Agent, Trading Room, Strategy..."
                className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#666]"
              />
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#222] border border-[#2a2a2a] text-[#666]">
                ESC
              </span>
            </div>
            <div className="p-2 max-h-[360px] overflow-y-auto space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest font-semibold text-[#666] px-2 py-1">
                  Trading Agents
                </div>
                {agents.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => {
                      setActiveChatId(a.id);
                      setIsCommandOpen(false);
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] hover:bg-[#1e1e1e] cursor-pointer"
                  >
                    <AgentAvatar name={a.name} badge={a.badge} avatarColor={a.avatarColor} size={24} />
                    <span className="text-[13px]">{a.name}</span>
                    <span className="text-[11px] text-[#666]">— {a.role}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 8. New Trading Agent Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setIsCreateModalOpen(false)} />
          <div className="relative w-full max-w-[420px] rounded-[16px] bg-[#151515] border border-[#2a2a2a] shadow-[0_24px_64px_rgba(0,0,0,0.7)] p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold">New Autonomous Finance Agent</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="w-6 h-6 rounded-full bg-[#1e1e1e] border border-[#222] flex items-center justify-center"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="Agent name (e.g. Statistical Arbitrage Agent)"
                className="w-full h-10 rounded-[10px] bg-[#1a1a1a] border border-[#222] px-3 text-[13px] outline-none focus:border-[#333]"
              />
              <select
                value={newAgentModel}
                onChange={(e) => setNewAgentModel(e.target.value)}
                className="w-full h-10 rounded-[10px] bg-[#1a1a1a] border border-[#222] px-3 text-[13px] outline-none"
              >
                <option>Claude Opus 4.5 • Quant rail</option>
                <option>Claude Sonnet 4 • Risk rail</option>
                <option>GPT-5 Codex • Execution rail</option>
                <option>Grok 4 • Market Intel rail</option>
              </select>
              <textarea
                value={newAgentPrompt}
                onChange={(e) => setNewAgentPrompt(e.target.value)}
                placeholder="Quantitative strategy instructions & risk parameters..."
                className="w-full min-h-[80px] rounded-[10px] bg-[#1a1a1a] border border-[#222] p-3 text-[13px] outline-none resize-none"
              />
              <button
                onClick={handleCreateAgent}
                disabled={!newAgentName.trim()}
                className="w-full h-10 rounded-full bg-white text-black font-medium text-[13px] hover:bg-zinc-200 disabled:opacity-30"
              >
                Deploy Finance Agent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
