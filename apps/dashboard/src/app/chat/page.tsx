"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotSidebar } from "@/components/chat/BotSidebar";
import { ChatCenter } from "@/components/chat/ChatCenter";
import { ContextRail } from "@/components/chat/ContextRail";
import { type FinanceEvent } from "@/lib/api";
import {
  approveProposal,
  createThread,
  fetchBots,
  fetchMessages,
  fetchProposals,
  fetchThreads,
  rejectProposal,
  sendChatMessage,
  type Bot,
  type ChatMessage,
  type ChatThread,
  type TradeProposal,
} from "@/lib/chat-api";
import {
  fetchLlmModels,
  setBotModel,
  type LlmModelInfo,
} from "@/lib/llm-api";
import { useFinanceEvents } from "@/lib/useFinanceEvents";

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function ChatPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [activeBot, setActiveBot] = useState<Bot | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await fetchLlmModels());
    } catch {
      // Non-fatal: model switcher degrades to the deterministic label.
    }
  }, []);

  // Ref mirrors for stable callbacks (the SSE hook captures onEvent once).
  const threadsRef = useRef<ChatThread[]>([]);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThread?.id ?? null;
  // Message count right after our send; the busy poll stops once it grows.
  const baselineRef = useRef(0);

  const { connected } = useFinanceEvents(
    undefined,
    useCallback((ev: FinanceEvent) => {
      const id = activeThreadIdRef.current;
      if (id && ev.threadId === id) {
        void fetchMessages(id)
          .then((msgs) => setMessages(msgs))
          .catch(() => {});
      }
    }, [])
  );

  const handleSelectBot = useCallback(async (bot: Bot) => {
    setActiveBot(bot);
    setActiveThread(null);
    setMessages([]);
    setError(null);
    try {
      const known = threadsRef.current;
      let thread = known.find((t) => t.metadata?.botId === bot.id) ?? null;
      if (!thread) {
        thread = await createThread(bot.name, bot.id);
        const created = thread;
        setThreads((prev) => [created, ...prev]);
      }
      setActiveThread(thread);
      const [msgs, props] = await Promise.all([
        fetchMessages(thread.id),
        fetchProposals(),
      ]);
      setMessages(msgs);
      setProposals(props);
    } catch (e) {
      setError(errText(e, "Failed to load conversation"));
    }
  }, []);

  const handleSelectThread = useCallback(async (id: string) => {
    setError(null);
    try {
      const known = threadsRef.current;
      const thread = known.find((t) => t.id === id) ?? null;
      if (!thread) return;
      setActiveThread(thread);
      const [msgs, props] = await Promise.all([
        fetchMessages(thread.id),
        fetchProposals(),
      ]);
      setMessages(msgs);
      setProposals(props);
    } catch (e) {
      setError(errText(e, "Failed to load thread"));
    }
  }, []);

  const handleNewChat = useCallback(async () => {
    if (!activeBot) return;
    setError(null);
    try {
      const thread = await createThread(activeBot.name, activeBot.id);
      setThreads((prev) => [thread, ...prev]);
      setActiveThread(thread);
      const [msgs, props] = await Promise.all([
        fetchMessages(thread.id),
        fetchProposals(),
      ]);
      setMessages(msgs);
      setProposals(props);
    } catch (e) {
      setError(errText(e, "Failed to create chat"));
    }
  }, [activeBot]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [b, t] = await Promise.all([fetchBots(), fetchThreads()]);
        if (cancelled) return;
        setBots(b);
        setThreads(t);
        threadsRef.current = t;
        const first = b[0] ?? null;
        if (first) await handleSelectBot(first);
      } catch (e) {
        if (!cancelled) setError(errText(e, "Failed to load chat"));
      }
      if (!cancelled) await refreshModels();
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [handleSelectBot, refreshModels]);

  const activeThreadId = activeThread?.id ?? null;

  // While busy (waiting on an agent reply), refresh messages + proposals
  // every 3s. Stops on the first new message or after a 60s safety timeout.
  useEffect(() => {
    if (!busy || !activeThreadId) return;
    const threadId = activeThreadId;
    const poll = setInterval(() => {
      void (async () => {
        try {
          const [msgs, props] = await Promise.all([
            fetchMessages(threadId),
            fetchProposals(),
          ]);
          setMessages(msgs);
          setProposals(props);
          if (msgs.length > baselineRef.current) setBusy(false);
        } catch {
          // Transient poll failure — keep polling until the timeout.
        }
      })();
    }, 3000);
    const stop = setTimeout(() => setBusy(false), 60000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [busy, activeThreadId]);

  const handleSend = useCallback(async (text: string) => {
    const threadId = activeThreadIdRef.current;
    const message = text.trim();
    if (!threadId || !message) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendChatMessage(message, threadId);
      // The server may rotate/update the thread — adopt it.
      setActiveThread(res.thread);
      setThreads((prev) => {
        const i = prev.findIndex((t) => t.id === res.thread.id);
        if (i === -1) return [res.thread, ...prev];
        const next = [...prev];
        next[i] = res.thread;
        return next;
      });
      const msgs = await fetchMessages(res.thread.id);
      setMessages(msgs);
      baselineRef.current = msgs.length;
    } catch (e) {
      setError(errText(e, "Failed to send message"));
      setBusy(false);
    }
  }, []);

  const handleApprove = useCallback(async (id: string) => {
    const threadId = activeThreadIdRef.current;
    setError(null);
    try {
      await approveProposal(id);
      const [props, msgs] = threadId
        ? await Promise.all([fetchProposals(), fetchMessages(threadId)])
        : [await fetchProposals(), [] as ChatMessage[]];
      setProposals(props);
      if (threadId) setMessages(msgs);
    } catch (e) {
      setError(errText(e, "Failed to approve proposal"));
    }
  }, []);

  const handleModelChange = useCallback(
    async (model: string) => {
      if (!activeBot) return;
      setError(null);
      try {
        await setBotModel(activeBot.id, model);
        await refreshModels();
      } catch (e) {
        setError(errText(e, "Failed to update model"));
      }
    },
    [activeBot, refreshModels]
  );

  const handleReject = useCallback(async (id: string) => {
    const threadId = activeThreadIdRef.current;
    setError(null);
    try {
      await rejectProposal(id);
      const [props, msgs] = threadId
        ? await Promise.all([fetchProposals(), fetchMessages(threadId)])
        : [await fetchProposals(), [] as ChatMessage[]];
      setProposals(props);
      if (threadId) setMessages(msgs);
    } catch (e) {
      setError(errText(e, "Failed to reject proposal"));
    }
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0b0e14] text-gray-100">
      {/* Far-left icon rail */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-white/10 py-3">
        <a
          href="/chat"
          title="Chats"
          className="rounded-lg bg-white/10 px-2.5 py-2 text-lg leading-none"
        >
          💬
        </a>
        <a
          href="/engines"
          title="Engines"
          className="rounded-lg px-2.5 py-2 text-lg leading-none text-gray-400 hover:bg-white/5 hover:text-gray-200"
        >
          ⚙
        </a>
        {["📊", "🗓", "🧩", "📁", "❓"].map((icon) => (
          <button
            key={icon}
            type="button"
            title="Coming soon"
            className="cursor-default rounded-lg px-2.5 py-2 text-lg leading-none text-gray-600 hover:bg-white/5"
          >
            {icon}
          </button>
        ))}
      </nav>

      {/* Bot list column */}
      <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-white/[0.02] md:flex">
        <div className="px-3 pb-1 pt-3">
          <button
            type="button"
            onClick={() => void handleNewChat()}
            disabled={!activeBot}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-sm font-medium text-gray-200 hover:bg-white/10 disabled:opacity-40"
          >
            ＋ New chat
          </button>
        </div>
        <BotSidebar
          bots={bots}
          activeBotId={activeBot?.id ?? null}
          onSelect={(bot) => void handleSelectBot(bot)}
          connected={connected}
        />
      </aside>

      {/* Center */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatCenter
          bot={activeBot}
          thread={activeThread}
          messages={messages}
          proposals={proposals}
          busy={busy}
          onSend={(text) => void handleSend(text)}
          onApprove={(id) => void handleApprove(id)}
          onReject={(id) => void handleReject(id)}
          models={models}
          onModelChange={(model) => void handleModelChange(model)}
          threads={threads}
          onThreadChange={(id) => void handleSelectThread(id)}
          showToggleRail={{
            open: railOpen,
            onToggle: () => setRailOpen((v) => !v),
          }}
        />
      </main>

      {/* Right context rail */}
      {railOpen ? (
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-white/[0.02] lg:block">
          <ContextRail />
        </aside>
      ) : null}

      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
