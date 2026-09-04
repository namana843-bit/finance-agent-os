"use client";
import { useRef, useState, useEffect } from "react";
import { terminalCommand } from "@/lib/desktop-api";
import type { FinanceEvent } from "@/lib/api";

export function TerminalPanel({ events }: { events: FinanceEvent[] }) {
  const [cmd, setCmd] = useState("");
  const [log, setLog] = useState<string[]>(["> Finance Agent Terminal — type help", "> connected via POST /api/publish terminal.command"]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(()=>{ if(ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);

  // reflect terminal.command echo from bus
  useEffect(()=>{
    const t = events.filter(e=>e.type==="terminal.command").slice(0,1);
    if(t[0]) setLog(prev=>[...prev, `◂ ${JSON.stringify((t[0]!.data as Record<string,unknown>))}`].slice(-200));
  }, [events]);

  async function run() {
    const c = cmd.trim();
    if(!c) return;
    setLog(prev=>[...prev, `> ${c}`]);
    setCmd("");
    if(c==="help") { setLog(prev=>[...prev, "commands: help, clear, status, publish <type> <json>, task <text>"]); return; }
    if(c==="clear") { setLog(["> cleared"]); return; }
    if(c.startsWith("task ")) { const task=c.slice(5); try{ const {supervisorTask}=await import("@/lib/desktop-api"); await supervisorTask(task); setLog(prev=>[...prev, `→ supervisor.task {task:${task.slice(0,60)}}`]); } catch(e){ setLog(prev=>[...prev, `! ${String(e)}`]); } return; }
    try { await terminalCommand(c); setLog(prev=>[...prev, `→ published terminal.command`]); } catch(e){ setLog(prev=>[...prev, `! ${e instanceof Error?e.message:String(e)}`]); }
  }

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-tight">Terminal / CLI</h2>
        <button onClick={()=>setLog(["> cleared"])} className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">Clear</button>
      </div>
      <div ref={ref} className="h-[240px] overflow-auto pr-1 space-y-1 font-mono text-xs rounded-xl bg-black/40 border border-white/5 p-3">
        {log.map((l,i)=>(<div key={i} className="opacity-80 break-all">{l}</div>))}
      </div>
      <div className="flex gap-2">
        <span className="py-2 opacity-60 font-mono text-sm">$</span>
        <input value={cmd} onChange={e=>setCmd(e.target.value)} onKeyDown={e=>e.key==="Enter"&&run()} placeholder="help | task Analyze BTC | clear" className="flex-1 rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm font-mono outline-none focus:border-violet-500/50" />
        <button onClick={run} className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm font-semibold">Run</button>
      </div>
      <div className="text-[11px] opacity-40">Publishes <code className="bg-white/10 px-1 rounded">terminal.command</code> to backend bus; supervisor & pipeline listen via SSE.</div>
    </div>
  );
}
