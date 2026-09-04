"use client";
import { useEffect, useState } from "react";
import { fetchRiskStatus } from "@/lib/desktop-api";
import type { FinanceEvent, Portfolio } from "@/lib/api";

export function RiskPanel({ portfolio, events }: { portfolio: Portfolio | null; events: FinanceEvent[] }) {
  const [riskData, setRiskData] = useState<unknown>(null);
  useEffect(()=>{ fetchRiskStatus().then(setRiskData).catch(()=>{}); const id=setInterval(()=>fetchRiskStatus().then(setRiskData).catch(()=>{}), 7000); return ()=>clearInterval(id); }, []);
  const alerts = events.filter(e=>e.type.includes("risk")).slice(0,8);
  const risk = portfolio?.risk;
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <h2 className="text-sm font-bold tracking-tight">Risk Decisions</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3"><div className="text-[11px] opacity-60 font-semibold">EXPOSURE</div><div className="text-lg font-bold">{risk?`${(risk.exposure*100).toFixed(1)}%`:"—"}</div><div className="h-1.5 rounded-full bg-white/10 mt-2 overflow-hidden"><div className="h-full bg-violet-500" style={{width:`${(risk?.exposure??0)*100}%`}}/></div></div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3"><div className="text-[11px] opacity-60 font-semibold">DRAWDOWN</div><div className="text-lg font-bold">{risk?`${(risk.maxDrawdown*100).toFixed(1)}%`:"—"}</div><div className="text-[11px] opacity-50">limit 20%</div></div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3"><div className="text-[11px] opacity-60 font-semibold">SHARPE</div><div className="text-lg font-bold">{risk?.sharpe ?? "—"}</div></div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3"><div className="text-[11px] opacity-60 font-semibold">STATUS</div><div className={`inline-flex mt-1 px-2.5 py-1 rounded-full text-xs font-bold border ${risk?.status==="ok"?"bg-emerald-500/10 text-emerald-400 border-emerald-500/20":risk?.status==="warn"?"bg-amber-500/10 text-amber-400 border-amber-500/20":"bg-red-500/10 text-red-400 border-red-500/20"}`}>{(risk?.status??"ok").toUpperCase()}</div></div>
      </div>
      {alerts.length>0 && (
        <div className="space-y-1.5 max-h-[220px] overflow-auto pr-1">
          {alerts.map(e=>(
            <div key={e.id} className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2">
              <div className="text-[10px] font-bold tracking-widest text-amber-300">{e.type.toUpperCase()}</div>
              <div className="text-xs opacity-80 break-words">{JSON.stringify(e.data).slice(0,180)}</div>
            </div>
          ))}
        </div>
      )}
      {riskData ? <pre className="text-[11px] opacity-60 bg-black/30 border border-white/5 rounded-xl p-2 overflow-auto max-h-[120px]">{JSON.stringify(riskData,null,2).slice(0,1200)}</pre> : <div className="text-xs opacity-40">Fetching /api/risk/status …</div>}
    </div>
  );
}
