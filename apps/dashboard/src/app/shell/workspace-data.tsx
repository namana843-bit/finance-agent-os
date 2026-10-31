import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectEvents,
  fetchAgents,
  fetchHealth,
  fetchPortfolio,
  fetchWorkflows,
  type AgentApiConfig,
  type FinanceEvent,
  type Health,
  type Portfolio,
  type WorkflowRun,
} from "../../lib/api";
import { fetchJson } from "../../lib/fetch";

export type ProviderInfo = {
  id: string;
  name: string;
  kind: "cli" | "api";
  engines: string[];
  health: { status: string; message?: string };
  adapter?: {
    id: string;
    executable: string;
    installed: boolean;
    resolvedPath: string | null;
    supportsStreaming?: boolean;
    installHint?: string;
  } | null;
};

export type ThreadInfo = {
  id: string;
  title: string;
  channelId?: string;
  botId?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  messageCount?: number;
};

/** Parse a timestamp that may be an ISO string, an epoch number, or missing. */
export function toMillis(value: string | number | undefined | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "system" | string;
  content: string;
  timestamp?: string | number;
  botId?: string;
};

export type ResearchEntry = {
  id: string;
  agentId: string;
  category: string;
  key: string;
  value: unknown;
  timestamp: number;
};

export type ActivityItem = {
  id: string;
  kind: "event" | "run" | "approval";
  title: string;
  detail?: string;
  timestamp: number;
  tone: "neutral" | "good" | "warn" | "bad";
};

export type LoadState = "loading" | "ready" | "empty" | "error";

export type WorkspaceData = {
  agents: AgentApiConfig[];
  agentsState: LoadState;
  agentsError: string;
  runs: WorkflowRun[];
  runsState: LoadState;
  runsError: string;
  portfolio: Portfolio | null;
  portfolioState: LoadState;
  portfolioError: string;
  health: Health | null;
  serverState: LoadState;
  providers: ProviderInfo[];
  providersState: LoadState;
  providersError: string;
  threads: ThreadInfo[];
  threadsState: LoadState;
  threadsError: string;
  research: ResearchEntry[];
  researchState: LoadState;
  researchError: string;
  activity: ActivityItem[];
  lastUpdated: number | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceData | null>(null);

const KNOWN_EVENT_LABELS: Record<string, string> = {
  "market.tick": "Market tick",
  "market.candle": "Market candle",
  "quant.signal": "Quant signal",
  "risk.alert": "Risk alert",
  "risk.check": "Risk check",
  "portfolio.update": "Portfolio update",
  "execution.order": "Order event",
  "execution.fill": "Fill",
  "agent.status": "Agent status",
  "system.heartbeat": "Heartbeat",
  publish: "Channel event",
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runTimestamp(run: WorkflowRun): number {
  const value = Date.parse(run.updatedAt ?? run.createdAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function runActivity(run: WorkflowRun): ActivityItem {
  const stamp = runTimestamp(run);
  const base = {
    id: `run-${run.id}`,
    kind: "run" as const,
    timestamp: stamp,
    title: run.proposal
      ? `${run.proposal.side.toUpperCase()} ${run.proposal.quantity} ${run.proposal.symbol}`
      : `Workflow run ${run.id.slice(0, 8)}`,
    detail: `${run.stage} · ${run.status.replace(/_/g, " ")}`,
  };
  switch (run.status) {
    case "completed":
      return { ...base, tone: "good" };
    case "failed":
      return { ...base, tone: "bad" };
    case "awaiting_approval":
      return { ...base, tone: "warn", kind: "approval" };
    case "user_rejected":
      return { ...base, tone: "neutral" };
    default:
      return { ...base, tone: "neutral" };
  }
}

function eventLabel(event: FinanceEvent): string {
  const raw = KNOWN_EVENT_LABELS[event.type] ?? event.type;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const symbol = typeof data.symbol === "string" ? data.symbol : undefined;
  return symbol ? `${raw} · ${symbol}` : raw;
}

function eventTone(type: string): ActivityItem["tone"] {
  if (type.startsWith("risk.")) return "warn";
  if (type === "execution.order" || type === "execution.fill") return "good";
  if (type === "system.heartbeat") return "neutral";
  return "neutral";
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentApiConfig[]>([]);
  const [agentsState, setAgentsState] = useState<LoadState>("loading");
  const [agentsError, setAgentsError] = useState("");

  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsState, setRunsState] = useState<LoadState>("loading");
  const [runsError, setRunsError] = useState("");

  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioState, setPortfolioState] = useState<LoadState>("loading");
  const [portfolioError, setPortfolioError] = useState("");

  const [health, setHealth] = useState<Health | null>(null);
  const [serverState, setServerState] = useState<LoadState>("loading");

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersState, setProvidersState] = useState<LoadState>("loading");
  const [providersError, setProvidersError] = useState("");

  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [threadsState, setThreadsState] = useState<LoadState>("loading");
  const [threadsError, setThreadsError] = useState("");

  const [research, setResearch] = useState<ResearchEntry[]>([]);
  const [researchState, setResearchState] = useState<LoadState>("loading");
  const [researchError, setResearchError] = useState("");

  const [liveActivity, setLiveActivity] = useState<ActivityItem[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);

    const [healthResult, agentsResult, runsResult, portfolioResult, providersResult, threadsResult, researchResult] =
      await Promise.allSettled([
        fetchHealth(),
        fetchAgents(),
        fetchWorkflows(),
        fetchPortfolio(),
        fetchJson<{ providers: ProviderInfo[] }>("/api/agent-runtime/providers"),
        fetchJson<{ threads: ThreadInfo[] }>("/api/threads"),
        fetchJson<{ entries: ResearchEntry[] }>("/api/memory/entries?agentId=supervisor&category=research&limit=12"),
      ]);

    if (!mounted.current) return;

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setServerState("ready");
    } else {
      setHealth(null);
      setServerState("error");
    }

    if (agentsResult.status === "fulfilled") {
      const list = agentsResult.value.agents ?? [];
      setAgents(list);
      setAgentsState(list.length ? "ready" : "empty");
      setAgentsError("");
    } else {
      setAgents([]);
      setAgentsState("error");
      setAgentsError(errorText(agentsResult.reason));
    }

    if (runsResult.status === "fulfilled") {
      const list = runsResult.value.runs ?? [];
      setRuns(list);
      setRunsState(list.length ? "ready" : "empty");
      setRunsError("");
    } else {
      setRuns([]);
      setRunsState("error");
      setRunsError(errorText(runsResult.reason));
    }

    if (portfolioResult.status === "fulfilled") {
      setPortfolio(portfolioResult.value);
      setPortfolioState("ready");
      setPortfolioError("");
    } else {
      setPortfolio(null);
      setPortfolioState("error");
      setPortfolioError(errorText(portfolioResult.reason));
    }

    if (providersResult.status === "fulfilled") {
      const list = providersResult.value.providers ?? [];
      setProviders(list);
      setProvidersState(list.length ? "ready" : "empty");
      setProvidersError("");
    } else {
      setProviders([]);
      setProvidersState("error");
      setProvidersError(errorText(providersResult.reason));
    }

    if (threadsResult.status === "fulfilled") {
      const list = threadsResult.value.threads ?? [];
      setThreads(list);
      setThreadsState(list.length ? "ready" : "empty");
      setThreadsError("");
    } else {
      setThreads([]);
      setThreadsState("error");
      setThreadsError(errorText(threadsResult.reason));
    }

    if (researchResult.status === "fulfilled") {
      const list = researchResult.value.entries ?? [];
      setResearch(list);
      setResearchState(list.length ? "ready" : "empty");
      setResearchError("");
    } else {
      setResearch([]);
      setResearchState("error");
      setResearchError(errorText(researchResult.reason));
    }

    setLastUpdated(Date.now());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const handle = connectEvents(
      (event) => {
        if (event.type === "system.heartbeat") return;
        setLiveActivity((prev) =>
          [
            {
              id: `event-${event.id}`,
              kind: "event" as const,
              title: eventLabel(event),
              detail: event.agentId ? `agent ${event.agentId}` : event.channelId ? `#${event.channelId}` : undefined,
              timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
              tone: eventTone(event.type),
            },
            ...prev,
          ].slice(0, 40),
        );
      },
      undefined,
      { replay: true, limit: 20 },
    );
    return () => {
      handle?.close();
    };
  }, []);

  const activity = useMemo(() => {
    const fromRuns = runs.map(runActivity);
    return [...liveActivity, ...fromRuns].sort((a, b) => b.timestamp - a.timestamp).slice(0, 24);
  }, [liveActivity, runs]);

  const value: WorkspaceData = {
    agents,
    agentsState,
    agentsError,
    runs,
    runsState,
    runsError,
    portfolio,
    portfolioState,
    portfolioError,
    health,
    serverState,
    providers,
    providersState,
    providersError,
    threads,
    threadsState,
    threadsError,
    research,
    researchState,
    researchError,
    activity,
    lastUpdated,
    refreshing,
    refresh,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceData {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const delta = Date.now() - timestamp;
  if (delta < 0 || Number.isNaN(delta)) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function agentInitials(name: string): string {
  return (
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "AI"
  );
}

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25",
  "bg-sky-500/15 text-sky-300 ring-sky-500/25",
  "bg-violet-500/15 text-violet-300 ring-violet-500/25",
  "bg-amber-500/15 text-amber-300 ring-amber-500/25",
  "bg-rose-500/15 text-rose-300 ring-rose-500/25",
  "bg-teal-500/15 text-teal-300 ring-teal-500/25",
];

export function avatarTone(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function runStatusTone(status: WorkflowRun["status"]): {
  label: string;
  className: string;
  dot: string;
} {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-sky-500/10 text-sky-300 border-sky-500/30",
        dot: "bg-sky-400",
      };
    case "awaiting_approval":
      return {
        label: "Awaiting approval",
        className: "bg-amber-500/10 text-amber-300 border-amber-500/30",
        dot: "bg-amber-400",
      };
    case "completed":
      return {
        label: "Completed",
        className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
        dot: "bg-emerald-400",
      };
    case "user_rejected":
      return {
        label: "Rejected",
        className: "bg-white/5 text-neutral-400 border-white/10",
        dot: "bg-neutral-500",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-rose-500/10 text-rose-300 border-rose-500/30",
        dot: "bg-rose-400",
      };
    default:
      return {
        label: String(status),
        className: "bg-white/5 text-neutral-400 border-white/10",
        dot: "bg-neutral-500",
      };
  }
}

export type { AgentApiConfig, FinanceEvent, Health, Portfolio, WorkflowRun };
