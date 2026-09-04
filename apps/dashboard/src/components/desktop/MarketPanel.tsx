"use client";
import MarketChart from "@/components/MarketChart";
import MarketMeta from "@/components/MarketMeta";
import type { Tick } from "@/lib/api";
import { fmtCurrency, fmtPercent } from "@/lib/api";

export function MarketPanel({ ticks, onRefresh, connState }: { ticks: Tick[]; onRefresh: () => void; connState: string }) {
  const btc = ticks.find((t) => t.symbol === "BTCUSDT");
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-tight">Market Information</h2>
        <button onClick={onRefresh} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 text-xs">Refresh ticks</button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {(["BTCUSDT", "ETHUSDT", "AAPL"] as const).map((sym) => {
          const t = ticks.find((x) => x.symbol === sym || x.symbol === sym.replace("USDT", ""));
          return (
            <div key={sym} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2 flex items-center justify-between">
              <div>
                <div className="text-[11px] opacity-60 font-semibold">{sym}</div>
                <div className="text-sm font-bold tabular-nums">{t ? fmtCurrency(t.price) : "—"}</div>
              </div>
              <div className={`text-xs font-bold px-2 py-1 rounded-full border ${ (t?.changePercent ?? 0) >= 0 ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20" }`}>{t ? fmtPercent(t.changePercent) : "—"}</div>
            </div>
          );
        })}
      </div>
      <MarketChart symbol={btc?.symbol ?? "BTCUSDT"} data={ticks.filter(t=>t.symbol==="BTCUSDT").slice(0,24).map(t=>({t:t.timestamp, v:t.price}))} />
      <div className="text-xs opacity-40">SSE {connState} • {ticks.length} ticks • source {btc ? (btc as unknown as {source?:string}).source ?? "synthetic" : "—"}</div>
      <MarketMeta symbol={btc?.symbol ?? "BTCUSDT"} />
    </div>
  );
}
