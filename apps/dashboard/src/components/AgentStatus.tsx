"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

type AgentId = "market" | "quant" | "risk" | "portfolio" | "execution";
type AgentInfo = {
  id: AgentId;
  name: string;
  role: string;
  status: "online" | "offline" | "busy" | "error";
  latencyMs?: number;
  lastSignal?: string;
  updatedAt?: number;
};

const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "market", name: "Market Agent", role: "ticks • candles • orderbook", status: "offline", latencyMs: 0, lastSignal: "waiting for /api/agents" },
  { id: "quant", name: "Quant Agent", role: "signals • strategies", status: "offline", latencyMs: 0, lastSignal: "—" },
  { id: "risk", name: "Risk Agent", role: "exposure • drawdown • limits", status: "offline", latencyMs: 0, lastSignal: "—" },
  { id: "portfolio", name: "Portfolio Agent", role: "allocation • PnL • holdings", status: "offline", latencyMs: 0, lastSignal: "—" },
  { id: "execution", name: "Execution Agent", role: "orders • fills • broker", status: "offline", latencyMs: 0, lastSignal: "—" },
];

const STATUS_COLOR: Record<AgentInfo["status"], string> = {
  online: "#22c55e",
  busy: "#eab308",
  offline: "#6b7280",
  error: "#ef4444",
};

export default function AgentStatus() {
  const [agents, setAgents] = useState<AgentInfo[]>(FALLBACK_AGENTS);
  const [health, setHealth] = useState<string>("loading");

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [healthRes, agentsRes] = await Promise.all([
          fetch(`${API_BASE}/api/health`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/agents`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        const data = healthRes.ok ? await healthRes.json() : null;
        if (cancelled) return;
        if (data) setHealth(data.status ?? "ok");
        if (agentsRes?.agents?.length) {
          const mapped: AgentInfo[] = agentsRes.agents.map((a: { id: string; name: string; description?: string; status?: string }) => ({
            id: a.id as AgentId,
            name: a.name,
            role: (a.description ?? "").slice(0, 32) || a.id,
            status: (a.status === "running" ? "online" : a.status === "error" ? "error" : a.status === "stopped" ? "offline" : "online") as AgentInfo["status"],
            latencyMs: undefined,
            lastSignal: a.status ?? "—",
            updatedAt: Date.now(),
          }));
          setAgents(mapped);
        } else if (data?.status === "ok") {
          setAgents((prev) => prev.map((a) => ({ ...a, status: "online" as const, updatedAt: Date.now() })));
        }
      } catch {
        if (!cancelled) setHealth("offline");
      }
    }
    poll();
    const id = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // listen to SSE agent.status events
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const es = new EventSource(`${API_BASE}/api/events?type=agent.status&replay=false`);
    const handler = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as { agentId?: string; data?: unknown; timestamp?: number };
        const aid = (ev.agentId as AgentId) ?? "market";
        setAgents((prev) =>
          prev.map((a) =>
            a.id === aid
              ? {
                  ...a,
                  status: "online",
                  lastSignal: typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data).slice(0, 60),
                  updatedAt: ev.timestamp ?? Date.now(),
                }
              : a
          )
        );
      } catch {}
    };
    es.addEventListener("agent.status", handler as EventListener);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse((m as MessageEvent).data);
        if (parsed?.type === "agent.status") handler(m as unknown as MessageEvent);
      } catch {}
    };
    return () => es.close();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, margin: 0 }}>Agents</h3>
        <span
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 999,
            background: health === "ok" ? "rgba(34,197,94,0.15)" : health === "offline" ? "rgba(239,68,68,0.15)" : "rgba(234,179,8,0.15)",
            color: health === "ok" ? "#22c55e" : health === "offline" ? "#ef4444" : "#eab308",
            border: "1px solid rgba(255,255,255,0.08)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontWeight: 700,
          }}
        >
          {health}
        </span>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {agents.map((a) => (
          <div
            key={a.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <span
              aria-label={a.status}
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: STATUS_COLOR[a.status],
                boxShadow: `0 0 10px ${STATUS_COLOR[a.status]}80`,
                flexShrink: 0,
                animation: a.status === "online" ? "pulse 2s infinite" : undefined,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 650, lineHeight: 1.1 }}>{a.name}</div>
              <div style={{ fontSize: 10.5, opacity: 0.55, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.role} • {a.lastSignal}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[a.status], textTransform: "uppercase", letterSpacing: 0.5 }}>
                {a.status}
              </div>
              <div style={{ fontSize: 10, opacity: 0.5 }}>{a.latencyMs ?? 0}ms</div>
            </div>
          </div>
        ))}
      </div>

      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  );
}
