"use client";

import { useEffect, useState } from "react";
import {
  fetchPortfolio,
  fmtCurrency,
  type FinanceEvent,
  type Portfolio,
} from "@/lib/api";
import { fetchRiskStatus } from "@/lib/desktop-api";
import { useFinanceEvents } from "@/lib/useFinanceEvents";

// fetchRiskStatus() is typed Promise<unknown> — view only what we render.
type RiskStatusView = {
  status?: unknown;
  gated?: unknown;
  approved?: unknown;
  rejected?: unknown;
};

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold tabular-nums text-gray-200">{value}</span>
    </div>
  );
}

function riskText(r: RiskStatusView | null): string {
  if (!r) return "unavailable";
  if (typeof r.status === "string" && r.status.length > 0) return r.status;
  if (r.gated === true) return "gated";
  return "ok";
}

function countText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return "—";
}

function formatClock(ts: number): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString();
  } catch {
    return "";
  }
}

export function ContextRail() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [risk, setRisk] = useState<RiskStatusView | null>(null);
  const { events, connected } = useFinanceEvents();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const p = await fetchPortfolio();
        if (!cancelled) setPortfolio(p);
      } catch {
        if (!cancelled) setPortfolio(null);
      }
    }
    void load();
    const id = setInterval(() => {
      void load();
    }, 7000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = (await fetchRiskStatus()) as unknown as RiskStatusView | null;
        if (!cancelled) setRisk(r && typeof r === "object" ? r : null);
      } catch {
        if (!cancelled) setRisk(null);
      }
    }
    void load();
    const id = setInterval(() => {
      void load();
    }, 7000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ccy = portfolio?.baseCurrency ?? "USD";
  const cash = portfolio?.availableCash;
  const totalValue = portfolio?.totalValue;
  const positionCount =
    (portfolio?.holdings?.length ?? 0) + (portfolio?.positions?.length ?? 0);
  const recent: FinanceEvent[] = events.slice(0, 15);

  return (
    <div className="flex flex-col bg-transparent px-4 py-3">
      <section className="border-b border-white/10 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-500">
          Portfolio
        </h3>
        <div className="space-y-1.5">
          <StatRow
            label="Cash"
            value={typeof cash === "number" ? fmtCurrency(cash, ccy) : "—"}
          />
          <StatRow
            label="Total value"
            value={
              typeof totalValue === "number" ? fmtCurrency(totalValue, ccy) : "—"
            }
          />
          <StatRow
            label="Positions"
            value={portfolio ? String(positionCount) : "—"}
          />
        </div>
      </section>

      <section className="border-b border-white/10 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-500">
          Risk
        </h3>
        <div className="space-y-1.5">
          <StatRow label="Status" value={riskText(risk)} />
          <StatRow
            label="Approved"
            value={risk ? countText(risk.approved) : "—"}
          />
          <StatRow
            label="Rejected"
            value={risk ? countText(risk.rejected) : "—"}
          />
        </div>
      </section>

      <section className="py-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Live events
          </h3>
          <span
            aria-label={connected ? "live" : "offline"}
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-green-500" : "bg-gray-500"
            }`}
          />
        </div>
        {recent.length === 0 ? (
          <p className="py-2 text-center text-xs text-gray-600">No events yet</p>
        ) : (
          <ul className="max-h-80 space-y-1.5 overflow-y-auto">
            {recent.map((ev) => (
              <li key={ev.id} className="text-[11px] leading-snug text-gray-500">
                <span className="font-semibold text-gray-400">{ev.type}</span>{" "}
                <span className="tabular-nums">
                  {formatClock(ev.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
