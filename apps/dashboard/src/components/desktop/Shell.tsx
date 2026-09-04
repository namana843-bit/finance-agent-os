"use client";
import { useEffect, useState } from "react";
import { fetchPortfolio, fetchTicks, type Portfolio, type Tick, type FinanceEvent } from "@/lib/api";
import { useFinanceEvents } from "@/lib/useFinanceEvents";
import { ChatPanel } from "./ChatPanel";
import { AgentWorkspace } from "./AgentWorkspace";
import { ToolActivity } from "./ToolActivity";
import { MarketPanel } from "./MarketPanel";
import { StrategyPanel } from "./StrategyPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { RiskPanel } from "./RiskPanel";
import { PaperTradingPanel } from "./PaperTradingPanel";
import { TerminalPanel } from "./TerminalPanel";
import { API_BASE } from "@/lib/api";

export function DesktopShell() {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [healthOk, setHealthOk] = useState<boolean|null>(null);
  const { events, connected } = useFinanceEvents(undefined, (ev)=>{
    if(ev.type==="market.tick" && typeof ev.data==="object" && ev.data) {
      const d = ev.data as Partial<Tick> & {symbol?:string; price?:number};
      if(d.symbol && typeof d.price==="number") setTicks(prev=>{
        const idx=prev.findIndex(t=>t.symbol===d.symbol);
        if(idx>=0){ const cp=[...prev]; cp[idx]={...cp[idx]!, price:d.price!, timestamp:ev.timestamp} as Tick; return cp; }
        return prev;
      });
    }
    if(ev.type==="portfolio.update" && ev.data) {
      const m=ev.data as Portfolio; if(m.totalValue) setPortfolio(m);
    }
  });

  useEffect(()=>{
    fetchPortfolio().then(setPortfolio).catch(()=>{});
    fetchTicks({limit:12}).then(r=>setTicks(r.ticks)).catch(()=>{});
    fetch(`${API_BASE}/api/health`,{cache:"no-store"}).then(r=>setHealthOk(r.ok)).catch(()=>setHealthOk(false));
    const i1=setInterval(()=>fetchTicks({limit:12}).then(r=>setTicks(r.ticks)).catch(()=>{}),5000);
    const i2=setInterval(()=>fetchPortfolio().then(setPortfolio).catch(()=>{}),7000);
    return ()=>{clearInterval(i1); clearInterval(i2);};
  },[]);

  const connState = connected ? "open" : "connecting";
  const [active, setActive] = useState<"overview"|"market"|"strategy"|"portfolio"|"risk"|"paper"|"terminal">("overview");

  return (
    <main className="mx-auto max-w-[1600px] px-3 sm:px-4 py-4 space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-black tracking-widest text-sm">FINANCE AGENT DESKTOP</span>
        <span className={`ml-2 px-2.5 py-1 rounded-full border font-semibold ${healthOk? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20":healthOk===false?"bg-red-500/10 text-red-400 border-red-500/20":"bg-white/5 border-white/10"}`}>API {healthOk? "● healthy":healthOk===false?"● unreachable":"○ checking"} — {API_BASE}</span>
        <span className={`px-2.5 py-1 rounded-full border ${connected?"bg-emerald-500/10 text-emerald-300 border-emerald-500/20":"bg-amber-500/10 text-amber-300 border-amber-500/20"}`}>SSE {connState} • {events.length} events</span>
        <span className="opacity-60 hidden sm:inline">OpenMausBot-inspired • modular panels • no backend rewrite</span>
      </div>

      {/* Nav */}
      <div className="flex flex-wrap gap-1.5">
        {(["overview","market","strategy","portfolio","risk","paper","terminal"] as const).map(t=>(
          <button key={t} onClick={()=>setActive(t)} className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-widest border ${active===t?"bg-violet-600 text-white border-violet-500":"bg-white/5 border-white/10 hover:bg-white/10"}`}>{t.toUpperCase()}</button>
        ))}
      </div>

      <ChatPanel />

      {active==="overview" ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-3 space-y-4 order-2 xl:order-1">
            <AgentWorkspace events={events} />
            <ToolActivity events={events} />
          </div>
          <div className="xl:col-span-6 space-y-4 order-1 xl:order-2">
            <MarketPanel ticks={ticks} onRefresh={()=>fetchTicks({limit:24}).then(r=>setTicks(r.ticks))} connState={connState} />
            <PortfolioPanel portfolio={portfolio} />
            <RiskPanel portfolio={portfolio} events={events} />
          </div>
          <div className="xl:col-span-3 space-y-4 order-3">
            <StrategyPanel events={events} />
            <PaperTradingPanel events={events} />
            <TerminalPanel events={events} />
          </div>
        </div>
      ) : active==="market" ? <MarketPanel ticks={ticks} onRefresh={()=>fetchTicks({limit:24}).then(r=>setTicks(r.ticks))} connState={connState} />
        : active==="strategy" ? <StrategyPanel events={events} />
        : active==="portfolio" ? <PortfolioPanel portfolio={portfolio} />
        : active==="risk" ? <RiskPanel portfolio={portfolio} events={events} />
        : active==="paper" ? <PaperTradingPanel events={events} />
        : <TerminalPanel events={events} />
      }

      <footer className="text-center text-[11px] opacity-30 py-3">Finance Agent OS • 5 agents • Market → Quant → Risk → Portfolio → Execution • {new Date().getFullYear()}</footer>
    </main>
  );
}
