"use client";
import { useState } from "react";
import { supervisorTask } from "@/lib/desktop-api";

export function ChatPanel({ onSent }: { onSent?: (msg: string) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function send() {
    const task = input.trim();
    if (!task) return;
    setBusy(true);
    setHint(null);
    try {
      await supervisorTask(task);
      onSent?.(task);
      setInput("");
      setHint("Task dispatched → supervisor.task");
      setTimeout(() => setHint(null), 2500);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const quick = ["Analyze BTC", "Run backtest EMA on BTCUSDT", "Show portfolio", "Assess risk", "Paper trade BTC 0.05"];

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-tight">Chat / Task Input</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 tracking-widest">SUPERVISOR</span>
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="e.g. Analyze BTC — Market → Research → Strategy → Risk → Final"
          className="flex-1 rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-violet-500/50"
        />
        <button onClick={send} disabled={busy || !input.trim()} className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-semibold">
          {busy ? "…" : "Send"}
        </button>
      </div>
      {hint && <div className="text-xs opacity-60">{hint}</div>}
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <button key={q} onClick={() => setInput(q)} className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">
            {q}
          </button>
        ))}
      </div>
      <div className="text-[11px] opacity-40 leading-relaxed">Deterministic routing: classify → extract BTCUSDT → Market→Research→Strategy→Risk→Final. Publishes via <code className="bg-white/10 px-1 rounded">POST /api/publish</code> type <code className="bg-white/10 px-1 rounded">supervisor.task</code>.</div>
    </div>
  );
}
