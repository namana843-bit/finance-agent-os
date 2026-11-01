import { useMemo } from "react";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  Clock3,
  Hash,
  Plus,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { LEGACY_SCREENS, PRIMARY_NAV, navigate } from "./nav";
import { avatarTone, agentInitials, relativeTime, useWorkspace } from "./workspace-data";

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <div className="relative flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-emerald-400 to-teal-600 text-[13px] font-bold text-emerald-950 shadow-[0_0_20px_-6px_rgba(52,211,153,0.7)]">
        F
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[#0a0b0e] bg-emerald-400" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-none tracking-tight text-neutral-100">FinanceBot</div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-600">
          AI financial teammate
        </div>
      </div>
    </div>
  );
}

function GroupLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between px-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-600">{children}</span>
      {action}
    </div>
  );
}

export function Sidebar({ activeRoute }: { activeRoute: string }) {
  const { agents, threads, runs, serverState, health } = useWorkspace();

  const coworkerShortcuts = useMemo(() => agents.slice(0, 5), [agents]);

  const channelShortcuts = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ channel: string; title: string }> = [];
    for (const thread of threads) {
      const channel = thread.channelId ?? "general";
      if (seen.has(channel)) continue;
      seen.add(channel);
      result.push({ channel, title: thread.title });
      if (result.length >= 4) break;
    }
    return result;
  }, [threads]);

  const recentTasks = useMemo(
    () =>
      [...runs]
        .sort((a, b) => (Date.parse(b.updatedAt ?? b.createdAt) || 0) - (Date.parse(a.updatedAt ?? a.createdAt) || 0))
        .slice(0, 3),
    [runs],
  );

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-white/[0.06] bg-[#0a0b0e]">
      <div className="px-3 pb-3 pt-4">
        <Logo />
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="flex w-full items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:border-white/15 hover:bg-white/[0.05]"
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] text-neutral-300">
            <Boxes className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11.5px] font-medium text-neutral-200">Paper workspace</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-neutral-600">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  serverState === "ready" ? "bg-emerald-400" : serverState === "error" ? "bg-rose-400" : "bg-neutral-500",
                )}
              />
              {serverState === "ready" ? `Local API · ${health?.version ?? "online"}` : "Local API offline"}
            </div>
          </div>
          <ChevronRight className="h-3.5 w-3.5 text-neutral-600" />
        </button>
      </div>

      <nav className="px-2">
        {PRIMARY_NAV.map((item) => {
          const Icon = item.icon;
          const active = item.route === activeRoute;
          return (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              className={cn(
                "group mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] transition-colors",
                active
                  ? "bg-white/[0.07] font-medium text-neutral-50"
                  : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
              )}
            >
              <Icon
                className={cn(
                  "h-[15px] w-[15px] shrink-0",
                  active ? "text-emerald-400" : "text-neutral-500 group-hover:text-neutral-400",
                )}
              />
              <span className="truncate">{item.label}</span>
              {item.route === "/tasks" && runs.length > 0 ? (
                <span className="ml-auto rounded bg-white/[0.06] px-1.5 py-px font-mono text-[9px] text-neutral-400">
                  {runs.length}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        <div>
          <GroupLabel
            action={
              <button
                type="button"
                onClick={() => navigate("/coworkers")}
                className="text-neutral-600 transition-colors hover:text-neutral-300"
                aria-label="Open coworkers"
              >
                <Plus className="h-3 w-3" />
              </button>
            }
          >
            Coworkers
          </GroupLabel>
          {coworkerShortcuts.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate("/coworkers")}
              className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-neutral-600 hover:bg-white/[0.03]"
            >
              No coworkers loaded
            </button>
          ) : (
            coworkerShortcuts.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => navigate("/workspace", { coworker: agent.id })}
                className="group mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9.5px] font-semibold ring-1",
                    avatarTone(agent.id),
                  )}
                >
                  {agentInitials(agent.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] text-neutral-300 group-hover:text-neutral-100">
                    {agent.name}
                  </span>
                  <span className="block truncate text-[9.5px] text-neutral-600">
                    {agent.model || agent.engine || "default model"}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div>
          <GroupLabel>Channels</GroupLabel>
          {channelShortcuts.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate("/channels")}
              className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-neutral-600 hover:bg-white/[0.03]"
            >
              No channels yet
            </button>
          ) : (
            channelShortcuts.map((item) => (
              <button
                key={item.channel}
                type="button"
                onClick={() => navigate("/channels", { channel: item.channel })}
                className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left transition-colors hover:bg-white/[0.04]"
              >
                <Hash className="h-3 w-3 shrink-0 text-neutral-600" />
                <span className="truncate text-[11.5px] text-neutral-400 group-hover:text-neutral-200">
                  {item.channel}
                </span>
              </button>
            ))
          )}
        </div>

        <div>
          <GroupLabel>Recent tasks</GroupLabel>
          {recentTasks.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate("/tasks")}
              className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-neutral-600 hover:bg-white/[0.03]"
            >
              Queue is empty
            </button>
          ) : (
            recentTasks.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => navigate("/tasks", { run: run.id })}
                className="group flex w-full items-start gap-2 rounded-lg px-2.5 py-[6px] text-left transition-colors hover:bg-white/[0.04]"
              >
                <Clock3 className="mt-0.5 h-3 w-3 shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-neutral-400 group-hover:text-neutral-200">
                    {run.proposal
                      ? `${run.proposal.side.toUpperCase()} ${run.proposal.symbol}`
                      : `Run ${run.id.slice(0, 6)}`}
                  </span>
                  <span className="block text-[9.5px] text-neutral-600">
                    {run.status.replace(/_/g, " ")} · {relativeTime(Date.parse(run.updatedAt ?? run.createdAt))}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div>
          <GroupLabel>More screens</GroupLabel>
          {LEGACY_SCREENS.map((item) => (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left transition-colors hover:bg-white/[0.04]"
            >
              <item.icon className="h-3 w-3 shrink-0 text-neutral-600" />
              <span className="truncate text-[11px] text-neutral-500 group-hover:text-neutral-300">{item.label}</span>
              <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-white/[0.06] p-2">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.04]"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.07] text-[10px] font-semibold text-neutral-300">
            N
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-neutral-300">Your workspace</span>
            <span className="flex items-center gap-1 text-[9.5px] text-neutral-600">
              <ShieldCheck className="h-2.5 w-2.5" /> Paper mode · no live trading
            </span>
          </span>
          <Settings2 className="h-3.5 w-3.5 text-neutral-600" />
        </button>
      </div>
    </aside>
  );
}

export function SidebarPreviewBadges() {
  return (
    <div className="flex items-center gap-1 text-neutral-700">
      <Users className="h-3 w-3" />
      <Activity className="h-3 w-3" />
    </div>
  );
}
