"use client";
import { useState } from "react";
import { API_BASE } from "@/lib/api";

export default function TradeForm() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("0.01");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null); setErr(null);
    try {
      const res = await fetch(`${API_BASE}/api/gateway/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symbol.toUpperCase(), side, type: "market", quantity: Number(quantity), price: Number(price) || 0, agentId: "dashboard-trade-form" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      setMsg(`gateway ${j.decision?.approved ? "approved" : "rejected"}: ${j.decision?.reason ?? ""} • risk=${j.decision?.riskApproved} portfolio=${j.decision?.portfolioApproved}`);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  }

  // fetch current price as hint
  async function fillPrice() {
    try { const r = await fetch(`${API_BASE}/api/market/ticks?limit=10&symbol=${symbol}`, { cache: "no-store" }); const j = await r.json(); const t = j.ticks?.find((x: { symbol: string; price: number }) => x.symbol === symbol) ?? j.ticks?.[0]; if (t?.price) setPrice(String(t.price)); } catch {}
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight">Place Trade (gateway)</h3>
        <span className="text-xs opacity-50">POST /api/gateway/trade</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="BTCUSDT" className="text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10" />
        <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")} className="text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10">
          <option value="buy" className="bg-zinc-900">buy</option>
          <option value="sell" className="bg-zinc-900">sell</option>
        </select>
        <input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0.01" type="number" step="any" className="text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10" />
        <div className="flex gap-1">
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" type="number" step="any" className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-white/5 border border-white/10" />
          <button type="button" onClick={fillPrice} className="text-xs px-2 rounded-lg bg-white/5 border border-white/10">↻</button>
        </div>
      </div>
      <button disabled={busy} className="w-full text-xs py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold disabled:opacity-40">{busy ? "Submitting…" : `${side.toUpperCase()} via FinanceGateway`}</button>
      {msg && <div className="text-xs text-emerald-400 border border-emerald-500/20 bg-emerald-500/10 rounded-lg px-2 py-1.5 break-words">{msg}</div>}
      {err && <div className="text-xs text-red-400 border border-red-500/20 bg-red-500/10 rounded-lg px-2 py-1.5 break-words">{err}</div>}
      <div className="text-[11px] opacity-40">Goes through <code className="bg-white/10 px-1 rounded">FinanceGateway</code> → risk → portfolio → execution; respects <code className="bg-white/10 px-1 rounded">LIVE_TRADING_ENABLED</code>.</div>
    </form>
  );
}
