import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  CircleDot,
  Info,
  Loader2,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Users,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { streamAgentChat } from "../../lib/api";
import { currentHashQuery, navigate } from "../shell/nav";
import { EmptyState, ErrorBanner, MonoLabel, PageHeader, Panel, SectionHeading } from "../shell/ui";
import { agentInitials, avatarTone, useWorkspace } from "../shell/workspace-data";

type ToolRun = { id: string; name: string; status: "running" | "done" | "failed" };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  tools?: ToolRun[];
  error?: string;
};

const SUGGESTIONS = [
  {
    title: "Market brief",
    prompt:
      "Write a concise market briefing for BTC and ETH. Separate verified data from assumptions, give bull, base and bear scenarios, and state what data you could not check. Do not place orders.",
  },
  {
    title: "Risk review",
    prompt:
      "Give me a pre-trade risk review checklist for a paper crypto portfolio: position sizing, concentration, drawdown and liquidity. Do not place orders.",
  },
  {
    title: "Strategy hypothesis",
    prompt:
      "Propose one testable crypto strategy. State entry, exit, invalidation, sample period and what would falsify it. Do not claim a backtest ran unless a tool actually ran it.",
  },
  {
    title: "Portfolio read",
    prompt:
      "Review the paper portfolio: cash vs deployed capital, concentration, P&L attribution and cost drag. Show the arithmetic and separate measured facts from assumptions. Do not place orders.",
  },
];

export default function WorkspacePage() {
  const { agents, agentsState, agentsError, runs, portfolio, refresh } = useWorkspace();
  const query = currentHashQuery();
  const requested = query.get("coworker");

  const [agentId, setAgentId] = useState<string | null>(requested);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [streamTools, setStreamTools] = useState<ToolRun[]>([]);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? agents[0] ?? null,
    [agents, agentId],
  );

  useEffect(() => {
    if (!agentId && requested) setAgentId(requested);
  }, [requested, agentId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText, streamTools, streamReasoning]);

  const currentRun = runs.find(
    (run) => run.status === "running" && run.agents?.some((step) => step.agentId === activeAgent?.id),
  );

  const resetStream = () => {
    setStreamText("");
    setStreamReasoning("");
    setStreamTools([]);
  };

  const send = async (override?: string) => {
    const prompt = (override ?? draft).trim();
    if (!prompt || !activeAgent || busy) return;

    setError("");
    setDraft("");
    setBusy(true);
    resetStream();
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: prompt }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let text = "";
    let reasoning = "";
    const tools: ToolRun[] = [];

    try {
      await streamAgentChat(
        activeAgent.id,
        prompt,
        (event) => {
          const type = String((event as { type?: string }).type ?? "");
          const data = event as Record<string, unknown>;
          if (type === "text_delta" && typeof data.delta === "string") {
            text += data.delta;
            setStreamText(text);
          } else if (type === "reasoning_delta" && typeof data.delta === "string") {
            reasoning += data.delta;
            setStreamReasoning(reasoning);
          } else if (type === "tool_call") {
            tools.push({
              id: String(data.toolCallId ?? `tool-${tools.length}`),
              name: String(data.name ?? "tool"),
              status: "running",
            });
            setStreamTools([...tools]);
          } else if (type === "tool_result") {
            const id = String(data.toolCallId ?? "");
            const tool = tools.find((item) => item.id === id);
            if (tool) {
              tool.status = data.isError ? "failed" : "done";
              setStreamTools([...tools]);
            }
          } else if (type === "message_complete") {
            if (!text && typeof data.text === "string") {
              text = data.text;
              setStreamText(text);
            }
          } else if (type === "error") {
            throw new Error(String(data.error ?? "Agent run failed"));
          }
        },
        controller.signal,
      );

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: text.trim() || "(No text returned. The agent finished without a message.)",
          reasoning: reasoning.trim() || undefined,
          tools: tools.length ? tools : undefined,
        },
      ]);
    } catch (streamError) {
      const aborted = controller.signal.aborted;
      if (!aborted) {
        const message = streamError instanceof Error ? streamError.message : String(streamError);
        setError(message);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: text.trim(),
            reasoning: reasoning.trim() || undefined,
            tools: tools.length ? tools : undefined,
            error: message,
          },
        ]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      resetStream();
      textareaRef.current?.focus();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
    resetStream();
  };

  return (
    <div>
      <PageHeader
        eyebrow="AI workspace"
        title="AI Workspace"
        description="Ask a coworker to research, explain or review. Advisory only — orders still need the risk gate and your confirmation."
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11.5px] text-neutral-300 transition-colors hover:bg-white/5"
          >
            Reload agents
          </button>
        }
      />

      {agentsState === "error" ? (
        <div className="mb-4">
          <ErrorBanner
            title="Cannot start a conversation"
            message={`${agentsError} Start the local API on :4132 and reload.`}
            onRetry={() => void refresh()}
          />
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)] 2xl:grid-cols-[190px_minmax(0,1fr)_250px]">
        <Panel className="flex flex-col p-2">
          <div className="px-2 pb-2 pt-1">
            <MonoLabel>Coworkers</MonoLabel>
          </div>
          {agentsState === "loading" ? (
            <div className="space-y-1 p-1">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="h-9 animate-pulse rounded-md bg-white/[0.03]" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <div className="p-2">
              <p className="text-[10.5px] leading-relaxed text-neutral-600">
                No coworkers are configured yet.
              </p>
              <button
                type="button"
                onClick={() => navigate("/team")}
                className="mt-2 w-full rounded-md border border-white/10 px-2 py-1.5 text-[10.5px] text-neutral-300 hover:bg-white/5"
              >
                Create one in Agent Team
              </button>
            </div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  setAgentId(agent.id);
                  setMessages([]);
                  resetStream();
                  setError("");
                }}
                className={cn(
                  "mb-0.5 flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  agent.id === activeAgent?.id
                    ? "bg-white/[0.07] text-neutral-100"
                    : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-semibold ring-1",
                    avatarTone(agent.id),
                  )}
                >
                  {agentInitials(agent.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{agent.name}</span>
                  <span className="block truncate text-[9.5px] text-neutral-600">{agent.role ?? agent.engine}</span>
                </span>
              </button>
            ))
          )}
        </Panel>

        <Panel className="flex min-h-[560px] min-w-0 flex-col">
          <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            {activeAgent ? (
              <>
                <span
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg text-[10px] font-semibold ring-1",
                    avatarTone(activeAgent.id),
                  )}
                >
                  {agentInitials(activeAgent.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-neutral-100">{activeAgent.name}</div>
                  <div className="truncate text-[10px] text-neutral-600">
                    {activeAgent.role ?? "Finance coworker"} · {activeAgent.model || activeAgent.engine || "default model"}
                  </div>
                </div>
                <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[9.5px] text-neutral-400 sm:flex">
                  <CircleDot className={cn("h-2.5 w-2.5", busy ? "text-sky-400" : "text-emerald-400")} />
                  {busy ? "Responding" : currentRun ? `Task: ${currentRun.stage}` : "Idle"}
                </span>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-neutral-500">
                <Bot className="h-4 w-4" />
                Select a coworker to start
              </div>
            )}
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
            {!activeAgent ? (
              <EmptyState
                icon={<Users className="h-4 w-4" />}
                title="No coworker selected"
                description="The runtime has no agents to talk to. Configure a coworker first, then return to this workspace."
                action={
                  <button
                    type="button"
                    onClick={() => navigate("/coworkers")}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5"
                  >
                    Open coworker directory
                  </button>
                }
              />
            ) : messages.length === 0 && !busy ? (
              <div className="mx-auto max-w-lg py-6">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-300">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <h3 className="text-[14px] font-medium text-neutral-100">Start with {activeAgent.name}</h3>
                  <p className="mx-auto mt-1.5 max-w-sm text-[11.5px] leading-relaxed text-neutral-500">
                    {activeAgent.description ??
                      "Ask for research, an explanation or a review. Answers are advisory and never execute a trade."}
                  </p>
                </div>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => void send(item.prompt)}
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/[0.04]"
                    >
                      <div className="text-[11.5px] font-medium text-neutral-200">{item.title}</div>
                      <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-neutral-600">{item.prompt}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[86%] space-y-2", message.role === "user" && "items-end")}>
                      {message.reasoning ? (
                        <details className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] px-3 py-2">
                          <summary className="cursor-pointer text-[10px] font-medium text-sky-300/90">
                            Reasoning trace
                          </summary>
                          <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-sky-200/70">
                            {message.reasoning}
                          </pre>
                        </details>
                      ) : null}

                      {message.tools?.length ? (
                        <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5">
                          <div className="mb-1 flex items-center gap-1.5 text-[9.5px] uppercase tracking-wider text-neutral-600">
                            <Terminal className="h-2.5 w-2.5" />
                            {message.tools.length} tool call{message.tools.length === 1 ? "" : "s"}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {message.tools.map((tool) => (
                              <span
                                key={tool.id}
                                className={cn(
                                  "rounded border px-1.5 py-0.5 font-mono text-[9px]",
                                  tool.status === "failed"
                                    ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                                    : tool.status === "done"
                                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                                      : "border-white/10 bg-white/5 text-neutral-400",
                                )}
                              >
                                {tool.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {message.content ? (
                        <div
                          className={cn(
                            "whitespace-pre-wrap rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed",
                            message.role === "user"
                              ? "border-emerald-500/25 bg-emerald-500/[0.09] text-emerald-50"
                              : "border-white/[0.07] bg-white/[0.025] text-neutral-200",
                          )}
                        >
                          {message.content}
                        </div>
                      ) : null}

                      {message.error ? (
                        <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-[10.5px] text-rose-200">
                          {message.error}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}

                {busy ? (
                  <div className="flex justify-start">
                    <div className="max-w-[86%] space-y-2">
                      {streamReasoning ? (
                        <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] px-3 py-2">
                          <div className="mb-1 text-[9.5px] uppercase tracking-wider text-sky-300/70">Reasoning</div>
                          <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-sky-200/70">
                            {streamReasoning}
                          </pre>
                        </div>
                      ) : null}
                      {streamTools.length ? (
                        <div className="flex flex-wrap gap-1">
                          {streamTools.map((tool) => (
                            <span
                              key={tool.id}
                              className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-neutral-400"
                            >
                              {tool.status === "running" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
                              {tool.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-2.5 text-[12px] leading-relaxed text-neutral-200">
                        {streamText ? (
                          <span className="whitespace-pre-wrap">{streamText}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-neutral-500">
                            <span className="flex gap-1">
                              <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400" />
                              <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400 [animation-delay:0.15s]" />
                              <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400 [animation-delay:0.3s]" />
                            </span>
                            {activeAgent?.name} is working
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-white/[0.06] p-3">
            {error && !busy ? (
              <div className="mb-2 rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-2.5 py-1.5 text-[10.5px] text-rose-200">
                {error}
              </div>
            ) : null}
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] focus-within:border-emerald-500/35">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={activeAgent ? `Message ${activeAgent.name}…` : "Select a coworker first"}
                disabled={!activeAgent || busy}
                className="max-h-36 min-h-[46px] w-full resize-none bg-transparent px-3 py-2.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600 disabled:opacity-60"
              />
              <div className="flex items-center justify-between border-t border-white/[0.05] px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 text-[9.5px] text-neutral-600">
                  <MessageSquare className="h-2.5 w-2.5" />
                  Enter to send · Shift+Enter for a new line
                </div>
                <div className="flex items-center gap-1.5">
                  {busy ? (
                    <button
                      type="button"
                      onClick={stop}
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-neutral-300 hover:bg-white/5"
                    >
                      <Square className="h-2.5 w-2.5" />
                      Stop
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!draft.trim() || !activeAgent || busy}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500 text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Send message"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Panel>

        <div className="space-y-3 lg:col-span-2 lg:grid lg:grid-cols-3 lg:gap-3 lg:space-y-0 2xl:col-span-1 2xl:block 2xl:space-y-3">
          <Panel className="p-3.5">
            <SectionHeading title="Runtime context" />
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-600">Coworker</span>
                <span className="truncate font-mono text-neutral-300">{activeAgent?.id ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-600">Provider</span>
                <span className="truncate font-mono text-neutral-300">{activeAgent?.engine ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-600">Model</span>
                <span className="max-w-[140px] truncate font-mono text-neutral-300" title={activeAgent?.model}>
                  {activeAgent?.model || "default"}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-600">Portfolio</span>
                <span className="font-mono text-neutral-300">
                  {portfolio ? `${portfolio.baseCurrency} · ${portfolio.holdings.length} holdings` : "not loaded"}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-600">Current task</span>
                <span className="max-w-[140px] truncate text-right text-neutral-300">
                  {currentRun ? currentRun.stage : "none"}
                </span>
              </div>
            </div>
          </Panel>

          <Panel className="border-amber-500/15 bg-amber-500/[0.03] p-3.5">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-amber-300/90">
              <ShieldCheck className="h-3 w-3" />
              Advisory only
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
              Coworkers cannot approve their own proposals or reach a broker. Any order must pass the deterministic risk gate
              and a human confirmation. Paper mode is the default.
            </p>
          </Panel>

          <Panel className="p-3.5">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-neutral-300">
              <Info className="h-3 w-3 text-neutral-500" />
              One run at a time
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
              The runtime holds an exclusive execution lock: starting another coworker run cancels this one. Stop a run
              before switching.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
