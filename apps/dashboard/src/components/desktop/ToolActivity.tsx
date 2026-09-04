"use client";
import type { FinanceEvent } from "@/lib/api";

export function ToolActivity({ events }: { events: FinanceEvent[] }) {
  const tools = events.filter((e) => e.type.startsWith("tool.") || e.type.startsWith("supervisor.") || e.type.includes("tool"));
  const recent = tools.slice(0, 20);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold tracking-tight">Tool Activity</h2>
        <span className="text-xs opacity-50">{recent.length} events</span>
      </div>
      {recent.length === 0 ? (
        <div className="text-xs opacity-40 text-center py-6 border border-dashed border-white/10 rounded-xl">No tool calls yet — run a task via Chat or wait for supervisor steps.</div>
      ) : (
        <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
          {recent.map((e) => (
            <div key={e.id} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-widest bg-amber-500/15 text-amber-300">{e.type.toUpperCase()}</span>
                <span className="text-[11px] opacity-50 ml-auto">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="text-xs mt-1 opacity-80 break-words line-clamp-3">{typeof e.data === "string" ? e.data : JSON.stringify(e.data).slice(0, 180)}</div>
              {e.agentId && <div className="text-[10px] opacity-40 mt-1">via {e.agentId}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
