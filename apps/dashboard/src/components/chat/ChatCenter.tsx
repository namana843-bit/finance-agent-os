"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Bot,
  ChatMessage,
  ChatThread,
  TradeProposal,
} from "@/lib/chat-api";
import type { LlmModelInfo } from "@/lib/llm-api";
import { ApprovalCard } from "./ApprovalCard";
import { avatarBgFor } from "./BotSidebar";

type ChatCenterProps = {
  bot: Bot | null;
  thread: ChatThread | null;
  messages: ChatMessage[];
  proposals: TradeProposal[];
  busy: boolean;
  onSend: (text: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  models?: LlmModelInfo[];
  onModelChange?: (model: string) => void;
  threads?: ChatThread[];
  onThreadChange?: (id: string) => void;
  showToggleRail?: { open: boolean; onToggle: () => void };
};

const MODEL_ALTERNATIVES = ["llama3.1", "mistral", "gpt-4o-mini"];

const QUICK_PROMPTS = ["Analyze BTC", "Portfolio summary", "Assess risk"];

function formatTime(ts: ChatMessage["timestamp"]): string {
  try {
    const d =
      typeof ts === "number" ? new Date(ts) : new Date(String(ts as unknown));
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function instructionsKey(threadId: string): string {
  return `chat-instructions:${threadId}`;
}

export function ChatCenter({
  bot,
  thread,
  messages,
  proposals,
  busy,
  onSend,
  onApprove,
  onReject,
  models,
  onModelChange,
  threads,
  onThreadChange,
  showToggleRail,
}: ChatCenterProps) {
  const [draft, setDraft] = useState("");
  const [instructions, setInstructions] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, proposals.length, thread?.id]);

  // Group instructions persist per-thread in localStorage (decorative-but-functional).
  useEffect(() => {
    if (!thread) {
      setInstructions("");
      return;
    }
    try {
      setInstructions(
        window.localStorage.getItem(instructionsKey(thread.id)) ?? ""
      );
    } catch {
      setInstructions("");
    }
  }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleInstructionsChange(v: string) {
    setInstructions(v);
    if (!thread) return;
    try {
      window.localStorage.setItem(instructionsKey(thread.id), v);
    } catch {
      // Non-fatal: instructions simply won't persist.
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || busy || !bot) return;
    onSend(text);
    setDraft("");
  }

  const pendingProposals = proposals.filter(
    (p) => String(p.status).toLowerCase() === "pending"
  );

  if (!bot) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center">
        <p className="text-sm text-gray-500">
          Select an agent to start chatting
        </p>
      </div>
    );
  }

  const composerDisabled = busy || !bot;
  const dividerTime =
    messages.length > 0 && messages[0].timestamp !== undefined
      ? formatTime(messages[0].timestamp)
      : formatTime(Date.now());

  return (
    <div className="flex h-full min-h-[320px] flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base leading-none text-white ${avatarBgFor(bot.id)}`}
          aria-hidden
        >
          {bot.avatar ?? "🤖"}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold tracking-tight text-gray-100">
            {bot.name}
          </div>
          {threads && onThreadChange ? (
            <select
              value={thread?.id ?? ""}
              onChange={(e) => {
                if (e.target.value) onThreadChange(e.target.value);
              }}
              title="Switch thread"
              className="max-w-[180px] cursor-pointer truncate bg-transparent text-[11px] text-gray-400 hover:text-gray-200 focus:outline-none"
            >
              <option value="" disabled>
                All threads {threads.length} ▾
              </option>
              {threads.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#0b0e14]">
                  {(t.title || "Untitled").slice(0, 32)}
                </option>
              ))}
            </select>
          ) : (
            <div className="truncate text-[11px] text-gray-500">
              {thread?.title ?? "New conversation"}
            </div>
          )}
        </div>
        {models && onModelChange
          ? (() => {
              const entry = models.find((m) => m.botId === bot.id);
              if (!entry || entry.provider === "none") {
                return (
                  <span
                    className="ml-1 shrink-0 text-[11px] text-gray-600"
                    title={entry?.reason ?? "no model info for this bot"}
                  >
                    deterministic
                  </span>
                );
              }
              const options = Array.from(
                new Set([entry.model, ...MODEL_ALTERNATIVES])
              );
              return (
                <select
                  value={entry.model}
                  onChange={(e) => onModelChange(e.target.value)}
                  title={
                    entry.configured
                      ? `${entry.provider} • ${entry.reason}`
                      : `${entry.provider} • not active: ${entry.reason}`
                  }
                  className={`ml-1 max-w-[140px] shrink-0 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-gray-300 focus:border-white/30 focus:outline-none${entry.configured ? "" : " opacity-60"}`}
                >
                  {options.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              );
            })()
          : null}
        <div className="ml-auto flex shrink-0 items-center gap-1 text-gray-400">
          <button
            type="button"
            title="Coming soon"
            className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
          >
            🔍
          </button>
          <button
            type="button"
            title="Coming soon"
            className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
          >
            📤
          </button>
          <button
            type="button"
            title="Coming soon"
            className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
          >
            📞
          </button>
          <button
            type="button"
            title="Coming soon"
            className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
          >
            📁
          </button>
          <span className="ml-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-gray-300">
            Lead · {bot.name}
          </span>
          <a
            href="/engines"
            title="Engine settings"
            className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
          >
            ⚙
          </a>
          {showToggleRail ? (
            <button
              type="button"
              onClick={showToggleRail.onToggle}
              title={showToggleRail.open ? "Hide context panel" : "Show context panel"}
              className="rounded-md px-1.5 py-1 text-sm hover:bg-white/10 hover:text-gray-200"
            >
              {showToggleRail.open ? "◧" : "◨"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Group instructions bar */}
      <div className="border-b border-white/10 px-4 py-2">
        <input
          value={instructions}
          onChange={(e) => handleInstructionsChange(e.target.value)}
          placeholder="📌 Add group instructions…"
          className="w-full bg-transparent text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none"
        />
      </div>

      {/* Quick prompts when thread empty */}
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              disabled={composerDisabled}
              onClick={() => onSend(q)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/10 disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Message list */}
      <div className="min-h-[160px] flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          <span className="h-px flex-1 bg-white/10" />
          <span>Today {dividerTime}</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>
        {messages.length === 0 ? (
          <p className="pt-6 text-center text-xs text-gray-600">
            No messages yet — say hello or try a quick prompt above.
          </p>
        ) : (
          messages.map((m) => {
            const role = String(m.role).toLowerCase();
            if (role === "system") {
              return (
                <div key={m.id} className="flex justify-center">
                  <span className="max-w-full break-words text-center text-[11px] text-gray-600">
                    {m.content}
                  </span>
                </div>
              );
            }
            const isUser = role === "user";
            if (isUser) {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl bg-white/[0.14] px-4 py-2.5">
                    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-100">
                      {m.content}
                    </div>
                    {m.timestamp !== undefined && (
                      <div className="mt-1 text-right text-[10px] text-gray-400">
                        {formatTime(m.timestamp)}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[85%]">
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs leading-none text-white ${avatarBgFor(bot.id)}`}
                      aria-hidden
                    >
                      {bot.avatar ?? "🤖"}
                    </span>
                    <span className="text-xs font-semibold text-gray-300">
                      {bot.name}
                    </span>
                  </div>
                  <div className="rounded-2xl bg-white/[0.07] px-4 py-2.5">
                    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-100">
                      {m.content}
                    </div>
                    {m.timestamp !== undefined && (
                      <div className="mt-1 text-[10px] text-gray-500">
                        {formatTime(m.timestamp)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Pending proposals above composer */}
      {pendingProposals.length > 0 && (
        <div className="space-y-2 border-t border-white/10 px-4 pt-2">
          {pendingProposals.map((p) => (
            <ApprovalCard
              key={p.id}
              proposal={p}
              onApprove={onApprove}
              onReject={onReject}
              busy={busy}
            />
          ))}
        </div>
      )}

      {/* Composer pill */}
      <div className="px-4 pb-4 pt-2">
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-1.5">
          <button
            type="button"
            title="Coming soon"
            className="shrink-0 rounded-full px-2 py-1 text-sm text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            📎
          </button>
          <button
            type="button"
            title="Coming soon"
            className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-gray-300 hover:bg-white/10"
          >
            Goal
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={composerDisabled}
            placeholder={`Message ${bot?.name ?? "…"} — ${bot?.name ?? "…"} responds`}
            className="min-w-0 flex-1 bg-transparent px-2 text-[13px] text-gray-100 placeholder:text-gray-600 focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={submit}
            disabled={composerDisabled || !draft.trim()}
            title="Send"
            className="shrink-0 rounded-full px-2 py-1 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-30"
          >
            {busy ? "…" : "➤"}
          </button>
        </div>
      </div>
    </div>
  );
}
