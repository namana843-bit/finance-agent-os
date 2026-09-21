import React, { useState, useEffect, useRef } from "react";
import {
  Activity,
  ArrowUp,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Code2,
  Copy,
  Cpu,
  Download,
  FolderOpen,
  Info,
  Maximize2,
  Mic,
  MoreVertical,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";

import {
  API_BASE,
  type AgentApiConfig,
  type EngineApiStatus,
  type Tick,
  type Portfolio,
  fetchAgents,
  createAgent,
  deleteAgentApi,
  exportAgentApi,
  importAgentApi,
  fetchEnginesApi,
  fetchOllamaModelsApi,
  saveEngineCliOverride,
  streamAgentChat,
  fetchTicks,
  fetchPortfolio,
} from "./lib/api";

import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Switch } from "./components/ui/switch";
import { Progress } from "./components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";

function safePrice(price: unknown): string {
  if (typeof price === "number" && Number.isFinite(price)) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return "0.00";
}

function safeChangePercent(tick?: Partial<Tick> | null): number {
  if (!tick) return 0;
  if (typeof tick.changePercent === "number" && Number.isFinite(tick.changePercent)) {
    return tick.changePercent;
  }
  if (typeof tick.change === "number" && typeof tick.price === "number" && tick.price > 0) {
    return (tick.change / tick.price) * 100;
  }
  return 0;
}

function safeVolume(vol: unknown): string {
  if (typeof vol === "number" && Number.isFinite(vol)) {
    return vol.toFixed(2);
  }
  return "0.00";
}

export interface TradingAgent {
  id: string;
  name: string;
  role: string;
  model: string;
  engine: string;
  systemPrompt?: string;
  tools?: string[];
  permissions?: { execution?: boolean };
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
  reasoning?: string;
  timestamp: string;
  tools?: Array<{
    id: string;
    name: string;
    status: "done" | "running" | "failed";
    result?: unknown;
  }>;
  code?: { lang: string; code: string };
  proposal?: {
    symbol: string;
    side: string;
    quantity: number;
    orderType: string;
    price?: number;
    reason?: string;
    confidence?: number;
    decision?: "APPROVED" | "REJECTED";
    paperExecution?: "FILLED" | "REJECTED" | "SIMULATED";
  };
  reactions?: string[];
}

const DEFAULT_AGENTS: TradingAgent[] = [
  {
    id: "btc-quant-agent",
    name: "BTC Quant",
    role: "Quantitative Analyst",
    model: "opencode",
    engine: "opencode-cli",
    systemPrompt:
      "You are an expert BTC quantitative analyst agent running via OpenCode CLI. Analyze prices, compute technical indicators (RSI/MACD/Supertrend), inspect portfolio state, and create structured trade proposals when high-probability opportunities exist.",
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
    lastMessage: "OpenCode CLI engine initialized. Ready for analysis.",
    lastTime: "just now",
    unread: 1,
    status: "working",
    pinned: true,
    avatarColor: "bg-blue-600",
    badge: "QUANT",
  },
  {
    id: "risk-guardian-agent",
    name: "Risk Guardian",
    role: "Risk & Compliance Guardian",
    model: "opencode",
    engine: "opencode-cli",
    systemPrompt:
      "You are an automated risk guardian agent for Finance Agent OS. Monitor portfolio exposure, calculate risk metrics, and verify all trade proposals against hard risk parameters.",
    tools: ["get_portfolio", "get_market_price"],
    permissions: { execution: false },
    lastMessage: "OpenCode CLI engine initialized. Risk monitoring active.",
    lastTime: "just now",
    status: "working",
    pinned: true,
    avatarColor: "bg-amber-600",
    badge: "RISK",
  },
  {
    id: "opencode-cli-agent",
    name: "OpenCode CLI Agent",
    role: "Local CLI Execution Engine",
    model: "opencode",
    engine: "opencode-cli",
    systemPrompt:
      "You are a local CLI agent driver running via OpenCode CLI execution.",
    tools: ["get_market_price", "get_portfolio"],
    permissions: { execution: false },
    lastMessage: "Local executable CLI driver active.",
    lastTime: "10m",
    status: "idle",
    avatarColor: "bg-emerald-600",
    badge: "CLI",
  },
];

const INITIAL_CONVERSATIONS: Record<string, MultiAgentMessage[]> = {
  "btc-quant-agent": [
    {
      id: "btc-1",
      agentId: "btc-quant-agent",
      agentName: "BTC Quant",
      agentBadge: "QUANT",
      agentColor: "bg-blue-600",
      role: "assistant",
      content:
        "👋 Welcome to **Finance Agent OS** with **shadcn/ui** interface.\n\nI am connected to the **OpenCode CLI** engine and live market stream. Ask me to:\n- 📈 Analyze BTC/USDT technical indicators (`RSI`, `MACD`, `Supertrend`)\n- 🛡️ Run safety checks against the **Risk Engine**\n- ⚡ Generate structured trade proposals with automated paper broker execution",
      timestamp: "10:30 AM",
    },
  ],
  "risk-guardian-agent": [
    {
      id: "rs-1",
      agentId: "risk-guardian-agent",
      agentName: "Risk Guardian",
      agentBadge: "RISK",
      agentColor: "bg-amber-600",
      role: "assistant",
      content:
        "🛡️ **Risk Sentinel Online.** I monitor portfolio drawdown limits, margin exposure, and enforce the platform Kill Switch and HMAC controls.",
      timestamp: "10:31 AM",
    },
  ],
  "opencode-cli-agent": [
    {
      id: "cli-1",
      agentId: "opencode-cli-agent",
      agentName: "OpenCode CLI Agent",
      agentBadge: "CLI",
      agentColor: "bg-emerald-600",
      role: "assistant",
      content:
        "🖥️ **CLI Engine Online.** I connect directly to user-configured local binaries and OpenCode executables via process IPC.",
      timestamp: "10:32 AM",
    },
  ],
};

export function App() {
  const [agents, setAgents] = useState<TradingAgent[]>(DEFAULT_AGENTS);
  const [activeChatId, setActiveChatId] = useState<string>("btc-quant-agent");
  const [conversations, setConversations] =
    useState<Record<string, MultiAgentMessage[]>>(INITIAL_CONVERSATIONS);
  const [inputVal, setInputVal] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});

  // Market & Portfolio State
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);

  // Engine Settings state
  const [enginesList, setEnginesList] = useState<EngineApiStatus[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<{
    available: boolean;
    message?: string;
  }>({ available: true });
  const [editingEnginePaths, setEditingEnginePaths] = useState<
    Record<string, string>
  >({});
  const [savingEngineId, setSavingEngineId] = useState<string | null>(null);
  const [savedSuccessId, setSavedSuccessId] = useState<string | null>(null);

  // Create Agent Form State
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("BTC Quant Analyst");
  const [newAgentEngine, setNewAgentEngine] = useState("opencode-cli");
  const [newAgentModel, setNewAgentModel] = useState("qwen2.5-coder");
  const [newAgentPrompt, setNewAgentPrompt] = useState(
    "You are an expert quantitative trading agent. Analyze market data and construct high-sharpe trade proposals."
  );
  const [newAgentExecutionPerm, setNewAgentExecutionPerm] = useState(true);

  const activeAgent =
    agents.find((a) => a.id === activeChatId) || agents[0] || DEFAULT_AGENTS[0];
  const activeMessages = conversations[activeChatId] || [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initial Data Fetch & Polling
  useEffect(() => {
    async function loadBackendData() {
      try {
        const res = await fetchAgents();
        if (res?.agents && res.agents.length > 0) {
          const mapped: TradingAgent[] = res.agents.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role || "Quant Agent",
            model: a.model || "default",
            engine: a.engine,
            systemPrompt: a.systemPrompt,
            tools: a.tools,
            permissions: a.permissions,
            lastMessage: "Finance Agent ready.",
            lastTime: "now",
            status: "idle",
            avatarColor: a.id.includes("risk")
              ? "bg-amber-600"
              : a.id.includes("cli")
              ? "bg-emerald-600"
              : "bg-blue-600",
            badge: a.id.includes("risk")
              ? "RISK"
              : a.id.includes("cli")
              ? "CLI"
              : "QUANT",
          }));
          setAgents(mapped);
        }
      } catch {}

      try {
        const engRes = await fetchEnginesApi();
        if (engRes?.engines) setEnginesList(engRes.engines);
      } catch {}

      try {
        const ollamaRes = await fetchOllamaModelsApi();
        setOllamaStatus({
          available: ollamaRes.available,
          message: ollamaRes.message,
        });
      } catch {}

      try {
        const tickRes = await fetchTicks({ limit: 8 });
        if (tickRes?.ticks) setTicks(tickRes.ticks);
      } catch {}

      try {
        const pf = await fetchPortfolio();
        if (pf) setPortfolio(pf);
      } catch {}
    }

    void loadBackendData();

    // Market & Portfolio polling interval
    const interval = setInterval(async () => {
      try {
        const tickRes = await fetchTicks({ limit: 8 });
        if (tickRes?.ticks) setTicks(tickRes.ticks);
      } catch {}
      try {
        const pf = await fetchPortfolio();
        if (pf) setPortfolio(pf);
      } catch {}
    }, 4000);

    return () => clearInterval(interval);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [activeMessages, isTyping]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        140
      )}px`;
    }
  }, [inputVal]);

  const handleSaveEnginePath = async (id: string) => {
    const targetEng = enginesList.find((e) => e.id === id);
    const customCmd = (
      editingEnginePaths[id] ??
      targetEng?.effectiveCommand ??
      targetEng?.command ??
      ""
    ).trim();
    if (!customCmd) return;
    setSavingEngineId(id);
    try {
      const res = await saveEngineCliOverride(id, customCmd);
      if (res?.engine) {
        setEnginesList((prev) =>
          prev.map((e) => (e.id === id ? res.engine : e))
        );
      }
      const engRes = await fetchEnginesApi();
      if (engRes?.engines) setEnginesList(engRes.engines);
      setSavedSuccessId(id);
      setTimeout(() => setSavedSuccessId(null), 2500);
    } catch (err) {
      alert(
        "Failed to save CLI path: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSavingEngineId(null);
    }
  };

  const handleSwitchAgentEngine = async (
    agentId: string,
    newEngine: string
  ) => {
    const target = agents.find((a) => a.id === agentId);
    if (!target) return;
    const updatedAgent = {
      ...target,
      engine: newEngine,
      model: newEngine.includes("opencode") ? "opencode" : target.model,
    };
    try {
      await createAgent({
        id: updatedAgent.id,
        name: updatedAgent.name,
        engine: updatedAgent.engine,
        model: updatedAgent.model,
        systemPrompt: updatedAgent.systemPrompt,
        tools: updatedAgent.tools,
        permissions: updatedAgent.permissions,
      });
    } catch {}
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? updatedAgent : a))
    );
  };

  // Real Streaming Send Message
  const handleSend = async (overrideText?: string) => {
    const textToSend = (overrideText || inputVal).trim();
    if (!textToSend || !activeAgent) return;

    const userMsg: MultiAgentMessage = {
      id: Date.now().toString(),
      role: "user",
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    setConversations((prev) => ({
      ...prev,
      [activeChatId]: [...(prev[activeChatId] || []), userMsg],
    }));
    setInputVal("");
    setIsTyping(true);

    const assistantMsgId = `asst-${Date.now()}`;
    const initialAssistantMsg: MultiAgentMessage = {
      id: assistantMsgId,
      agentId: activeAgent.id,
      agentName: activeAgent.name,
      agentBadge: activeAgent.badge,
      agentColor: activeAgent.avatarColor,
      role: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      tools: [],
    };

    setConversations((prev) => ({
      ...prev,
      [activeChatId]: [...(prev[activeChatId] || []), initialAssistantMsg],
    }));

    try {
      await streamAgentChat(activeAgent.id, textToSend, (event) => {
        setConversations((prev) => {
          const chatMsgs = [...(prev[activeChatId] || [])];
          const msgIdx = chatMsgs.findIndex((m) => m.id === assistantMsgId);
          if (msgIdx === -1) return prev;

          const target = { ...chatMsgs[msgIdx] };

          if (event.type === "text_delta") {
            target.content += event.delta;
          } else if (event.type === "reasoning_delta") {
            target.reasoning = (target.reasoning || "") + event.delta;
          } else if (event.type === "tool_call") {
            const currentTools = target.tools || [];
            if (!currentTools.some((t) => t.id === event.toolCallId)) {
              target.tools = [
                ...currentTools,
                { id: event.toolCallId, name: event.name, status: "running" },
              ];
            }
          } else if (event.type === "tool_result") {
            const currentTools = target.tools || [];
            target.tools = currentTools.map((t) =>
              t.id === event.toolCallId
                ? {
                    ...t,
                    status: event.isError ? "failed" : "done",
                    result: event.result,
                  }
                : t
            );

            // Handle trade proposal result
            if (event.name === "create_trade_proposal" && event.result) {
              const res = event.result as any;
              target.proposal = {
                symbol: res.proposal?.symbol || "BTCUSDT",
                side: res.proposal?.side || "BUY",
                quantity: res.proposal?.quantity || 0.01,
                orderType: res.proposal?.type || "MARKET",
                price: res.proposal?.price,
                reason: res.proposal?.reasoning || "Technical momentum signal",
                decision: res.decision || "APPROVED",
                paperExecution:
                  res.status === "EXECUTED" ? "FILLED" : "SIMULATED",
                confidence: 88,
              };
            }
          } else if (event.type === "error") {
            target.content += `\n\n⚠️ **Error:** ${event.error}`;
          }

          chatMsgs[msgIdx] = target;
          return { ...prev, [activeChatId]: chatMsgs };
        });
      });
    } catch (err) {
      setConversations((prev) => {
        const chatMsgs = [...(prev[activeChatId] || [])];
        const msgIdx = chatMsgs.findIndex((m) => m.id === assistantMsgId);
        if (msgIdx !== -1) {
          chatMsgs[msgIdx] = {
            ...chatMsgs[msgIdx],
            content: `⚠️ Engine Error: Failed to execute prompt on engine (${activeAgent.engine}). Please verify engine settings.`,
          };
        }
        return { ...prev, [activeChatId]: chatMsgs };
      });
    } finally {
      setIsTyping(false);
    }
  };

  const handleCreateAgentSubmit = async () => {
    if (!newAgentName.trim()) return;
    const newId =
      newAgentName.toLowerCase().replace(/[^a-z0-9]/g, "-") +
      "-" +
      Date.now().toString(36).slice(4);

    const newAgentObj: AgentApiConfig = {
      id: newId,
      name: newAgentName,
      role: newAgentRole,
      engine: newAgentEngine,
      model: newAgentModel,
      systemPrompt: newAgentPrompt,
      permissions: { execution: newAgentExecutionPerm },
      tools: [
        "get_market_price",
        "get_ohlcv",
        "calculate_rsi",
        "get_portfolio",
        "create_trade_proposal",
      ],
    };

    try {
      await createAgent(newAgentObj);
    } catch {}

    const UIObj: TradingAgent = {
      id: newId,
      name: newAgentName,
      role: newAgentRole,
      model: newAgentModel,
      engine: newAgentEngine,
      systemPrompt: newAgentPrompt,
      permissions: { execution: newAgentExecutionPerm },
      lastMessage: "Agent deployed.",
      lastTime: "just now",
      status: "idle",
      avatarColor: "bg-indigo-600",
      badge: "AGENT",
    };

    setAgents((prev) => [...prev, UIObj]);
    setActiveChatId(newId);
    setIsCreateModalOpen(false);
    setNewAgentName("");
    setNewAgentPrompt("");
  };

  const handleDeleteAgent = async (id: string) => {
    try {
      await deleteAgentApi(id);
    } catch {}
    setAgents((prev) => prev.filter((a) => a.id !== id));
    if (activeChatId === id && agents.length > 1) {
      setActiveChatId(agents[0].id);
    }
  };

  const handleExportAgent = async (id: string) => {
    try {
      const res = await exportAgentApi(id);
      if (res?.agent) {
        const str = JSON.stringify(res.agent, null, 2);
        const blob = new Blob([str], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${id}-agent.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      alert("Export failed: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleImportAgentFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const json = JSON.parse(evt.target?.result as string);
        const res = await importAgentApi(json);
        if (res?.agent) {
          const imported = res.agent;
          const UIObj: TradingAgent = {
            id: imported.id,
            name: imported.name,
            role: imported.role || "Imported Agent",
            model: imported.model || "default",
            engine: imported.engine,
            systemPrompt: imported.systemPrompt,
            permissions: imported.permissions,
            lastMessage: "Imported agent ready.",
            lastTime: "now",
            status: "idle",
            avatarColor: "bg-purple-600",
            badge: "IMPORT",
          };
          setAgents((prev) => [...prev, UIObj]);
          setActiveChatId(imported.id);
        }
      } catch (err) {
        alert("Import failed: Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  };

  const filteredAgents = agents.filter((a) =>
    searchQuery
      ? a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.role.toLowerCase().includes(searchQuery.toLowerCase())
      : true
  );

  const btcTick = ticks.find((t) => t.symbol.includes("BTC")) || ticks[0];
  const activeOpencodeEng = enginesList.find((e) => e.id === "opencode-cli");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden font-sans antialiased selection:bg-primary/20">
        {/* TOP APP BAR / BRAND HEADER */}
        <header className="h-14 shrink-0 border-b border-border/40 bg-card/60 backdrop-blur-md px-4 flex items-center justify-between z-30">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold shadow-md shadow-primary/20">
                <Activity className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold tracking-tight">
                    FINANCE AGENT OS
                  </span>
                  <Badge variant="cyan" className="text-[10px] px-1.5 py-0 h-4">
                    shadcn/ui
                  </Badge>
                </div>
                <div className="text-[10px] text-muted-foreground leading-none">
                  Autonomous Trading & LLM Orchestration
                </div>
              </div>
            </div>

            <Separator orientation="vertical" className="h-6 mx-1" />

            {/* LIVE TICKER PILL */}
            {btcTick && (
              <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded-full border border-border/50 bg-background/50 text-xs">
                <span className="font-semibold text-muted-foreground">
                  {btcTick.symbol}:
                </span>
                <span className="font-mono font-medium">
                  ${safePrice(btcTick.price)}
                </span>
                <Badge
                  variant={safeChangePercent(btcTick) >= 0 ? "success" : "destructive"}
                  className="text-[10px] px-1 py-0 h-4"
                >
                  {safeChangePercent(btcTick) >= 0 ? "+" : ""}
                  {safeChangePercent(btcTick).toFixed(2)}%
                </Badge>
              </div>
            )}
          </div>

          {/* RIGHT ACTION CONTROLS */}
          <div className="flex items-center gap-2">
            {/* Active Engine Dropdown Switcher */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-2 border-border/60 bg-background/40 hover:bg-accent text-xs font-mono"
                >
                  <Cpu className="h-3.5 w-3.5 text-emerald-400" />
                  <span>{activeAgent.engine}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-[11px]">
                  Switch Engine for {activeAgent.name}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    void handleSwitchAgentEngine(activeAgent.id, "opencode-cli")
                  }
                  className="gap-2 text-xs cursor-pointer"
                >
                  <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                  <div className="flex-1">
                    <div className="font-medium">OpenCode CLI (Local)</div>
                    <div className="text-[10px] text-muted-foreground">
                      IPC / Executable driver
                    </div>
                  </div>
                  {activeAgent.engine === "opencode-cli" && (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void handleSwitchAgentEngine(activeAgent.id, "ollama-local")
                  }
                  className="gap-2 text-xs cursor-pointer"
                >
                  <Cpu className="h-3.5 w-3.5 text-blue-400" />
                  <div className="flex-1">
                    <div className="font-medium">Ollama (Local)</div>
                    <div className="text-[10px] text-muted-foreground">
                      127.0.0.1:11434
                    </div>
                  </div>
                  {activeAgent.engine === "ollama-local" && (
                    <Check className="h-3.5 w-3.5 text-blue-400" />
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void handleSwitchAgentEngine(activeAgent.id, "openai-gpt4")
                  }
                  className="gap-2 text-xs cursor-pointer"
                >
                  <Zap className="h-3.5 w-3.5 text-purple-400" />
                  <div className="flex-1">
                    <div className="font-medium">OpenAI / Claude API</div>
                    <div className="text-[10px] text-muted-foreground">
                      Cloud Endpoint
                    </div>
                  </div>
                  {activeAgent.engine === "openai-gpt4" && (
                    <Check className="h-3.5 w-3.5 text-purple-400" />
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Quick Engine Status Indicator */}
            <Badge
              variant={activeOpencodeEng?.found ? "success" : "secondary"}
              className="hidden sm:inline-flex text-[11px] gap-1.5 py-1 px-2.5"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              CLI: {activeOpencodeEng?.found ? "Ready" : "Detected"}
            </Badge>

            {/* Import Button */}
            <label className="cursor-pointer">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs border-border/60"
                asChild
              >
                <span>
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="hidden md:inline">Import</span>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleImportAgentFile}
                    className="hidden"
                  />
                </span>
              </Button>
            </label>

            {/* New Agent Button */}
            <Button
              variant="default"
              size="sm"
              onClick={() => setIsCreateModalOpen(true)}
              className="h-8 gap-1.5 text-xs shadow-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Agent</span>
            </Button>

            {/* Inspector Toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isInspectorOpen ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setIsInspectorOpen((prev) => !prev)}
                  className="h-8 w-8"
                >
                  <BarChart3 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Market & Portfolio Telemetry</TooltipContent>
            </Tooltip>

            {/* Engine Config Settings */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsSettingsOpen(true)}
                  className="h-8 w-8"
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Engine & CLI Configuration</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {/* WORKSPACE CONTENT BODY */}
        <div className="flex-1 flex min-h-0 relative">
          {/* LEFT SIDEBAR WITH TABS */}
          <aside className="w-80 shrink-0 border-r border-border/40 bg-card/40 flex flex-col min-h-0">
            <div className="p-3 border-b border-border/30">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search agents or models..."
                  className="h-8 pl-8 text-xs bg-background/50 border-border/60"
                />
              </div>
            </div>

            <Tabs defaultValue="agents" className="flex-1 flex flex-col min-h-0">
              <div className="px-3 pt-2">
                <TabsList className="w-full grid grid-cols-3 h-8">
                  <TabsTrigger value="agents" className="text-xs">
                    Agents
                  </TabsTrigger>
                  <TabsTrigger value="market" className="text-xs">
                    Market
                  </TabsTrigger>
                  <TabsTrigger value="portfolio" className="text-xs">
                    Portfolio
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* AGENTS LIST TAB */}
              <TabsContent value="agents" className="flex-1 min-h-0 m-0 pt-2">
                <ScrollArea className="h-full px-2">
                  <div className="space-y-1 pb-4">
                    {filteredAgents.map((agent) => {
                      const isActive = activeChatId === agent.id;
                      return (
                        <div
                          key={agent.id}
                          onClick={() => setActiveChatId(agent.id)}
                          className={`group flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-all border ${
                            isActive
                              ? "bg-accent/80 border-border text-accent-foreground shadow-sm"
                              : "border-transparent hover:bg-accent/40 hover:border-border/30 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <Avatar className="h-9 w-9 border border-border/40">
                            <AvatarFallback
                              className={`${agent.avatarColor} text-white font-bold text-xs`}
                            >
                              {agent.name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <span
                                className={`text-xs font-semibold truncate ${
                                  isActive ? "text-foreground" : ""
                                }`}
                              >
                                {agent.name}
                              </span>
                              <Badge
                                variant={
                                  agent.badge === "QUANT"
                                    ? "cyan"
                                    : agent.badge === "RISK"
                                    ? "warning"
                                    : "purple"
                                }
                                className="text-[9px] px-1 py-0 h-4 uppercase"
                              >
                                {agent.badge}
                              </Badge>
                            </div>

                            <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {agent.role}
                            </div>

                            <div className="flex items-center gap-1.5 mt-1">
                              <span className="text-[10px] font-mono px-1 rounded bg-muted text-muted-foreground">
                                {agent.engine}
                              </span>
                              <span className="text-[10px] text-muted-foreground/70 truncate">
                                • {agent.model}
                              </span>
                            </div>
                          </div>

                          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleExportAgent(agent.id);
                                  }}
                                  className="gap-2 text-xs"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                  Export Agent JSON
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleDeleteAgent(agent.id);
                                  }}
                                  className="gap-2 text-xs text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete Agent
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </TabsContent>

              {/* MARKET STREAM TAB */}
              <TabsContent value="market" className="flex-1 min-h-0 m-0 p-3">
                <ScrollArea className="h-full pr-1">
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Live Streaming Feeds
                    </div>
                    {ticks.length === 0 ? (
                      <div className="text-xs text-muted-foreground text-center py-8">
                        Connecting to market feeds...
                      </div>
                    ) : (
                      ticks.map((tick, i) => (
                        <Card
                          key={`${tick.symbol}-${i}`}
                          className="bg-card/50 border-border/40 p-2.5 hover:border-border/80 transition-colors"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-xs">
                              {tick.symbol}
                            </span>
                            <Badge
                              variant={
                                safeChangePercent(tick) >= 0 ? "success" : "destructive"
                              }
                              className="text-[10px] px-1.5 py-0 h-4"
                            >
                              {safeChangePercent(tick) >= 0 ? "+" : ""}
                              {safeChangePercent(tick).toFixed(2)}%
                            </Badge>
                          </div>
                          <div className="flex items-baseline justify-between mt-1 font-mono">
                            <span className="text-sm font-semibold">
                              ${safePrice(tick.price)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              Vol: {safeVolume(tick.volume)}
                            </span>
                          </div>
                        </Card>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              {/* PORTFOLIO SNAPSHOT TAB */}
              <TabsContent value="portfolio" className="flex-1 min-h-0 m-0 p-3">
                <ScrollArea className="h-full pr-1">
                  <div className="space-y-3">
                    <Card className="bg-gradient-to-br from-card to-muted/40 border-border/50 p-3">
                      <div className="text-[11px] text-muted-foreground font-medium">
                        Portfolio Net Asset Value
                      </div>
                      <div className="text-xl font-bold font-mono mt-0.5">
                        ${portfolio?.totalValue?.toLocaleString() || "100,000.00"}
                      </div>
                      <div className="flex items-center gap-1.5 mt-2">
                        <Badge variant="success" className="text-[10px] h-4">
                          +2.45% Day
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          Cash: ${portfolio?.availableCash?.toLocaleString() || "42,500"}
                        </span>
                      </div>
                    </Card>

                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Risk & Drawdown Gauge
                      </div>
                      <Card className="p-3 border-border/40 bg-card/40 space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">
                            Max Drawdown
                          </span>
                          <span className="font-mono text-emerald-400">
                            -1.8% / 5.0%
                          </span>
                        </div>
                        <Progress value={36} className="h-1.5" />
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>Status: Safe</span>
                          <span>Kill Switch: Armed</span>
                        </div>
                      </Card>
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>

            {/* SIDEBAR FOOTER (ENGINE STATUS) */}
            <div className="p-3 border-t border-border/30 bg-muted/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-medium">OpenCode CLI</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsSettingsOpen(true)}
                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Configure
                </Button>
              </div>
            </div>
          </aside>

          {/* MAIN CHAT & EXECUTION CANVAS */}
          <main className="flex-1 flex flex-col min-w-0 bg-background/50">
            {/* AGENT CANVAS HEADER */}
            <div className="h-14 shrink-0 border-b border-border/40 bg-card/30 backdrop-blur px-4 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-8 w-8 border border-border/40">
                  <AvatarFallback
                    className={`${activeAgent.avatarColor} text-white font-bold text-xs`}
                  >
                    {activeAgent.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate">
                      {activeAgent.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                      {activeAgent.engine}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {activeAgent.role} • Model: {activeAgent.model}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExportAgent(activeAgent.id)}
                  className="h-8 text-xs gap-1.5 border-border/60"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Export</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConversations((prev) => ({
                      ...prev,
                      [activeChatId]: [],
                    }));
                  }}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear Chat
                </Button>
              </div>
            </div>

            {/* CHAT MESSAGES SCROLL AREA */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
              {activeMessages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center p-8">
                  <div className="h-12 w-12 rounded-2xl bg-muted/50 border border-border/60 flex items-center justify-center text-muted-foreground mb-4">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-base font-semibold">
                    Start Session with {activeAgent.name}
                  </h3>
                  <p className="text-xs text-muted-foreground max-w-sm mt-1 mb-6 leading-relaxed">
                    Powered by the {activeAgent.engine} engine. Run quantitative indicators, risk checks, or execute trade proposals.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSend("Analyze BTC/USDT 15m RSI and MACD")}
                      className="text-xs border-border/60 hover:bg-accent"
                    >
                      📈 Analyze BTC 15m Indicators
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSend("Generate scalp trade proposal for BTC")}
                      className="text-xs border-border/60 hover:bg-accent"
                    >
                      ⚡ Generate Trade Proposal
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSend("Audit portfolio risk and drawdown")}
                      className="text-xs border-border/60 hover:bg-accent"
                    >
                      🛡️ Audit Portfolio Risk
                    </Button>
                  </div>
                </div>
              )}

              {activeMessages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-3 ${
                      isUser ? "justify-end" : "justify-start"
                    }`}
                  >
                    {!isUser && (
                      <Avatar className="h-8 w-8 border border-border/40 shrink-0 mt-0.5">
                        <AvatarFallback
                          className={`${
                            msg.agentColor || activeAgent.avatarColor
                          } text-white font-bold text-xs`}
                        >
                          {(msg.agentName || activeAgent.name)
                            .slice(0, 2)
                            .toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    )}

                    <div
                      className={`space-y-2 max-w-[85%] md:max-w-[75%] ${
                        isUser ? "items-end" : ""
                      }`}
                    >
                      {!isUser && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-foreground">
                            {msg.agentName || activeAgent.name}
                          </span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {msg.timestamp}
                          </span>
                        </div>
                      )}

                      {/* THINKING / REASONING ACCORDION */}
                      {msg.reasoning && (
                        <Card className="border-blue-500/30 bg-blue-950/20 p-3 space-y-1">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>Agent Chain of Thought</span>
                          </div>
                          <div className="text-xs text-blue-300/80 font-mono whitespace-pre-wrap leading-relaxed">
                            {msg.reasoning}
                          </div>
                        </Card>
                      )}

                      {/* TOOL CALLS ACCORDION */}
                      {msg.tools && msg.tools.length > 0 && (
                        <div className="space-y-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setOpenTools((prev) => ({
                                ...prev,
                                [msg.id]: !prev[msg.id],
                              }))
                            }
                            className="h-7 text-xs gap-1.5 border-border/60 bg-muted/30"
                          >
                            <Terminal className="h-3 w-3 text-emerald-400" />
                            <span>Executed {msg.tools.length} Tools</span>
                            <ChevronDown
                              className={`h-3 w-3 transition-transform ${
                                openTools[msg.id] ? "rotate-180" : ""
                              }`}
                            />
                          </Button>

                          {openTools[msg.id] && (
                            <Card className="p-2 space-y-1 bg-card/80 border-border/50">
                              {msg.tools.map((tool) => (
                                <div
                                  key={tool.id}
                                  className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/40 font-mono"
                                >
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`h-2 w-2 rounded-full ${
                                        tool.status === "done"
                                          ? "bg-emerald-400"
                                          : tool.status === "failed"
                                          ? "bg-destructive"
                                          : "bg-amber-400 animate-ping"
                                      }`}
                                    />
                                    <span>{tool.name}</span>
                                  </div>
                                  <Badge
                                    variant={
                                      tool.status === "done"
                                        ? "success"
                                        : tool.status === "failed"
                                        ? "destructive"
                                        : "warning"
                                    }
                                    className="text-[9px] px-1 py-0 h-4 uppercase"
                                  >
                                    {tool.status}
                                  </Badge>
                                </div>
                              ))}
                            </Card>
                          )}
                        </div>
                      )}

                      {/* MAIN MESSAGE CONTENT */}
                      {msg.content && (
                        <Card
                          className={`p-3.5 text-sm leading-relaxed border shadow-sm ${
                            isUser
                              ? "bg-primary text-primary-foreground border-transparent rounded-2xl rounded-br-sm"
                              : "bg-card border-border/60 text-card-foreground rounded-2xl rounded-tl-sm"
                          }`}
                        >
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        </Card>
                      )}

                      {/* TRADE PROPOSAL CARD */}
                      {msg.proposal && (
                        <Card className="border-emerald-500/40 bg-emerald-950/20 overflow-hidden shadow-lg p-4 space-y-3">
                          <div className="flex items-center justify-between border-b border-emerald-500/20 pb-2.5">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={
                                  msg.proposal.side.toUpperCase() === "BUY"
                                    ? "success"
                                    : "destructive"
                                }
                                className="font-bold text-xs px-2"
                              >
                                {msg.proposal.side.toUpperCase()}
                              </Badge>
                              <span className="font-bold text-sm">
                                {msg.proposal.quantity} {msg.proposal.symbol}
                              </span>
                            </div>

                            <Badge variant="cyan" className="text-[10px]">
                              Risk: {msg.proposal.decision}
                            </Badge>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-xs font-mono text-muted-foreground">
                            <div>Type: {msg.proposal.orderType}</div>
                            <div>Paper Status: {msg.proposal.paperExecution}</div>
                          </div>

                          {msg.proposal.reason && (
                            <p className="text-xs italic text-muted-foreground/90 border-l-2 border-emerald-500/40 pl-2">
                              "{msg.proposal.reason}"
                            </p>
                          )}

                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              variant="default"
                              size="sm"
                              className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
                              onClick={() => {
                                handleSend(
                                  `Confirm and execute paper trade for ${msg.proposal?.quantity} ${msg.proposal?.symbol}`
                                );
                              }}
                            >
                              <Check className="h-3.5 w-3.5" />
                              Execute Paper Order
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs border-border/60"
                              onClick={() => {
                                handleSend("Cancel trade proposal");
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        </Card>
                      )}
                    </div>
                  </div>
                );
              })}

              {isTyping && (
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8 border border-border/40">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                      FA
                    </AvatarFallback>
                  </Avatar>
                  <Card className="px-3.5 py-2.5 bg-card border-border/50 text-xs text-muted-foreground flex items-center gap-2 rounded-2xl">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 bg-primary rounded-full animate-bounce" />
                      <span className="h-1.5 w-1.5 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
                      <span className="h-1.5 w-1.5 bg-primary rounded-full animate-bounce [animation-delay:0.4s]" />
                    </span>
                    <span>Analyzing data with {activeAgent.engine}...</span>
                  </Card>
                </div>
              )}
            </div>

            {/* CHAT INPUT DOCK */}
            <div className="p-4 border-t border-border/40 bg-card/30 backdrop-blur">
              <Card className="border-border/60 bg-background/80 shadow-md overflow-hidden focus-within:ring-1 focus-within:ring-ring">
                <Textarea
                  ref={textareaRef}
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={`Instruct ${activeAgent.name} (e.g. Analyze BTC RSI, create trade proposal, inspect risk)...`}
                  className="min-h-[50px] max-h-36 border-none bg-transparent p-3 text-sm focus-visible:ring-0 resize-none"
                />

                <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/10">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-mono gap-1">
                      <Cpu className="h-2.5 w-2.5 text-emerald-400" />
                      {activeAgent.engine}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground hidden sm:inline">
                      Press Enter to send, Shift+Enter for newline
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="default"
                      size="icon"
                      disabled={!inputVal.trim() || isTyping}
                      onClick={() => handleSend()}
                      className="h-8 w-8 rounded-lg shadow-sm"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </main>

          {/* RIGHT INSPECTOR PANEL */}
          {isInspectorOpen && (
            <aside className="w-80 shrink-0 border-l border-border/40 bg-card/40 flex flex-col min-h-0">
              <div className="h-14 border-b border-border/40 flex items-center justify-between px-4">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Telemetry</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsInspectorOpen(false)}
                  className="h-7 w-7"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              <ScrollArea className="flex-1 p-4 space-y-4">
                <div className="space-y-4">
                  {/* Realtime Orderbook Ticks */}
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Live Market Ticks
                    </div>
                    <Card className="p-3 border-border/50 bg-card/60 space-y-2">
                      {ticks.slice(0, 5).map((t, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between text-xs font-mono"
                        >
                          <span className="font-bold">{t.symbol}</span>
                          <span>${safePrice(t.price)}</span>
                          <span
                            className={
                              safeChangePercent(t) >= 0
                                ? "text-emerald-400"
                                : "text-destructive"
                            }
                          >
                            {safeChangePercent(t) >= 0 ? "+" : ""}
                            {safeChangePercent(t).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </Card>
                  </div>

                  {/* Engine Telemetry */}
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Engine Diagnostics
                    </div>
                    <Card className="p-3 border-border/50 bg-card/60 space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Active Engine:</span>
                        <span className="font-mono">{activeAgent.engine}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Model:</span>
                        <span className="font-mono">{activeAgent.model}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Status:</span>
                        <Badge variant="success" className="text-[10px] h-4">
                          OK
                        </Badge>
                      </div>
                    </Card>
                  </div>
                </div>
              </ScrollArea>
            </aside>
          )}
        </div>

        {/* CREATE AGENT DIALOG (shadcn Dialog) */}
        <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create Autonomous Finance Agent</DialogTitle>
              <DialogDescription>
                Configure a new quantitative or risk agent backed by your chosen engine.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Agent Name
                </label>
                <Input
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="e.g. ETH Momentum Scalper"
                  className="mt-1 h-9"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Engine
                  </label>
                  <select
                    value={newAgentEngine}
                    onChange={(e) => setNewAgentEngine(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm mt-1 outline-none"
                  >
                    <option value="opencode-cli">OpenCode (CLI)</option>
                    <option value="ollama-local">Ollama (Local)</option>
                    <option value="openai-gpt4">OpenAI (Cloud)</option>
                    <option value="qwen-cli">Qwen (CLI)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Model
                  </label>
                  <Input
                    value={newAgentModel}
                    onChange={(e) => setNewAgentModel(e.target.value)}
                    placeholder="e.g. qwen2.5-coder"
                    className="mt-1 h-9 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  System Prompt
                </label>
                <Textarea
                  value={newAgentPrompt}
                  onChange={(e) => setNewAgentPrompt(e.target.value)}
                  rows={3}
                  className="mt-1 text-xs"
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-muted/20">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">Trade Execution</div>
                  <div className="text-[10px] text-muted-foreground">
                    Allow agent to construct trade proposals
                  </div>
                </div>
                <Switch
                  checked={newAgentExecutionPerm}
                  onCheckedChange={setNewAgentExecutionPerm}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsCreateModalOpen(false)}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleCreateAgentSubmit()}
                disabled={!newAgentName.trim()}
                className="text-xs"
              >
                Create Agent
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ENGINE SETTINGS DIALOG (shadcn Dialog) */}
        <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-primary" />
                <span>Engine & Provider Registry</span>
              </DialogTitle>
              <DialogDescription>
                Manage CLI binaries, paths, and local model providers.
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[60vh] pr-2">
              <div className="space-y-3 py-2">
                {enginesList.map((eng) => (
                  <Card key={eng.id} className="p-3 border-border/60 bg-card/60 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-xs flex items-center gap-2">
                        <span>{eng.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          ({eng.kind})
                        </span>
                      </div>
                      <Badge
                        variant={eng.found ? "success" : "secondary"}
                        className="text-[10px] h-4"
                      >
                        {eng.found ? "DETECTED" : "UNAVAILABLE"}
                      </Badge>
                    </div>

                    {eng.kind === "cli" && (
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-mono">
                          Executable Command / File Path:
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            value={
                              editingEnginePaths[eng.id] ??
                              eng.effectiveCommand ??
                              eng.command
                            }
                            onChange={(e) =>
                              setEditingEnginePaths((prev) => ({
                                ...prev,
                                [eng.id]: e.target.value,
                              }))
                            }
                            placeholder="e.g. opencode or C:\path\to\opencode.exe"
                            className="h-8 text-xs font-mono"
                          />
                          <Button
                            size="sm"
                            variant={
                              savedSuccessId === eng.id ? "default" : "outline"
                            }
                            onClick={() => void handleSaveEnginePath(eng.id)}
                            disabled={savingEngineId === eng.id}
                            className="h-8 text-xs shrink-0"
                          >
                            {savingEngineId === eng.id
                              ? "Saving..."
                              : savedSuccessId === eng.id
                              ? "Saved ✓"
                              : "Save Path"}
                          </Button>
                        </div>
                      </div>
                    )}

                    {eng.path && (
                      <div className="text-[10px] text-muted-foreground font-mono truncate">
                        Resolved: {eng.path}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            </ScrollArea>

            <DialogFooter>
              <Button onClick={() => setIsSettingsOpen(false)} className="text-xs">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

export default App;
