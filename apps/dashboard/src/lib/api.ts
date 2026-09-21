// Finance Agent OS API client — merged HEAD (finance) + main (chat) + agent-runtime
import { fetchJson } from "./fetch";
export { API_BASE } from "./fetch";

export type Tick = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: number;
};

export type Portfolio = {
  timestamp: number;
  baseCurrency: string;
  totalValue: number;
  availableCash: number;
  pnl: { day: number; week: number; total: number; percentDay: number };
  holdings: Array<{ symbol: string; qty: number; avgPrice: number; price: number; value: number; pnl: number }>;
  positions: Array<{ symbol: string; side: "long" | "short"; qty: number; entry: number; mark: number; unrealizedPnl: number; leverage: number }>;
  risk: { exposure: number; maxDrawdown: number; sharpe: number; status: "ok" | "warn" | "breach" };
};

export type Health = { status: string; uptime: number; timestamp: number; version: string };

export type FinanceEvent = {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
  channelId?: string;
  threadId?: string;
  agentId?: string;
  runId?: string;
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  tools?: Array<{ id: string; name: string; status: "done" | "running" | "failed"; result?: unknown }>;
  code?: { lang: string; code: string };
  approval?: { id: string; type: "file" | "shell" | "trade"; title: string; content: string };
  reactions?: string[];
  reasoning?: string;
}

export interface AgentApiConfig {
  id: string;
  name: string;
  description?: string;
  role?: string;
  engine: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  permissions?: { execution?: boolean };
  riskPermissions?: { allowTradeProposals?: boolean; maxOrderSize?: number };
}

export interface EngineApiStatus {
  id: string;
  name: string;
  group: "cloud" | "local";
  kind: "cli" | "openai-compat";
  command: string;
  found: boolean;
  path?: string;
  overridden: boolean;
  effectiveCommand: string;
  version?: string;
  suggestedArgs?: string[];
}



export function fetchHealth(): Promise<Health> { return fetchJson<Health>("/api/health"); }
export function fetchPortfolio(): Promise<Portfolio> { return fetchJson<Portfolio>("/api/portfolio"); }
export function fetchTicks(params?: { limit?: number; symbol?: string }): Promise<{ ticks: Tick[]; timestamp: number }> {
  const q = new URLSearchParams();
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.symbol) q.set("symbol", params.symbol);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return fetchJson<{ ticks: Tick[]; timestamp: number }>(`/api/market/ticks${qs}`);
}
export function fetchState(): Promise<unknown> { return fetchJson<unknown>("/api/state"); }

// Agent Runtime API
export function fetchAgents(): Promise<{ agents: AgentApiConfig[] }> {
  return fetchJson<{ agents: AgentApiConfig[] }>("/api/agent-runtime/agents");
}

export function createAgent(config: AgentApiConfig): Promise<{ ok: boolean; agent: AgentApiConfig }> {
  return fetchJson<{ ok: boolean; agent: AgentApiConfig }>("/api/agent-runtime/agents", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function deleteAgentApi(id: string): Promise<{ ok: boolean; id: string }> {
  return fetchJson<{ ok: boolean; id: string }>(`/api/agent-runtime/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function exportAgentApi(id: string): Promise<{ ok: boolean; agent: unknown }> {
  return fetchJson<{ ok: boolean; agent: unknown }>(`/api/agent-runtime/agents/${encodeURIComponent(id)}/export`);
}

export function importAgentApi(agentJson: unknown): Promise<{ ok: boolean; agent: AgentApiConfig }> {
  return fetchJson<{ ok: boolean; agent: AgentApiConfig }>("/api/agent-runtime/agents/import", {
    method: "POST",
    body: JSON.stringify({ agentJson }),
  });
}

// Engine & Ollama API
export function fetchEnginesApi(): Promise<{ engines: EngineApiStatus[] }> {
  return fetchJson<{ engines: EngineApiStatus[] }>("/api/llm/engines");
}

export function fetchOllamaModelsApi(): Promise<{ available: boolean; models: Array<{ id: string; name: string }>; message?: string }> {
  return fetchJson<{ available: boolean; models: Array<{ id: string; name: string }>; message?: string }>("/api/ollama/models");
}

export function saveEngineCliOverride(id: string, command: string): Promise<{ ok: boolean; engine: EngineApiStatus }> {
  return fetchJson<{ ok: boolean; engine: EngineApiStatus }>(`/api/llm/engines/${encodeURIComponent(id)}/cli`, {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

// Streaming Agent Chat
export async function streamAgentChat(
  agentId: string,
  prompt: string,
  onEvent: (event: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent-runtime/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, prompt }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Streaming failed with status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const rawData = line.slice(6).trim();
        if (rawData) {
          try {
            const data = JSON.parse(rawData);
            onEvent({ type: currentEvent || data.type, ...data });
          } catch {
            // ignore non-json line
          }
        }
      }
    }
  }
}

export async function fetchChatHistory(channelId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`${API_BASE}/api/chat/history?channelId=${channelId}&limit=100`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch { return []; }
}

export async function sendChatMessage(channelId: string, content: string, agentId?: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/chat/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId, content, agentId }) });
  return res.json();
}

export type SSEOptions = { channelId?: string; threadId?: string; agentId?: string; type?: string; replay?: boolean; limit?: number };
export type SSEHandle = { source: EventSource; close: () => void };
export function connectEvents(onEvent: (ev: FinanceEvent) => void, onComment?: (comment: string) => void, opts: SSEOptions = {}): SSEHandle | null {
  if (typeof window === "undefined" || typeof EventSource === "undefined") { console.warn("[api] EventSource not available (SSR)"); return null; }
  const params = new URLSearchParams();
  if (opts.channelId) params.set("channelId", opts.channelId);
  if (opts.threadId) params.set("threadId", opts.threadId);
  if (opts.agentId) params.set("agentId", opts.agentId);
  if (opts.type) params.set("type", opts.type);
  if (opts.replay === false) params.set("replay", "false");
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${API_BASE}/api/events${qs}`;
  const es = new EventSource(url);
  es.onopen = () => { console.log("[sse] connected", url); onComment?.("connected"); };
  es.onerror = (err) => { console.warn("[sse] error", err); };
  es.onmessage = (msg: MessageEvent) => { try { const parsed = JSON.parse(msg.data); onEvent(parsed as FinanceEvent); } catch {} };
  const knownTypes = ["market.tick","market.candle","quant.signal","risk.alert","risk.check","portfolio.update","execution.order","execution.fill","agent.status","system.heartbeat","publish"];
  const listeners: Array<{ type: string; fn: (e: MessageEvent) => void }> = [];
  for (const t of knownTypes) { const fn = (e: MessageEvent) => { try { const parsed = JSON.parse((e as MessageEvent).data); onEvent(parsed as FinanceEvent); } catch {} }; es.addEventListener(t, fn as EventListener); listeners.push({ type: t, fn }); }
  const close = () => { for (const { type, fn } of listeners) { es.removeEventListener(type, fn as unknown as EventListener); } es.close(); };
  return { source: es, close };
}

export const fmtCurrency = (n: number, ccy = "USD") => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(n); } catch { return `${fmtNumber(n)} ${ccy}`; }
};
export const fmtNumber = (n: number, digits = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
export const fmtPercent = (n: number, digits = 2) => `${n > 0 ? "+" : ""}${fmtNumber(n, digits)}%`;
