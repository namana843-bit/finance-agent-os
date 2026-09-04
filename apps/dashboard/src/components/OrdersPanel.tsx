"use client";
import { useEffect, useState } from "react";
import { API_BASE, fmtCurrency } from "@/lib/api";

type Order = { id?: string; orderId?: string; symbol: string; side: string; type?: string; quantity?: number; qty?: number; price: number; status?: string; timestamp?: number; source?: string };
type Trade = { orderId?: string; id?: string; symbol: string; side: string; quantity?: number; qty?: number; price: number; fee?: number; timestamp?: number; source?: string };

export default function OrdersPanel() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tab, setTab] = useState<"orders" | "trades">("orders");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [o, t] = await Promise.all([
          fetch(`${API_BASE}/api/orders`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({ orders: [] })),
          fetch(`${API_BASE}/api/trades`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({ trades: [] })),
        ]);
        if (!cancelled) {
          setOrders((o.orders ?? []) as Order[]);
          setTrades((t.trades ?? t.fills ?? []) as Trade[]);
        }
      } catch {}
    }
    load();
    const id = setInterval(load, 7000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const list = tab === "orders" ? orders : trades;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight">Orders & Trades</h3>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setTab("orders")} className={`px-2.5 py-1 rounded-full border font-semibold ${tab === "orders" ? "bg-violet-600 text-white border-violet-600" : "bg-white/5 border-white/10"}`}>Orders ({orders.length})</button>
          <button onClick={() => setTab("trades")} className={`px-2.5 py-1 rounded-full border font-semibold ${tab === "trades" ? "bg-violet-600 text-white border-violet-600" : "bg-white/5 border-white/10"}`}>Trades ({trades.length})</button>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="text-xs opacity-40 text-center py-6 border border-dashed border-white/10 rounded-xl">
          No {tab} yet — {tab === "orders" ? "PaperBroker is single truth (source: paper-broker)" : "ExecutionAgent fills (source: execution-agent)"} • poll 7s
        </div>
      ) : (
        <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
          {list.slice(0, 24).map((r, i) => {
            const qty = (r as unknown as { quantity: number }).quantity ?? (r as unknown as { qty: number }).qty ?? 0;
            const src = (r as unknown as { source: string }).source;
            return (
              <div key={`${tab}-${r.orderId ?? r.id ?? i}-${r.timestamp ?? i}`} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold">{r.symbol}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold tracking-widest border ${r.side === "buy" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>{r.side?.toUpperCase()}</span>
                  {src && <span className="text-[10px] opacity-40 ml-auto">{src}</span>}
                </div>
                <div className="text-xs mt-1 tabular-nums opacity-90">{qty} @ {fmtCurrency(r.price)} {(r as unknown as { status?: string }).status ? "• " + (r as unknown as { status: string }).status : ""} {(r as unknown as { fee?: number }).fee ? "• fee " + fmtCurrency((r as unknown as { fee: number }).fee) : ""}</div>
                {r.timestamp && <div className="text-[11px] opacity-40">{new Date(r.timestamp).toLocaleTimeString()}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div className="text-[11px] opacity-40">API: <code className="bg-white/10 px-1 rounded">GET /api/orders</code> + <code className="bg-white/10 px-1 rounded">GET /api/trades</code> (PaperBroker/Execution truth)</div>
    </div>
  );
}
