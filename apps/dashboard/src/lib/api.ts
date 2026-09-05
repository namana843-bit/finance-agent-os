export const API_BASE = "http://localhost:4132";

export interface FinanceEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
  channelId?: string;
  agentId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  tools?: Array<{ id: string; name: string; status: "done" | "running" | "failed" }>;
  code?: { lang: string; code: string };
  approval?: { id: string; type: "file" | "shell" | "trade"; title: string; content: string };
  reactions?: string[];
}

export async function fetchHealth(): Promise<{ status: string; uptime: number }> {
  const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
  return res.json();
}

export async function fetchChatHistory(channelId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`${API_BASE}/api/chat/history?channelId=${channelId}&limit=100`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch {
    return [];
  }
}

export async function sendChatMessage(channelId: string, content: string, agentId?: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, content, agentId }),
  });
  return res.json();
}
