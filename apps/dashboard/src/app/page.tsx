"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MarketChart from "@/components/MarketChart";
import AgentStatus from "@/components/AgentStatus";
import BacktestPanel from "@/components/BacktestPanel";
import OrdersPanel from "@/components/OrdersPanel";
import TradeForm from "@/components/TradeForm";
import {
  API_BASE,
  connectEvents,
  fetchPortfolio,
  fetchTicks,
  fmtCurrency,
  fmtPercent,
  type FinanceEvent,
  type Portfolio,
  type Tick,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TICKER_SYMBOLS = ["BTCUSDT", "ETHUSDT", "AAPL"] as const;

function usePolling<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function tick() {
      try {
        const v = await fn();
        if (!cancelled) {
          setData(v);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    }
    tick();
    timer = setInterval(tick, ms);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, setData };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function DashboardPage() {
  const [events, setEvents] = useState<FinanceEvent[]>([]);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // initial fetch portfolio + ticks
  useEffect(() => {
    fetchPortfolio()
      .then(setPortfolio)
      .catch(() => setPortfolio(null));
    fetchTicks({ limit: 12 })
      .then((r) => setTicks(r.ticks))
      .catch(() => {});

    // health ping
    fetch(`${API_BASE}/api/health`, { cache: "no-store" })
      .then((r) => setHealthOk(r.ok))
      .catch(() => setHealthOk(false));

    // polls for fresh ticks/portfolio while SSE may be down
    const t1 = setInterval(() => {
      fetchTicks({ limit: 12 })
        .then((r) => setTicks(r.ticks))
        .catch(() => {});
    }, 5000);
    const t2 = setInterval(() => {
      fetchPortfolio().then(setPortfolio).catch(() => {});
    }, 7000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  // SSE event log
  useEffect(() => {
    const handle = connectEvents(
      (ev) => {
        setEvents((prev) => [ev, ...prev].slice(0, 200));
        // opportunistic live updates from events
        if (ev.type === "market.tick" && ev.data && typeof ev.data === "object") {
          const d = ev.data as Partial<Tick> & { symbol?: string; price?: number };
          if (d.symbol && typeof d.price === "number") {
            setTicks((prev) => {
              const idx = prev.findIndex((t) => t.symbol === d.symbol);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx]!, price: d.price!, timestamp: ev.timestamp } as Tick;
                return copy;
              }
              return prev;
            });
          }
        }
        if (ev.type === "portfolio.update" && ev.data) {
          try {
            const maybe = ev.data as Portfolio;
            if (maybe.totalValue) setPortfolio(maybe);
          } catch {}
        }
      },
      () => setConnState("open"),
      { replay: true, limit: 50 }
    );
    if (!handle) {
      setConnState("closed");
      return;
    }
    // also watch EventSource state
    const es = handle.source;
    const onOpen = () => setConnState("open");
    const onError = () => setConnState("error");
    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError as EventListener);
    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError as EventListener);
      handle.close();
      setConnState("closed");
    };
  }, []);

  // auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [events]);

  const btc = useMemo(() => ticks.find((t) => t.symbol === "BTCUSDT"), [ticks]);
  const eth = useMemo(() => ticks.find((t) => t.symbol === "ETHUSDT"), [ticks]);
  const aaplTick = useMemo(() => ticks.find((t) => t.symbol === "AAPL" || t.symbol === "AAPLUSDT"), [ticks]);

  const signals = useMemo(
    () =>
      events.filter((e) => e.type.includes("signal") || e.type === "quant.signal" || e.type === "risk.alert").slice(0, 12),
    [events]
  );

  const risk = portfolio?.risk;

  return (
    <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6 space-y-6">
      {/* Header row — market tickers + connection badge */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {[
          { label: "BTC", sym: "BTCUSDT", tick: btc },
          { label: "ETH", sym: "ETHUSDT", tick: eth },
          { label: "AAPL", sym: "AAPL", tick: aaplTick },
        ].map((t) => (
          <div key={t.sym} className="card px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[11px] tracking-widest opacity-60 font-semibold">{t.label} / {t.sym.includes("USDT") ? "USDT" : "USD"}</div>
              <div className="text-xl font-bold tabular-nums">
                {t.tick ? fmtCurrency(t.tick.price) : <span className="opacity-30">— no data</span>}
              </div>
              {t.tick && (t.tick as unknown as { source?: string }).source && (
                <div className={`text-[10px] mt-1 inline-flex px-1.5 py-0.5 rounded font-bold tracking-widest border ${(t.tick as unknown as { source: string }).source === "binance" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>
                  {(t.tick as unknown as { source: string }).source === "binance" ? "● BINANCE" : "○ SYNTHETIC"}
                </div>
              )}
            </div>
            <div className="text-right">
              <div
                className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
                  (t.tick?.changePercent ?? 0) >= 0
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-red-500/10 text-red-400 border-red-500/20"
                }`}
              >
                {t.tick ? fmtPercent(t.tick.changePercent) : "—"}
              </div>
              <div className="text-[11px] opacity-50 mt-1 tabular-nums">
                {t.tick ? `vol ${t.tick.volume.toFixed(0)}` : "vol —"} • {connState === "open" ? "live" : connState}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Health + connection + API base */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`px-2.5 py-1 rounded-full border font-semibold ${healthOk ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : healthOk === false ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-white/5 border-white/10"}`}>
          API {healthOk ? "● healthy" : healthOk === false ? "● unreachable" : "○ checking…"} — {API_BASE}
        </span>
        <span className={`px-2.5 py-1 rounded-full border ${connState === "open" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20" : connState === "error" ? "bg-amber-500/10 text-amber-300 border-amber-500/20" : "bg-white/5 border-white/10"}`}>
          SSE {connState} • {events.length} events
        </span>
        <span className="opacity-60">persistence via EventSource to <code className="bg-white/10 px-1.5 py-0.5 rounded">/api/events</code></span>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left 8 cols — chart + positions */}
        <div className="xl:col-span-8 space-y-6">
          {/* Market chart */}
          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold tracking-tight">Market Chart</h2>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => fetchTicks({ limit: 24 }).then((r) => setTicks(r.ticks))}
                  className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  Refresh ticks
                </button>
                <span className="hidden sm:inline opacity-50">{btc ? `BTC ${fmtCurrency(btc.price)}` : ""}</span>
              </div>
            </div>
            <MarketChart
              symbol={btc?.symbol ?? "BTCUSDT"}
              data={
                ticks.length
                  ? ticks
                      .filter((t) => t.symbol === "BTCUSDT")
                      .slice(0, 24)
                      .map((t) => ({ t: t.timestamp, v: t.price }))
                  : undefined
              }
            />
            {/* quick sparkline row */}
            <div className="grid grid-cols-3 gap-3 mt-4">
              {ticks.slice(0, 6).map((t) => (
                <div key={`${t.symbol}-${t.timestamp}`} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2">
                  <div className="text-[11px] opacity-60 font-semibold">{t.symbol}</div>
                  <div className="text-sm font-bold tabular-nums">{fmtCurrency(t.price)}</div>
                  <div className={`text-xs ${t.changePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtPercent(t.changePercent)}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Portfolio summary — honest: no fake numbers when API empty */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="card p-4">
              <div className="text-[11px] tracking-widest opacity-60 font-semibold">TOTAL VALUE</div>
              <div className="text-2xl font-black tabular-nums mt-1">{portfolio ? fmtCurrency(portfolio.totalValue) : <span className="opacity-30 text-lg">— awaiting /api/portfolio</span>}</div>
              <div className="text-xs opacity-60 mt-1">{portfolio ? `${portfolio.baseCurrency} • ${new Date(portfolio.timestamp).toLocaleTimeString()}` : "connect server to see live value"}</div>
            </div>
            <div className="card p-4">
              <div className="text-[11px] tracking-widest opacity-60 font-semibold">AVAILABLE CASH</div>
              <div className="text-2xl font-black tabular-nums mt-1">{portfolio ? fmtCurrency(portfolio.availableCash) : <span className="opacity-30 text-lg">—</span>}</div>
              <div className={`text-xs font-bold mt-1 ${portfolio && portfolio.pnl.day >= 0 ? "text-emerald-400" : portfolio ? "text-red-400" : "opacity-40"}`}>
                {portfolio ? `${fmtCurrency(portfolio.pnl.day)} today (${fmtPercent(portfolio.pnl.percentDay)})` : "no fills yet"}
              </div>
            </div>
            <div className="card p-4">
              <div className="text-[11px] tracking-widest opacity-60 font-semibold">TOTAL PnL</div>
              <div className={`text-2xl font-black tabular-nums mt-1 ${!portfolio ? "opacity-30" : portfolio.pnl.total >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {portfolio ? fmtCurrency(portfolio.pnl.total) : "—"}
              </div>
              <div className="text-xs opacity-60 mt-1">{portfolio ? `week ${fmtCurrency(portfolio.pnl.week)} • all-time` : "paper mode • $100k start"}</div>
            </div>
          </section>

          {/* Risk metrics */}
          <section className="card p-4 sm:p-5">
            <h2 className="text-sm font-bold tracking-tight mb-3">Risk Metrics</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                <div className="text-[11px] opacity-60 font-semibold">EXPOSURE</div>
                <div className="text-lg font-bold">{risk ? `${(risk.exposure * 100).toFixed(1)}%` : "—"}</div>
                <div className="h-1.5 rounded-full bg-white/10 mt-2 overflow-hidden">
                  <div className="h-full bg-violet-500" style={{ width: `${(risk?.exposure ?? 0) * 100}%` }} />
                </div>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                <div className="text-[11px] opacity-60 font-semibold">MAX DRAWDOWN</div>
                <div className="text-lg font-bold">{risk ? `${(risk.maxDrawdown * 100).toFixed(1)}%` : "—"}</div>
                <div className="text-[11px] opacity-50">limit 20%</div>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                <div className="text-[11px] opacity-60 font-semibold">SHARPE</div>
                <div className="text-lg font-bold">{risk ? String(risk.sharpe) : "—"}</div>
                <div className="text-[11px] text-emerald-400">{risk ? "live" : "no data"}</div>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                <div className="text-[11px] opacity-60 font-semibold">STATUS</div>
                <div
                  className={`inline-flex mt-1 px-2.5 py-1 rounded-full text-xs font-bold border ${
                    (risk?.status ?? "ok") === "ok"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : risk?.status === "warn"
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-red-500/10 text-red-400 border-red-500/20"
                  }`}
                >
                  {(risk?.status ?? "ok").toUpperCase()}
                </div>
              </div>
            </div>
          </section>

          {/* Positions table — honest empty state, no fake SOL */}
          <section className="card p-4 sm:p-5 overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-tight">Positions & Holdings</h2>
              <span className="text-xs opacity-50">{portfolio?.holdings.length ?? 0} holdings</span>
            </div>
            {!portfolio || portfolio.holdings.length === 0 ? (
              <div className="text-sm opacity-50 py-8 text-center border border-dashed border-white/10 rounded-xl">No positions yet — paper trading starts with $100k cash. Place a trade via <code className="bg-white/10 px-1 rounded">POST /api/gateway/trade</code> or wait for quant signals.</div>
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-sm min-w-[520px]">
                  <thead>
                    <tr className="text-[11px] tracking-widest opacity-50 border-b border-white/5">
                      <th className="text-left font-semibold py-2 px-4">Symbol</th>
                      <th className="text-right font-semibold py-2 px-3">Qty</th>
                      <th className="text-right font-semibold py-2 px-3">Avg</th>
                      <th className="text-right font-semibold py-2 px-3">Mark</th>
                      <th className="text-right font-semibold py-2 px-3">Value</th>
                      <th className="text-right font-semibold py-2 px-4">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.holdings.map((h) => (
                      <tr key={h.symbol} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="py-3 px-4 font-bold">{h.symbol}</td>
                        <td className="py-3 px-3 text-right tabular-nums">{h.qty}</td>
                        <td className="py-3 px-3 text-right tabular-nums opacity-70">{fmtCurrency(h.avgPrice)}</td>
                        <td className="py-3 px-3 text-right tabular-nums">{fmtCurrency(h.price)}</td>
                        <td className="py-3 px-3 text-right tabular-nums font-semibold">{fmtCurrency(h.value)}</td>
                        <td className={`py-3 px-4 text-right tabular-nums font-bold ${h.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {h.pnl >= 0 ? "+" : ""}
                          {fmtCurrency(h.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* Right 4 cols — agents, signals, event log */}
        <div className="xl:col-span-4 space-y-6">
          <section className="card p-4 sm:p-5">
            <AgentStatus />
          </section>

          <section className="card p-4 sm:p-5">
            <BacktestPanel />
          </section>

          <section className="card p-4 sm:p-5">
            <OrdersPanel />
          </section>

          <section className="card p-4 sm:p-5">
            <TradeForm />
          </section>

          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-tight">Signals Feed</h2>
              <span className="text-xs opacity-50">{signals.length} recent</span>
            </div>
            {signals.length === 0 ? (
              <div className="text-xs opacity-40 text-center py-6 border border-dashed border-white/10 rounded-xl">No signals yet — quant emits only actionable buy/sell (≥60% + 2/4 confluence). Will appear via SSE.</div>
            ) : (
              <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
                {signals.map((e) => (
                  <div key={e.id} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-widest bg-violet-500/15 text-violet-300">{e.type.toUpperCase()}</span>
                      <span className="text-[11px] opacity-50 ml-auto">{new Date(e.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-xs mt-1 leading-relaxed opacity-90 break-words">{typeof e.data === "string" ? e.data : JSON.stringify(e.data).slice(0, 160)}</div>
                    {e.agentId && <div className="text-[10px] opacity-40 mt-1">via {e.agentId}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-tight">Event Log (SSE)</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs opacity-50 hidden sm:inline">/api/events</span>
                <button
                  onClick={() => setEvents([])}
                  className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  Clear
                </button>
              </div>
            </div>
            <div ref={logRef} className="h-[360px] overflow-auto pr-1 space-y-1.5 font-mono text-xs rounded-xl bg-black/30 border border-white/5 p-2">
              {events.length === 0 ? (
                <div className="opacity-60 p-2 space-y-2">
                  <div>: connected — waiting for events…</div>
                  <div className="opacity-40">Try: curl -N http://localhost:4132/api/events or POST /api/publish {"{type,data}"}</div>
                  <div className="opacity-40">Mock stream active via server bus.publish() every ~5s</div>
                </div>
              ) : (
                events.map((e) => (
                  <div key={e.id} className="flex gap-2 py-1 border-b border-white/[0.04] last:border-0">
                    <span className="opacity-40 shrink-0">{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span className="font-bold text-violet-300 shrink-0">{e.type}</span>
                    <span className="opacity-70 break-all">{typeof e.data === "string" ? e.data.slice(0, 120) : JSON.stringify(e.data).slice(0, 120)}</span>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={async () => {
                  try {
                    await fetch(`${API_BASE}/api/publish`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ type: "dashboard.ping", data: { msg: "hello from dashboard", ts: Date.now() } }),
                    });
                  } catch {}
                }}
                className="flex-1 text-xs py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold"
              >
                Publish test event
              </button>
              <a
                href={`${API_BASE}/api/events`}
                target="_blank"
                rel="noreferrer"
                className="text-xs py-2 px-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
              >
                Open SSE ↗
              </a>
            </div>
          </section>
        </div>
      </div>

      <footer className="text-center text-[11px] opacity-30 py-4">Finance Agent OS • 5 agents • Market → Quant → Risk → Portfolio → Execution • {new Date().getFullYear()}</footer>
    </main>
  );
}
