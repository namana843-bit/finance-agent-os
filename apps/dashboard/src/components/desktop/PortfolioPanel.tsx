"use client";
import type { Portfolio } from "@/lib/api";
import { fmtCurrency, fmtPercent } from "@/lib/api";

export function PortfolioPanel({ portfolio }: { portfolio: Portfolio | null }) {
  const risk = portfolio?.risk;
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <h2 className="text-sm font-bold tracking-tight">Portfolio View</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
          <div className="text-[11px] opacity-60 font-semibold tracking-widest">TOTAL VALUE</div>
          <div className="text-2xl font-black tabular-nums mt-1">{portfolio ? fmtCurrency(portfolio.totalValue) : "— awaiting /api/portfolio"}</div>
          <div className="text-xs opacity-60 mt-1">{portfolio ? `${portfolio.baseCurrency} • ${new Date(portfolio.timestamp).toLocaleTimeString()}` : "paper $100k start"}</div>
        </div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
          <div className="text-[11px] opacity-60 font-semibold tracking-widest">AVAILABLE CASH</div>
          <div className="text-2xl font-black tabular-nums mt-1">{portfolio ? fmtCurrency(portfolio.availableCash) : "—"}</div>
          <div className={`text-xs font-bold mt-1 ${portfolio && portfolio.pnl.day>=0?"text-emerald-400":portfolio?"text-red-400":"opacity-40"}`}>{portfolio?`${fmtCurrency(portfolio.pnl.day)} today (${fmtPercent(portfolio.pnl.percentDay)})`:"no fills yet"}</div>
        </div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
          <div className="text-[11px] opacity-60 font-semibold tracking-widest">TOTAL PnL</div>
          <div className={`text-2xl font-black tabular-nums mt-1 ${!portfolio?"opacity-30":portfolio.pnl.total>=0?"text-emerald-400":"text-red-400"}`}>{portfolio?fmtCurrency(portfolio.pnl.total):"—"}</div>
          <div className="text-xs opacity-60 mt-1">{portfolio?`week ${fmtCurrency(portfolio.pnl.week)}`:"paper mode"}</div>
        </div>
      </div>
      {!portfolio || portfolio.holdings.length===0 ? (
        <div className="text-sm opacity-50 py-6 text-center border border-dashed border-white/10 rounded-xl">No positions yet — POST /api/gateway/trade or wait for signals.</div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm min-w-[520px]">
            <thead><tr className="text-[11px] tracking-widest opacity-50 border-b border-white/5"><th className="text-left py-2 px-4">Symbol</th><th className="text-right px-3">Qty</th><th className="text-right px-3">Avg</th><th className="text-right px-3">Mark</th><th className="text-right px-3">Value</th><th className="text-right px-4">PnL</th></tr></thead>
            <tbody>{portfolio.holdings.map(h=>(
              <tr key={h.symbol} className="border-b border-white/[0.04]"><td className="py-3 px-4 font-bold">{h.symbol}</td><td className="text-right px-3 tabular-nums">{h.qty}</td><td className="text-right px-3 opacity-70 tabular-nums">{fmtCurrency(h.avgPrice)}</td><td className="text-right px-3 tabular-nums">{fmtCurrency(h.price)}</td><td className="text-right px-3 font-semibold tabular-nums">{fmtCurrency(h.value)}</td><td className={`text-right px-4 font-bold tabular-nums ${h.pnl>=0?"text-emerald-400":"text-red-400"}`}>{fmtCurrency(h.pnl)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {risk && <div className="text-xs opacity-40">Risk {risk.status} • exposure {(risk.exposure*100).toFixed(1)}% • sharpe {risk.sharpe}</div>}
    </div>
  );
}
