"use client";
import BacktestPanel from "@/components/BacktestPanel";
import type { FinanceEvent } from "@/lib/api";

export function StrategyPanel({ events }: { events: FinanceEvent[] }) {
  const lab = events.filter(e=>e.type.startsWith("strategy-lab.") || e.type.startsWith("strategy.") || e.type.includes("backtest")).slice(0,8);
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <h2 className="text-sm font-bold tracking-tight">Strategy / Backtest Results</h2>
      <BacktestPanel />
      {lab.length>0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold opacity-60 tracking-widest">LAB EVENTS</div>
          <div className="space-y-1.5 max-h-[220px] overflow-auto pr-1">
            {lab.map(e=>(
              <div key={e.id} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2">
                <div className="text-[10px] font-bold tracking-widest text-violet-300">{e.type}</div>
                <div className="text-xs opacity-80 break-words">{JSON.stringify(e.data).slice(0,180)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
