"use client";
import OrdersPanel from "@/components/OrdersPanel";
import TradeForm from "@/components/TradeForm";
import type { FinanceEvent } from "@/lib/api";
import { useEffect, useState } from "react";
import { fetchExecutionStatus } from "@/lib/desktop-api";

export function PaperTradingPanel({ events }: { events: FinanceEvent[] }) {
  const [exec, setExec] = useState<unknown>(null);
  useEffect(()=>{ fetchExecutionStatus().then(setExec).catch(()=>{}); const id=setInterval(()=>fetchExecutionStatus().then(setExec).catch(()=>{}), 7000); return ()=>clearInterval(id); }, []);
  const execEvents = events.filter(e=>e.type.startsWith("execution.") || e.type.startsWith("pipeline.") || e.type.startsWith("paper.")).slice(0,8);
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <h2 className="text-sm font-bold tracking-tight">Paper Trading Status</h2>
      <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
        <div className="text-[11px] opacity-60 font-semibold tracking-widest mb-1">EXECUTION MODE</div>
        <pre className="text-xs opacity-80 whitespace-pre-wrap break-words">{exec?JSON.stringify(exec as Record<string,unknown>,null,2).slice(0,800):"loading /api/execution/status …"}</pre>
        <div className="text-[11px] opacity-40 mt-1">Paper-only • liveTradingEnabled=false default • pipeline audit via TypedEventBus</div>
      </div>
      {execEvents.length>0 && (
        <div className="space-y-1.5 max-h-[200px] overflow-auto pr-1">
          {execEvents.map(e=>(
            <div key={e.id} className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
              <div className="text-[10px] font-bold tracking-widest text-emerald-300">{e.type}</div>
              <div className="text-xs opacity-80 break-words">{JSON.stringify(e.data).slice(0,160)}</div>
            </div>
          ))}
        </div>
      )}
      <OrdersPanel />
      <TradeForm />
    </div>
  );
}
