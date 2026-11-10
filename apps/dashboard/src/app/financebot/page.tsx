import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Plus, Search, SendHorizontal, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { fetchAgents, fetchHealth, streamAgentChat, type AgentApiConfig } from "../../lib/api";
import { navigate } from "../shell/nav";

/**
 * FinanceBot Chat — Grok-Bot-style teammate chat workspace.
 * Dark, desktop-app feel: bot sidebar with presence, group chat,
 * mention chips and a streaming composer backed by the local API
 * (`/api/agent-runtime/chat/stream`). Falls back to a demo transcript
 * when the server is offline.
 */

type BotColor = "red" | "green" | "purple" | "blue" | "orange";

type FinanceBotDef = {
  id: string;
  name: string;
  runtimeId: string;
  role: string;
  color: BotColor;
  group?: boolean;
  preview: string;
  time: string;
};

type Message = {
  id: string;
  botId: string; // author bot id
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};

const BOTS: FinanceBotDef[] = [
  { id: "team", name: "Finance Team", runtimeId: "finance-lead-agent", role: "Treasury & allocation", color: "red", group: true, preview: "Expense Bot: Still finishing Q3 reconciliation — then payroll pass/fail.", time: "6:01 PM" },
  { id: "finance", name: "Finance Lead", runtimeId: "finance-lead-agent", role: "Cash vs deployed, NAV", color: "red", preview: "Review the paper portfolio as a CFO would — advisory only.", time: "5:39 PM" },
  { id: "quant", name: "Quant Analyst", runtimeId: "btc-quant-agent", role: "Strategy & signals", color: "green", preview: "Testable hypotheses, entry/exit, invalidation conditions.", time: "5:28 PM" },
  { id: "risk", name: "Risk Guardian", runtimeId: "risk-guardian-agent", role: "Exposure & guardrails", color: "purple", preview: "Downside, concentration, sizing and drawdown checks.", time: "5:12 PM" },
  { id: "market", name: "Market Analyst", runtimeId: "market-research-agent", role: "Research & context", color: "blue", preview: "Bull / base / bear brief with catalysts and uncertainty.", time: "4:47 PM" },
  { id: "execution", name: "Execution Agent", runtimeId: "cline-cli-agent", role: "Paper orders only", color: "orange", preview: "Prepares and reviews simulated order tickets. No live execution.", time: "4:20 PM" },
];

/** Palette order cycled across live coworkers from the agent runtime. */
const LIVE_COLORS: BotColor[] = ["green", "purple", "blue", "orange", "red"];

/** Map a real agent-runtime config onto the chat sidebar shape. */
function toChatBot(agent: AgentApiConfig, index: number): FinanceBotDef {
  const role = agent.role || agent.description || `Runs via ${agent.engine}`;
  const preview = (agent.description || agent.role || "Coworker from the agent runtime.").slice(0, 90);
  return {
    id: agent.id,
    name: agent.name,
    runtimeId: agent.id,
    role,
    color: LIVE_COLORS[index % LIVE_COLORS.length],
    preview,
    time: "",
  };
}

const COLOR_TEXT: Record<BotColor, string> = {
  red: "text-[#ff8d84]",
  green: "text-[#5fd39a]",
  purple: "text-[#b6b3f9]",
  blue: "text-[#79c4f7]",
  orange: "text-[#ff9d6c]",
};

const COLOR_BG: Record<BotColor, string> = {
  red: "bg-[#e5493f]/10 text-[#ff8d84]",
  green: "bg-[#2fb56a]/10 text-[#5fd39a]",
  purple: "bg-[#8f8deb]/10 text-[#b6b3f9]",
  blue: "bg-[#2da0f5]/10 text-[#79c4f7]",
  orange: "bg-[#ef5a2d]/10 text-[#ff9d6c]",
};

const COLOR_FILL: Record<BotColor, string> = {
  red: "#e5493f",
  green: "#2fb56a",
  purple: "#8f8deb",
  blue: "#2da0f5",
  orange: "#ef5a2d",
};

/** Robot head mark with an eye cut-out — one glyph, recolored per bot. */
function BotMark({ color, className }: { color: BotColor; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0", className)} style={{ color: COLOR_FILL[color] }}>
      <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M10 5.5h12c4.14 0 7.5 3.36 7.5 7.5v6c0 4.14-3.36 7.5-7.5 7.5H10c-4.14 0-7.5-3.36-7.5-7.5v-6C2.5 8.86 5.86 5.5 10 5.5ZM9 13.6c0-1.24 1.01-2.25 2.25-2.25h9.5c1.24 0 2.25 1.01 2.25 2.25v.8c0 1.24-1.01 2.25-2.25 2.25h-9.5A2.25 2.25 0 0 1 9 14.4v-.8Z"
        />
      </svg>
    </span>
  );
}

/** Render @Mentions as tinted chips with a tiny bot mark. */
function MessageText({ content, bots }: { content: string; bots: FinanceBotDef[] }) {
  const parts = useMemo(() => content.split(/(@[A-Z][\w]*\s?(?:[A-Z][\w]*)?)/g), [content]);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("@") && part.trim().length > 1) {
          const name = part.replace(/^@/, "").trim();
          const bot = bots.find((b) => b.name.toLowerCase().includes(name.split(" ")[0].toLowerCase()));
          const color: BotColor = bot?.color ?? "red";
          return (
            <span key={i} className={cn("mx-0.5 inline-flex items-center gap-1 rounded-[5px] px-1 py-px align-baseline text-[13px] font-medium", COLOR_BG[color])}>
              <BotMark color={color} className="h-3 w-3" />
              {name}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/** Demo transcript used when the local API is offline (mirrors the design mock). */
const DEMO_MESSAGES: Message[] = [
  { id: "d1", botId: "finance", role: "assistant", content: "Good. Rollback noted. Wait for CTO's public bank confirmation before we touch the payout path." },
  { id: "d2", botId: "team", role: "assistant", content: "Welcome @Quant Analyst and @Market Analyst — ops/finance, anything that needs reconciliation or follow-through.\n\nStep 2: holding the payout matrix until @Risk Guardian confirms the route *.ledger-sync.net publicly. Then payouts → Bank, ACH — pass/fail." },
  { id: "d3", botId: "quant", role: "assistant", content: "Thanks @Finance Lead @Risk Guardian @Execution Agent — acme.finance (primary) and light touch on the founder brand account." },
  { id: "d4", botId: "risk", role: "assistant", content: "Won't get in the way of step 2. Keeping the rebrand budget as-is — waiting until later is the right call. Ping me if the cutover needs copy review." },
  { id: "d5", botId: "finance", role: "assistant", content: "Sounds good @Quant Analyst — I'll ping you only if cutover affects something customer-facing." },
];

export default function FinanceBotPage() {
  const [selectedId, setSelectedId] = useState<string>("team");
  const [server, setServer] = useState<"checking" | "online" | "offline">("checking");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [runtimeAgents, setRuntimeAgents] = useState<AgentApiConfig[] | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Live coworkers from the agent runtime; falls back to the demo bots
   * when the API is unreachable or returns no agents. */
  const bots: FinanceBotDef[] = useMemo(
    () => (runtimeAgents && runtimeAgents.length > 0 ? runtimeAgents.map(toChatBot) : BOTS.slice(1)),
    [runtimeAgents],
  );
  const botList = useMemo(() => [{ ...BOTS[0] }, ...bots], [bots]);
  const botById = useMemo(() => new Map(botList.map((b) => [b.id, b])), [botList]);

  const selected = botById.get(selectedId) ?? botList[0];
  const live = server === "online";

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then(() => {
        if (!cancelled) setServer("online");
        return fetchAgents();
      })
      .then((res) => {
        if (!cancelled) setRuntimeAgents(res.agents ?? []);
      })
      .catch(() => { if (!cancelled) setServer("offline"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, selectedId]);

  const transcript = useMemo(() => {
    if (!live) return [...DEMO_MESSAGES];
    return messages[selectedId] ?? [];
  }, [live, messages, selectedId]);

  const send = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const text = draft.trim();
      if (!text || busy) return;
      if (!live) {
        // Offline demo: echo into the transcript so the UI still feels alive.
        setMessages((prev) => ({
          ...prev,
          [selectedId]: [
            ...(prev[selectedId] ?? []),
            { id: `u${Date.now()}`, botId: selectedId, role: "user", content: text },
            { id: `a${Date.now()}`, botId: selectedId, role: "assistant", content: "Local API is offline — start the server (`pnpm dev:server`) and I'll answer with real paper-portfolio context." },
          ],
        }));
        setDraft("");
        return;
      }

      const userMsg: Message = { id: `u${Date.now()}`, botId: selectedId, role: "user", content: text };
      const streamId = `a${Date.now()}`;
      const streamMsg: Message = { id: streamId, botId: selectedId, role: "assistant", content: "", streaming: true };
      setMessages((prev) => ({ ...prev, [selectedId]: [...(prev[selectedId] ?? []), userMsg, streamMsg] }));
      setDraft("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamAgentChat(selected.runtimeId, text, (event: { type?: string; content?: string; text?: string; message?: { content?: string } }) => {
          const chunk = event?.content ?? event?.text ?? event?.message?.content ?? "";
          if (!chunk) return;
          setMessages((prev) => ({
            ...prev,
            [selectedId]: (prev[selectedId] ?? []).map((m) =>
              m.id === streamId ? { ...m, content: m.content + chunk } : m,
            ),
          }));
        }, controller.signal);
        // Mark stream complete.
        setMessages((prev) => ({
          ...prev,
          [selectedId]: (prev[selectedId] ?? []).map((m) =>
            m.id === streamId ? { ...m, streaming: false, content: m.content || "(empty response)" } : m,
          ),
        }));
      } catch (err) {
        setMessages((prev) => ({
          ...prev,
          [selectedId]: (prev[selectedId] ?? []).map((m) =>
            m.id === streamId
              ? { ...m, streaming: false, content: m.content || `Stream failed: ${err instanceof Error ? err.message : "unknown error"}` }
              : m,
          ),
        }));
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, draft, live, selected.runtimeId, selectedId],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0d0d0d] text-[#f2f2f2]">
      {/* top chrome */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#141414] px-3">
        <button
          type="button"
          onClick={() => navigate("/home")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Home
        </button>
        <div className="mx-auto flex items-center gap-2">
          <span className="relative inline-flex">
            <BotMark color="red" className="h-4 w-4" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-neutral-100">FinanceBot</span>
          <span
            className={cn(
              "rounded-full px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.14em]",
              server === "online" && "bg-emerald-400/10 text-emerald-300",
              server === "offline" && "bg-white/[0.06] text-neutral-500",
              server === "checking" && "bg-white/[0.06] text-neutral-400",
            )}
          >
            {server === "online" ? "live" : server === "offline" ? "demo" : "…"}
          </span>
        </div>
        <div className="w-14" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-white/[0.06] bg-[#141414]">
          <div className="px-3 pb-1.5 pt-3">
            <div className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 text-[12.5px] text-neutral-500">
              <Search className="h-3.5 w-3.5" /> Search
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {botList.map((bot, idx) => {
              const active = bot.id === selectedId;
              return (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => setSelectedId(bot.id)}
                  className={cn(
                    "mb-0.5 flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors",
                    active ? "bg-white/[0.07]" : "hover:bg-white/[0.05]",
                  )}
                >
                  <span className="relative h-7 w-7 shrink-0">
                    <BotMark color={bot.color} className="h-7 w-7" />
                    {live ? (
                      <span className="absolute -bottom-0.5 -left-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#141414] bg-emerald-400" />
                    ) : null}
                    {bot.group ? (
                      <span className="absolute -bottom-1 -right-1.5 rounded-full border border-white/[0.1] bg-[#262626] px-1 font-mono text-[8px] font-semibold text-neutral-400">
                        +2
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold tracking-tight text-neutral-100">{bot.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9.5px] text-neutral-600">{bot.time}</span>
                    </span>
                    <span className="mt-px flex items-center gap-1.5">
                      <span className="truncate text-[11.5px] text-neutral-500">{bot.preview}</span>
                      {!live && idx === 0 ? <span className="h-2 w-2 shrink-0 rounded-full bg-[#0a84ff]" /> : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* chat */}
        <main className="flex min-w-0 flex-1 flex-col bg-[#1c1c1c]">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-4">
            <BotMark color={selected.color} className="h-4 w-4" />
            <span className="text-[13px] font-semibold text-neutral-100">{selected.name}</span>
            <span className="text-[11.5px] text-neutral-600">· {selected.role}</span>
            {!live ? (
              <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
                Demo transcript — server offline
              </span>
            ) : (
              <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-600">{selected.runtimeId}</span>
            )}
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto flex max-w-[680px] flex-col gap-4">
              {transcript.length === 0 ? (
                <div className="mt-16 flex flex-col items-center gap-2 text-center">
                  <BotMark color={selected.color} className="h-10 w-10" />
                  <div className="text-[15px] font-semibold text-neutral-200">{selected.name}</div>
                  <p className="max-w-xs text-[12px] leading-relaxed text-neutral-500">
                    {selected.role}. Ask for a review, a briefing, or a paper-trade checklist — responses stream
                    live from the local agent runtime.
                  </p>
                </div>
              ) : (
                transcript.map((msg) => {
                  const author = botById.get(msg.botId);
                  if (msg.role === "user") {
                    return (
                      <div key={msg.id} className="self-end">
                        <div className="rounded-2xl rounded-tr-md bg-[#ecece8] px-3.5 py-2 text-[13.5px] leading-relaxed text-[#141414]">
                          {msg.content}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={msg.id}>
                      <div className="mb-1 flex items-center gap-1.5">
                        <BotMark color={author?.color ?? "red"} className="h-3.5 w-3.5" />
                        <span className="text-[12px] font-medium text-neutral-500">{author?.name ?? "Bot"}</span>
                        {msg.streaming ? (
                          <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-600">
                            <Sparkles className="h-2.5 w-2.5" /> working
                          </span>
                        ) : null}
                      </div>
                      <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-neutral-200">
                        <MessageText content={msg.content} bots={botList} />
                        {msg.streaming ? <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse rounded-sm bg-neutral-500 align-middle" /> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <form onSubmit={send} className="shrink-0 border-t border-white/[0.06] bg-[#141414] px-6 py-3">
            <div className="mx-auto flex max-w-[680px] items-center gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2">
                <BotMark color={selected.color} className="h-3.5 w-3.5" />
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={live ? `Message ${selected.name}…` : "Server offline — demo mode…"}
                  className="w-full bg-transparent text-[13.5px] text-neutral-100 outline-none placeholder:text-neutral-600"
                />
              </div>
              <button
                type="submit"
                disabled={!draft.trim() || busy}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-emerald-950 transition-opacity hover:bg-emerald-400 disabled:opacity-40"
                aria-label="Send"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </div>
            <div className="mx-auto mt-1.5 flex max-w-[680px] items-center gap-1 text-[10px] text-neutral-600">
              <Plus className="h-3 w-3" /> Paper mode · advisory only · orders stay behind the risk pipeline
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}
