"use client";

import { useEffect, useRef, useState } from "react";

type Point = { t: number; v: number };

type Props = {
  symbol?: string;
  data?: Point[];
  height?: number;
  color?: string;
};

function generateMockData(len = 48, base = 68000, vol = 400): Point[] {
  const now = Date.now();
  let price = base;
  return Array.from({ length: len }, (_, i) => {
    price += (Math.random() - 0.5) * vol;
    return { t: now - (len - i) * 60000, v: price };
  });
}

export default function MarketChart({
  symbol = "BTCUSDT",
  data,
  height = 180,
  color = "#22c55e",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Point[]>(() => data ?? []);
  const [mounted, setMounted] = useState(false);

  // hydrate-safe: generate mock only on client
  useEffect(() => {
    setMounted(true);
    if (!data || data.length === 0) setPoints(generateMockData());
  }, [data]);

  // if external data changes, use it
  useEffect(() => {
    if (data && data.length) setPoints(data);
  }, [data]);

  // live tick simulation when no external data binding
  useEffect(() => {
    if (data) return;
    const id = setInterval(() => {
      setPoints((prev) => {
        const last = prev[prev.length - 1]?.v ?? 68000;
        const next = last + (Math.random() - 0.5) * 300;
        const nxt = [...prev.slice(1), { t: Date.now(), v: next }];
        return nxt;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [data]);

  // draw on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = rect.width;
    const h = height;
    const pad = 12;

    ctx.clearRect(0, 0, w, h);

    // bg grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = pad + (h - pad * 2) * (i / 4);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }

    if (points.length < 2) return;

    const min = Math.min(...points.map((p) => p.v));
    const max = Math.max(...points.map((p) => p.v));
    const range = max - min || 1;

    // gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, color + "40");
    gradient.addColorStop(1, color + "00");

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (p.v - min) / range) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    // close to bottom for fill
    const lastX = pad + w - pad * 2;
    const firstX = pad;
    ctx.lineTo(lastX, h - pad);
    ctx.lineTo(firstX, h - pad);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // line
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (p.v - min) / range) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();

    // last dot
    const lx = lastX;
    const ly = pad + (1 - (points[points.length - 1]!.v - min) / range) * (h - pad * 2);
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#0a0a0f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [points, height, color]);

  const last = points[points.length - 1]?.v ?? 0;
  const first = points[0]?.v ?? last;
  const chg = last - first;
  const pct = first ? (chg / first) * 100 : 0;

  if (!mounted && (!data || data.length === 0)) {
    return (
      <div className="market-chart" style={{ width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, letterSpacing: 0.6, opacity: 0.7, fontWeight: 600 }}>{symbol}</span>
          <span style={{ fontSize: 12, opacity: 0.4 }}>loading…</span>
        </div>
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, height }} />
      </div>
    );
  }

  return (
    <div className="market-chart" style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 12, letterSpacing: 0.6, opacity: 0.7, fontWeight: 600 }}>{symbol}</span>
        <span
          suppressHydrationWarning
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: chg >= 0 ? "#22c55e" : "#ef4444",
            background: chg >= 0 ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
            padding: "2px 8px",
            borderRadius: 999,
          }}
        >
          {chg >= 0 ? "+" : ""}
          {chg.toFixed(2)} ({pct.toFixed(2)}%)
        </span>
      </div>

      {/* SVG fallback + Canvas primary — canvas is authoritative */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 12,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height, display: "block" }}
          aria-label={`${symbol} price chart`}
        />
        {/* lightweight-charts mount point placeholder (kept for future swap) */}
        <div id="lw-chart" style={{ display: "none" }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, opacity: 0.45 }}>
        <span>{new Date(points[0]?.t ?? Date.now()).toLocaleTimeString()}</span>
        <span>{new Date(points[points.length - 1]?.t ?? Date.now()).toLocaleTimeString()} • live</span>
      </div>
    </div>
  );
}
