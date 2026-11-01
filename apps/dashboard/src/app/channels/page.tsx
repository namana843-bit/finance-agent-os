import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Hash, MessageSquare, Radio, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";
import { fetchJson } from "../../lib/fetch";
import { navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  StatusPill,
} from "../shell/ui";
import { currentHashQuery } from "../shell/nav";
import { relativeTime, toMillis, useWorkspace, type ThreadMessage } from "../shell/workspace-data";

export default function ChannelsPage() {
  const { threads, threadsState, threadsError, agents, refresh } = useWorkspace();
  const initialChannel = currentHashQuery().get("channel");
  const [channel, setChannel] = useState<string | null>(initialChannel);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [messagesState, setMessagesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [messagesError, setMessagesError] = useState("");

  const grouped = useMemo(() => {
    const map = new Map<string, typeof threads>();
    for (const thread of threads) {
      const key = thread.channelId ?? "general";
      const list = map.get(key) ?? [];
      list.push(thread);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([name, items]) => ({
        name,
        items: [...items].sort(
          (a, b) => (toMillis(b.updatedAt ?? b.createdAt) || 0) - (toMillis(a.updatedAt ?? a.createdAt) || 0),
        ),
      }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [threads]);

  const activeChannel = channel ?? grouped[0]?.name ?? null;
  const activeThreads = grouped.find((item) => item.name === activeChannel)?.items ?? [];
  const activeThread = activeThreads.find((thread) => thread.id === threadId) ?? null;

  const loadMessages = useCallback(async (id: string) => {
    setMessagesState("loading");
    setMessagesError("");
    try {
      const data = await fetchJson<{ messages: ThreadMessage[] }>(`/api/threads/${encodeURIComponent(id)}/messages?limit=100`);
      setMessages(data.messages ?? []);
      setMessagesState("ready");
    } catch (error) {
      setMessages([]);
      setMessagesState("error");
      setMessagesError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (threadId) void loadMessages(threadId);
  }, [threadId, loadMessages]);

  const openThread = (id: string) => {
    setThreadId(id);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Persistent rooms"
        title="Channels"
        description="Research and trading conversations stored by the local chat service. Channels appear once a thread exists."
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-[11.5px] text-neutral-300 transition-colors hover:bg-white/5"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        }
      />

      <div className="grid min-h-[520px] gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Panel className="flex flex-col p-2">
          <div className="px-2 pb-2 pt-1">
            <MonoLabel>Rooms</MonoLabel>
          </div>
          {threadsState === "loading" ? (
            <div className="space-y-1 p-1">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-8 animate-pulse rounded-md bg-white/[0.03]" />
              ))}
            </div>
          ) : threadsState === "error" ? (
            <div className="p-2 text-[10.5px] leading-relaxed text-rose-300/80">
              Chat service unavailable. {threadsError}
            </div>
          ) : grouped.length === 0 ? (
            <div className="p-2 text-[10.5px] leading-relaxed text-neutral-600">
              No channels yet. Create a thread from a coworker conversation to start one.
            </div>
          ) : (
            grouped.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => {
                  setChannel(item.name);
                  setThreadId(null);
                }}
                className={cn(
                  "mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  item.name === activeChannel
                    ? "bg-white/[0.07] text-neutral-100"
                    : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
                )}
              >
                <Hash className="h-3 w-3 shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">{item.name}</span>
                <span className="rounded bg-white/[0.06] px-1.5 py-px font-mono text-[9px] text-neutral-500">
                  {item.items.length}
                </span>
              </button>
            ))
          )}
        </Panel>

        <Panel className="flex min-h-0 flex-col">
          {threadsState === "error" ? (
            <div className="p-4">
              <ErrorBanner title="Channels unavailable" message={threadsError} onRetry={() => void refresh()} />
            </div>
          ) : activeThread ? (
            <>
              <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
                <button
                  type="button"
                  onClick={() => setThreadId(null)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-200"
                  aria-label="Back to threads"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-neutral-100">{activeThread.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-600">
                    <Hash className="h-2.5 w-2.5" />
                    {activeChannel}
                    <span>·</span>
                    <span>thread {activeThread.id.slice(0, 8)}</span>
                  </div>
                </div>
                {messagesState === "loading" ? <InlineSpinner className="text-neutral-500" /> : null}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {messagesState === "loading" ? (
                  <LoadingBlock rows={3} label="Loading messages" />
                ) : messagesState === "error" ? (
                  <ErrorBanner
                    title="Could not load messages"
                    message={messagesError}
                    onRetry={() => void loadMessages(activeThread.id)}
                  />
                ) : messages.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<MessageSquare className="h-4 w-4" />}
                    title="This thread has no messages"
                    description="Messages appear here once a coworker or you post into the thread."
                  />
                ) : (
                  <div className="space-y-3">
                    {messages.map((message) => {
                      const isUser = message.role === "user";
                      const author = agents.find((agent) => agent.id === message.botId);
                      return (
                        <div key={message.id} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                          <div
                            className={cn(
                              "max-w-[80%] rounded-xl border px-3 py-2",
                              isUser
                                ? "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-50"
                                : "border-white/[0.07] bg-white/[0.025] text-neutral-200",
                            )}
                          >
                            <div className="mb-1 flex items-center gap-2 text-[9.5px] text-neutral-500">
                              <span className="font-medium">
                                {isUser ? "You" : author?.name ?? (message.role === "assistant" ? "Coworker" : message.role)}
                              </span>
                              {message.timestamp ? <span>{relativeTime(toMillis(message.timestamp))}</span> : null}
                            </div>
                            <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed">{message.content}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <div className="flex items-center gap-2">
                  <Hash className="h-3.5 w-3.5 text-neutral-600" />
                  <span className="text-[12.5px] font-medium text-neutral-100">{activeChannel ?? "No channel selected"}</span>
                </div>
                <StatusPill
                  label={`${activeThreads.length} thread${activeThreads.length === 1 ? "" : "s"}`}
                  className="border-white/10 bg-white/5 text-neutral-400"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {threadsState === "loading" ? (
                  <LoadingBlock rows={3} label="Loading threads" />
                ) : activeThreads.length === 0 ? (
                  <EmptyState
                    icon={<Radio className="h-4 w-4" />}
                    title="No threads in this channel"
                    description="Threads are created by the chat service when a conversation starts. Open a coworker chat to begin one."
                    action={
                      <button
                        type="button"
                        onClick={() => navigate("/workspace")}
                        className="rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 hover:bg-emerald-400"
                      >
                        Start a conversation
                      </button>
                    }
                  />
                ) : (
                  <div className="space-y-2">
                    {activeThreads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => openThread(thread.id)}
                        className="flex w-full items-start gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.04]"
                      >
                        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-600" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] text-neutral-200">{thread.title}</span>
                          <span className="mt-0.5 flex items-center gap-2 text-[9.5px] text-neutral-600">
                            <span>{thread.botId ?? "unassigned"}</span>
                            <span>·</span>
                            <span>{relativeTime(toMillis(thread.updatedAt ?? thread.createdAt))}</span>
                            {thread.messageCount ? (
                              <>
                                <span>·</span>
                                <span>{thread.messageCount} messages</span>
                              </>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
