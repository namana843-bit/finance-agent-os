"use client";
import AgentStatus from "@/components/AgentStatus";
import type { FinanceEvent } from "@/lib/api";

export function AgentWorkspace({ events }: { events: FinanceEvent[] }) {
  const sup = events.filter((e) => e.type.startsWith("supervisor.")).slice(0, 8);
  return (
    <div className="card p-4 space-y-4">
      <h2 className="text-sm font-bold tracking-tight">Agent Workspace</h2>
      <AgentStatus />
      {sup.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold opacity-60 tracking-widest">SUPERVISOR TRACE</div>
          <div className="space-y-1.5 max-h-[200px] overflow-auto pr-1">
            {sup.map((e) => (
              <div key={e.id} className="rounded-xl bg-violet-500/10 border border-violet-500/20 px-3 py-2">
                <div className="text-[11px] font-bold tracking-widest text-violet-300">{e.type}</div>
                <div className="text-xs opacity-80 break-words">{JSON.stringify(e.data).slice(0, 160)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
