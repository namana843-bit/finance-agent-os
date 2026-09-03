"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

type CandlesResp = { candles: unknown[]; synthetic?: boolean; note?: string; symbol: string; timeframe: string };
type OrderbookResp = { bids: unknown[]; asks: unknown[]; synthetic?: boolean; note?: string; symbol: string };

export default function MarketMeta({ symbol = "BTCUSDT" }: { symbol?: string }) {
  const [candles, setCandles] = useState<CandlesResp | null>(null);
  const [orderbook, setOrderbook] = useState<OrderbookResp | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [c, o] = await Promise.all([
          fetch(`${API_BASE}/api/market/candles?symbol=${symbol}&limit=5`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
          fetch(`${API_BASE}/api/market/orderbook?symbol=${symbol}&depth=5`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        ]);
        if (!cancelled) { setCandles(c); setOrderbook(o); }
      } catch {}
    }
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol]);

  const candlesSynthetic = candles?.synthetic === true;
  const bookSynthetic = orderbook?.synthetic === true;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold tracking-tight">Market Meta • {symbol}</h3>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2.5">
          <div className="opacity-60 text-[11px] font-semibold">CANDLES</div>
          <div className="font-bold">{candles ? `${candles.candles.length} × ${candles.timeframe}` : "—"}</div>
          {candlesSynthetic ? <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-widest border bg-amber-500/10 text-amber-400 border-amber-500/20">○ SYNTHETIC</span> : candles ? <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-widest border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">● LIVE</span> : null}
          {candles?.note && <div className="opacity-40 text-[11px] mt-1">{candles.note}</div>}
        </div>
        <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2.5">
          <div className="opacity-60 text-[11px] font-semibold">ORDERBOOK</div>
          <div className="font-bold">{orderbook ? `${orderbook.bids.length} bids / ${orderbook.asks.length} asks` : "—"}</div>
          {bookSynthetic ? <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-widest border bg-amber-500/10 text-amber-400 border-amber-500/20">○ SYNTHETIC</span> : orderbook ? <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-widest border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">● LIVE</span> : null}
          {orderbook?.note && <div className="opacity-40 text-[11px] mt-1">{orderbook.note}</div>}
        </div>
      </div>
      <div className="text-[11px] opacity-40">Server: <code className="bg-white/10 px-1 rounded">GET /api/market/candles</code> + <code className="bg-white/10 px-1 rounded">/orderbook</code> both return <code className="bg-white/10 px-1 rounded">{"{synthetic:true}"}</code> today — replace with BinanceAdapter WS in prod.</div>
    </div>
  );
}
