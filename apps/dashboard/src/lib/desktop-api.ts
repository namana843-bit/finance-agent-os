// Finance Agent Desktop — extended API helpers (no backend rewrite, reuses existing routes)
import { API_BASE } from "./api";

export async function publishEvent(event: { type: string; data?: unknown; agentId?: string; channelId?: string; threadId?: string; runId?: string }): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `${res.status} ${res.statusText}`);
  return j.event ?? j;
}

export function supervisorTask(task: string, opts?: { symbol?: string; agentId?: string }) {
  // SupervisorAgent listens to supervisor.task via TypedEventBus.
  // No dedicated HTTP route yet — publish directly to the bus.
  // Keep UI modular: callers only need this helper, not raw bus details.
  return publishEvent({
    type: "supervisor.task",
    data: { task, symbol: opts?.symbol, source: "desktop" },
    agentId: opts?.agentId ?? "desktop",
  });
}

export function terminalCommand(command: string, opts?: { agentId?: string }) {
  return publishEvent({ type: "terminal.command", data: { command, ts: Date.now(), source: "desktop" }, agentId: opts?.agentId ?? "desktop-terminal" });
}

export async function fetchRiskStatus(): Promise<unknown> {
  const r = await fetch(`${API_BASE}/api/risk/status`, { cache: "no-store" });
  return r.json();
}
export async function fetchRiskMetrics(): Promise<unknown> {
  const r = await fetch(`${API_BASE}/api/risk/metrics`, { cache: "no-store" });
  return r.json();
}
export async function fetchGatewayStats(): Promise<unknown> {
  const r = await fetch(`${API_BASE}/api/gateway/stats`, { cache: "no-store" });
  return r.json();
}
export async function fetchExecutionStatus(): Promise<unknown> {
  const r = await fetch(`${API_BASE}/api/execution/status`, { cache: "no-store" });
  return r.json();
}
