"use client";
import { useEffect, useState } from "react";
import { API_BASE, fmtCurrency, fmtPercent } from "@/lib/api";

type Strategy = { id: string; name: string; enabled: boolean };
type Result = { totalReturn: number; totalPnl: number; winRate: number; maxDrawdown: number; sharpeRatio: number; tradeCount: number; equityCurve: number[] };

export default function BacktestPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/backtest/strategies`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        const list: Strategy[] = j.strategies ?? [];
        setStrategies(list);
        if (list[0]) setSelected(list[0].id);
      })
      .catch(() => {});
  }, []);

  async function run() {
    if (!selected) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId: selected, symbol, timeframe: "1m", candles: 200 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      setResult(j.result as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight">Backtest</h3>
        <span className="text-xs opacity-50">{strategies.length} strategies</span>
      </div>
      <div className="flex gap-2">
        <select value={selected} onChange={(e) => setSelected(e.target.value)} className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10">
          {strategies.map((s) => <option key={s.id} value={s.id} className="bg-zinc-900">{s.name} ({s.id}) {s.enabled ? "" : "— disabled"}</option>)}
          {strategies.length === 0 && <option>— no strategies —</option>}
        </select>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="w-24 text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10" placeholder="BTCUSDT" />
      </div>
      <button onClick={run} disabled={loading || !selected} className="w-full text-xs py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold disabled:opacity-40">
        {loading ? "Running…" : `Run backtest (${strategies.find(s=>s.id===selected)?.name ?? selected})`}
      </button>
      {error && <div className="text-xs text-red-400 border border-red-500/20 bg-red-500/10 rounded-lg px-2 py-1.5">{error}</div>}
      {result && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2"><div className="opacity-60">Return</div><div className={`font-bold ${result.totalReturn>=0?"text-emerald-400":"text-red-400"}`}>{fmtPercent(result.totalReturn)} • {fmtCurrency(result.totalPnl)}</div></div>
          <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2"><div className="opacity-60">Trades / Win</div><div className="font-bold">{result.tradeCount} • {(result.winRate*100).toFixed(0)}%</div></div>
          <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2"><div className="opacity-60">Max DD</div><div className="font-bold">{fmtPercent(-result.maxDrawdown)}</div></div>
          <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2"><div className="opacity-60">Sharpe</div><div className="font-bold">{result.sharpeRatio.toFixed(2)}</div></div>
          <div className="col-span-2 opacity-40 text-[11px]">equity points: {result.equityCurve.length} • API: POST /api/backtest/run</div>
        </div>
      )}
      <div className="text-[11px] opacity-40">Powered by <code className="bg-white/10 px-1 rounded">POST /api/backtest/run</code> + <code className="bg-white/10 px-1 rounded">GET /api/backtest/strategies</code> (added in #1)</div>
    </div>
  );
}
