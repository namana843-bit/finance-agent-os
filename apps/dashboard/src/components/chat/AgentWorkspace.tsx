import React, { useState, useEffect, useRef } from "react";

export interface LLMEventPayload {
  type: string;
  messageId?: string;
  model?: string;
  delta?: string;
  toolCallId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  text?: string;
  error?: string;
  timestamp?: number;
}

export interface AgentConfigUI {
  id: string;
  name: string;
  engine: string;
  model?: string;
  systemPrompt?: string;
}

export function AgentWorkspace() {
  const [agents, setAgents] = useState<AgentConfigUI[]>([
    { id: "btc-quant-agent", name: "BTC Quant Agent", engine: "opencode-cli", model: "opencode" },
    { id: "risk-guardian-agent", name: "Risk Guardian Agent", engine: "opencode-cli", model: "opencode" },
    { id: "market-research-agent", name: "Market Researcher", engine: "opencode-cli", model: "opencode" },
    { id: "opencode-cli-agent", name: "OpenCode CLI Agent", engine: "opencode-cli", model: "opencode" },
  ]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("btc-quant-agent");
  const [selectedEngine, setSelectedEngine] = useState<string>("opencode-cli");

  const [prompt, setPrompt] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [events, setEvents] = useState<LLMEventPayload[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/agent-runtime/agents")
      .then((res) => res.json())
      .then((data) => {
        if (data.agents && Array.isArray(data.agents) && data.agents.length > 0) {
          setAgents(data.agents);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const handleSendPrompt = async () => {
    if (!prompt.trim() || isStreaming) return;
    setIsStreaming(true);

    const userEvent: LLMEventPayload = {
      type: "user_message",
      text: prompt,
      timestamp: Date.now(),
    };

    setEvents((prev) => [...prev, userEvent]);
    const currentPrompt = prompt;
    setPrompt("");

    try {
      const response = await fetch("/api/agent-runtime/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          prompt: currentPrompt,
        }),
      });

      if (!response.body) {
        throw new Error("No SSE response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const parsedEvent = JSON.parse(trimmed.slice(6)) as LLMEventPayload;
            setEvents((prev) => [...prev, parsedEvent]);
          } catch {
            // Partial JSON chunk
          }
        }
      }
    } catch (err) {
      setEvents((prev) => [
        ...prev,
        {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsStreaming(false);
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 rounded-lg border border-slate-800 shadow-xl overflow-hidden font-sans">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-lg border border-emerald-500/30">
            🤖
          </div>
          <div>
            <h2 className="font-semibold text-slate-100 text-sm">Finance Agent Engine Workspace</h2>
            <p className="text-xs text-slate-400">Provider-Agnostic LLM Engine Layer + Execution Pipeline</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Agent Selector */}
          <div className="flex flex-col">
            <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Agent</label>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="bg-slate-800 text-slate-200 text-xs px-2 py-1 rounded border border-slate-700 focus:outline-none focus:border-emerald-500"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* Engine Selector */}
          <div className="flex flex-col">
            <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Engine</label>
            <select
              value={selectedEngine}
              onChange={(e) => setSelectedEngine(e.target.value)}
              className="bg-slate-800 text-slate-200 text-xs px-2 py-1 rounded border border-slate-700 focus:outline-none focus:border-emerald-500"
            >
              <option value="ollama-local">Ollama (qwen2.5-coder)</option>
              <option value="openai-gpt4">OpenAI (gpt-4o)</option>
              <option value="openrouter-claude">OpenRouter (claude-3.5)</option>
              <option value="opencode-cli">CLI (opencode)</option>
              <option value="openai-compatible">OpenAI-Compatible (Local)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Events / Stream Output Box */}
      <div ref={scrollRef} className="flex-1 p-4 overflow-y-auto space-y-3 bg-slate-950/60 font-mono text-xs">
        {events.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
            <span className="text-2xl">⚡</span>
            <p>Select an agent and prompt to analyze market prices, run indicators, or generate trade proposals.</p>
          </div>
        ) : (
          events.map((ev, index) => {
            if (ev.type === "user_message") {
              return (
                <div key={index} className="flex justify-end my-2">
                  <div className="bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 px-3 py-2 rounded-lg max-w-[80%] font-sans">
                    <span className="font-semibold block text-[10px] text-emerald-400 uppercase tracking-wider mb-1">User</span>
                    {ev.text}
                  </div>
                </div>
              );
            }

            if (ev.type === "message_start") {
              return (
                <div key={index} className="text-slate-500 text-[10px] border-b border-slate-800/60 pb-1">
                  ▶ Started stream for model: <span className="text-slate-300 font-semibold">{ev.model}</span>
                </div>
              );
            }

            if (ev.type === "reasoning_delta") {
              return (
                <div key={index} className="bg-purple-950/40 border border-purple-800/40 text-purple-300 p-2 rounded text-[11px] italic">
                  <span className="font-bold text-purple-400 text-[10px] uppercase block">Thinking...</span>
                  {ev.delta}
                </div>
              );
            }

            if (ev.type === "text_delta") {
              return (
                <span key={index} className="text-slate-200 whitespace-pre-wrap font-sans">
                  {ev.delta}
                </span>
              );
            }

            if (ev.type === "tool_call") {
              return (
                <div key={index} className="bg-amber-950/40 border border-amber-800/50 p-2.5 rounded-lg text-amber-200 my-2">
                  <div className="flex items-center gap-2 font-bold text-amber-400 mb-1">
                    <span>🔧 Tool Invoked:</span>
                    <span className="bg-amber-900/60 px-1.5 py-0.5 rounded text-amber-200">{ev.name}</span>
                  </div>
                  <pre className="bg-slate-900/80 p-2 rounded text-[10px] overflow-x-auto text-amber-300 border border-amber-900/30">
                    {JSON.stringify(ev.arguments, null, 2)}
                  </pre>
                </div>
              );
            }

            if (ev.type === "tool_result") {
              const resObj = ev.result as Record<string, unknown> | undefined;
              const isTradeProposal = ev.name === "create_trade_proposal" || (resObj && resObj.status);

              if (isTradeProposal && resObj) {
                const isApproved = resObj.decision === "APPROVED" || resObj.status === "EXECUTED";
                return (
                  <div
                    key={index}
                    className={`p-3 rounded-lg my-2 border ${
                      isApproved ? "bg-emerald-950/50 border-emerald-500/50 text-emerald-200" : "bg-red-950/50 border-red-500/50 text-red-200"
                    }`}
                  >
                    <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2 font-sans">
                      <span className="font-bold uppercase tracking-wider text-xs">
                        {isApproved ? "✅ Trade Proposal Executed" : "❌ Trade Proposal Rejected"}
                      </span>
                      <span className={`px-2 py-0.5 text-[10px] rounded font-bold uppercase ${isApproved ? "bg-emerald-500 text-slate-950" : "bg-red-500 text-slate-100"}`}>
                        {String(resObj.decision || resObj.status)}
                      </span>
                    </div>

                    <div className="space-y-1 text-xs font-mono">
                      <div><span className="opacity-60">Status Stage:</span> {String(resObj.stage || "Pipeline")}</div>
                      {resObj.reason ? <div><span className="opacity-60">Reason:</span> {String(resObj.reason)}</div> : null}
                      {resObj.order ? (
                        <div className="mt-2 bg-slate-900/80 p-2 rounded border border-white/10">
                          <span className="font-bold block text-[10px] opacity-70 mb-1">PAPER BROKER FILL RESULT:</span>
                          <pre className="text-[10px]">{JSON.stringify(resObj.order, null, 2)}</pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }

              return (
                <div key={index} className="bg-blue-950/30 border border-blue-800/40 p-2 rounded text-blue-200 my-1">
                  <div className="flex items-center gap-1.5 font-semibold text-blue-400 mb-1">
                    <span>✓ Tool Result ({ev.name}):</span>
                  </div>
                  <pre className="bg-slate-900/80 p-2 rounded text-[10px] overflow-x-auto text-blue-300 border border-blue-900/30">
                    {JSON.stringify(ev.result, null, 2)}
                  </pre>
                </div>
              );
            }

            if (ev.type === "error") {
              return (
                <div key={index} className="bg-red-900/40 border border-red-700 p-2.5 rounded text-red-300 font-sans my-2">
                  <span className="font-bold block text-red-400">Error Encountered:</span>
                  {ev.error}
                </div>
              );
            }

            return null;
          })
        )}
      </div>

      {/* Input controls */}
      <div className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSendPrompt()}
          placeholder={`Ask ${selectedAgent.name} (e.g. "Analyze BTC prices and calculate RSI", "Propose buy for 0.01 BTC")...`}
          disabled={isStreaming}
          className="flex-1 bg-slate-950 text-slate-100 text-xs px-3 py-2 rounded-lg border border-slate-800 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          onClick={handleSendPrompt}
          disabled={isStreaming || !prompt.trim()}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-4 py-2 rounded-lg transition disabled:opacity-50 flex items-center gap-1"
        >
          {isStreaming ? (
            <>
              <span className="animate-spin text-sm">⏳</span> Streaming...
            </>
          ) : (
            <>Send ➔</>
          )}
        </button>
      </div>
    </div>
  );
}
