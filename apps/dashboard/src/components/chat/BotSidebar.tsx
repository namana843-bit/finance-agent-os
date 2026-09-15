"use client";

import type { Bot } from "@/lib/chat-api";

const AVATAR_BG = [
  "bg-violet-600",
  "bg-sky-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-indigo-600",
  "bg-cyan-600",
  "bg-fuchsia-600",
];

export function avatarBgFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_BG[h % AVATAR_BG.length];
}

export function BotSidebar({
  bots,
  activeBotId,
  onSelect,
  connected,
}: {
  bots: Bot[];
  activeBotId: string | null;
  onSelect: (bot: Bot) => void;
  connected: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-2 pb-4">
      <div className="flex items-center justify-between px-2 pb-2 pt-1">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          Bots
        </h2>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] tabular-nums text-gray-400">
          {bots.length}
        </span>
      </div>
      {bots.length === 0 && (
        <div className="px-3 py-2 text-xs text-gray-500">
          No agents available.
        </div>
      )}
      {bots.map((bot) => {
        const active = bot.id === activeBotId;
        return (
          <button
            key={bot.id}
            onClick={() => onSelect(bot)}
            className={`flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors ${
              active ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            <span className="relative shrink-0">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full text-base leading-none text-white ${avatarBgFor(bot.id)}`}
                aria-hidden
              >
                {bot.avatar ?? "🤖"}
              </span>
              <span
                aria-label={connected ? "online" : "offline"}
                title={connected ? "online" : "offline"}
                className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0b0e14] ${
                  connected ? "bg-green-500" : "bg-gray-500"
                }`}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-gray-100">
                {bot.name}
              </span>
              <span className="block truncate text-[11px] text-gray-500">
                {bot.personality ?? bot.agentId}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
