import { fetchJson } from "./fetch";

export interface Bot {
  id: string;
  name: string;
  avatar: string;
  agentId: string;
  account: string;
  personality?: string;
}

export interface ChatThread {
  id: string;
  channelId: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  channelId: string;
  role: string;
  content: string;
  timestamp: number;
  agentId?: string;
  data?: unknown;
}

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

export interface TradeProposal {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price?: number | null;
  status: ProposalStatus;
  reason?: string;
  createdAt: number;
  expiresAt?: number;
  result?: unknown;
}



export async function fetchBots(): Promise<Bot[]> {
  const data = await fetchJson<{ bots: Bot[] }>("/api/bots");
  return data.bots;
}

export async function fetchThreads(channelId?: string): Promise<ChatThread[]> {
  const qs = channelId
    ? `?${new URLSearchParams({ channelId }).toString()}`
    : "";
  const data = await fetchJson<{ threads: ChatThread[] }>(
    `/api/threads${qs}`
  );
  return data.threads;
}

export async function createThread(
  title: string,
  botId?: string
): Promise<ChatThread> {
  const data = await fetchJson<{ ok: boolean; thread: ChatThread }>(
    "/api/threads",
    {
      method: "POST",
      body: JSON.stringify({ title, ...(botId ? { botId } : {}) }),
    }
  );
  return data.thread;
}

export async function fetchMessages(
  threadId: string,
  limit = 100
): Promise<ChatMessage[]> {
  const qs = `?${new URLSearchParams({ limit: String(limit) }).toString()}`;
  const data = await fetchJson<{ messages: ChatMessage[] }>(
    `/api/threads/${encodeURIComponent(threadId)}/messages${qs}`
  );
  return data.messages;
}

export async function sendChatMessage(
  message: string,
  threadId?: string,
  title?: string
): Promise<{
  thread: ChatThread;
  message: ChatMessage;
  planId: string | null;
}> {
  const data = await fetchJson<{
    ok: boolean;
    thread: ChatThread;
    message: ChatMessage;
    planId: string | null;
  }>("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      ...(threadId ? { threadId } : {}),
      ...(title ? { title } : {}),
    }),
  });
  return { thread: data.thread, message: data.message, planId: data.planId };
}

export async function fetchProposals(
  status?: string
): Promise<TradeProposal[]> {
  const qs = status
    ? `?${new URLSearchParams({ status }).toString()}`
    : "";
  const data = await fetchJson<{ proposals: TradeProposal[] }>(
    `/api/proposals${qs}`
  );
  return data.proposals;
}

export async function approveProposal(
  id: string
): Promise<{ proposal: TradeProposal }> {
  const data = await fetchJson<{ ok: boolean; proposal: TradeProposal }>(
    `/api/proposals/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({}) }
  );
  return { proposal: data.proposal };
}

export async function rejectProposal(
  id: string
): Promise<{ proposal: TradeProposal }> {
  const data = await fetchJson<{ ok: boolean; proposal: TradeProposal }>(
    `/api/proposals/${encodeURIComponent(id)}/reject`,
    { method: "POST", body: JSON.stringify({}) }
  );
  return { proposal: data.proposal };
}
