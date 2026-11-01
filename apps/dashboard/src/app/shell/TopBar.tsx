import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  ChevronRight,
  Command,
  LayoutPanelLeft,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { LEGACY_SCREENS, PRIMARY_NAV, navigate, routeLabel } from "./nav";
import { agentInitials, avatarTone, relativeTime, useWorkspace, type ActivityItem } from "./workspace-data";

function activityDot(tone: ActivityItem["tone"]) {
  switch (tone) {
    case "good":
      return "bg-emerald-400";
    case "warn":
      return "bg-amber-400";
    case "bad":
      return "bg-rose-400";
    default:
      return "bg-neutral-500";
  }
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { agents } = useWorkspace();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pages = [...PRIMARY_NAV, ...LEGACY_SCREENS]
      .filter((item) => !needle || `${item.label} ${item.description}`.toLowerCase().includes(needle))
      .map((item) => ({
        id: `page-${item.route}`,
        label: item.label,
        hint: item.description,
        icon: item.icon,
        run: () => navigate(item.route),
      }));
    const coworkers = agents
      .filter((agent) => !needle || `${agent.name} ${agent.role ?? ""} ${agent.model ?? ""}`.toLowerCase().includes(needle))
      .map((agent) => ({
        id: `agent-${agent.id}`,
        label: agent.name,
        hint: `${agent.role ?? "Coworker"} · ${agent.model ?? agent.engine ?? "default model"}`,
        icon: Users,
        run: () => navigate("/workspace", { coworker: agent.id }),
      }));
    return [...pages.slice(0, 7), ...coworkers.slice(0, 6)];
  }, [agents, query]);

  const go = (run: () => void) => {
    run();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 px-4 pt-[12vh] backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-[#0d0f13] shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3.5 py-3">
          <Search className="h-4 w-4 text-neutral-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && results[0]) go(results[0].run);
            }}
            placeholder="Search pages, coworkers, models..."
            className="flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-600 transition-colors hover:bg-white/5 hover:text-neutral-300"
            aria-label="Close search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11.5px] text-neutral-500">
              No matches. Try a page name or a coworker.
            </div>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => go(item.run)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
              >
                <item.icon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-neutral-200">{item.label}</span>
                  <span className="block truncate text-[10px] text-neutral-600">{item.hint}</span>
                </span>
                <ChevronRight className="h-3 w-3 text-neutral-700" />
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/[0.07] px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-neutral-600">
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}

export function TopBar({ activeRoute }: { activeRoute: string }) {
  const { activity, agents, runs, serverState, refreshing, refresh, lastUpdated } = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setNotificationsOpen(false);
  }, [activeRoute]);

  const live = serverState === "ready";
  const runningCount = runs.filter((run) => run.status === "running").length;
  const awaitingCount = runs.filter((run) => run.status === "awaiting_approval").length;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] bg-[#0b0c10]/80 px-5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-neutral-600">
          <LayoutPanelLeft className="h-3.5 w-3.5" />
          <span>FinanceBot</span>
          <ChevronRight className="h-3 w-3 text-neutral-700" />
          <span className="truncate font-medium text-neutral-300">{routeLabel(activeRoute)}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="group hidden items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[11.5px] text-neutral-500 transition-colors hover:border-white/15 hover:text-neutral-300 md:flex"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="w-32 text-left">Search workspace</span>
            <span className="flex items-center gap-0.5 rounded border border-white/10 bg-white/[0.04] px-1 py-px font-mono text-[9px] text-neutral-500">
              <Command className="h-2.5 w-2.5" />K
            </span>
          </button>

          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
              live
                ? "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300"
                : "border-neutral-700 bg-white/[0.03] text-neutral-500",
            )}
            title={live ? "Local API and event stream connected" : "Local API unreachable"}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", live ? "animate-pulse bg-emerald-400" : "bg-neutral-500")} />
            {live ? "Live" : "Offline"}
          </div>

          {runningCount > 0 ? (
            <span className="hidden items-center gap-1.5 rounded-full border border-sky-500/25 bg-sky-500/[0.07] px-2.5 py-1 text-[10px] font-medium text-sky-300 sm:flex">
              <Sparkles className="h-2.5 w-2.5" />
              {runningCount} running
            </span>
          ) : null}

          <div className="relative">
            <button
              type="button"
              onClick={() => setNotificationsOpen((prev) => !prev)}
              className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] text-neutral-400 transition-colors hover:border-white/15 hover:text-neutral-200"
              aria-label="Notifications"
            >
              <Bell className="h-3.5 w-3.5" />
              {awaitingCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400 px-1 font-mono text-[8.5px] font-bold text-amber-950">
                  {awaitingCount}
                </span>
              ) : null}
            </button>

            {notificationsOpen ? (
              <div className="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-xl border border-white/10 bg-[#0d0f13] shadow-2xl">
                <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
                  <span className="text-[11.5px] font-medium text-neutral-200">Activity</span>
                  <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">
                    {activity.length} recent
                  </span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {activity.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[11px] text-neutral-500">
                      No activity yet. Events appear here when agents run.
                    </div>
                  ) : (
                    activity.slice(0, 12).map((item) => (
                      <div key={item.id} className="flex items-start gap-2.5 border-b border-white/[0.04] px-3 py-2 last:border-0">
                        <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", activityDot(item.tone))} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11.5px] text-neutral-300">{item.title}</div>
                          <div className="truncate text-[9.5px] text-neutral-600">
                            {item.detail ?? "workspace"} · {relativeTime(item.timestamp)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setNotificationsOpen(false);
                    navigate("/home");
                  }}
                  className="flex w-full items-center justify-center gap-1 border-t border-white/[0.07] px-3 py-2 text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.03] hover:text-neutral-200"
                >
                  View on Home
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 text-[11px] text-neutral-400 transition-colors hover:border-white/15 hover:text-neutral-200 disabled:opacity-60"
            title={lastUpdated ? `Refreshed ${relativeTime(lastUpdated)}` : "Refresh workspace data"}
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            <span className="hidden lg:inline">{refreshing ? "Syncing" : "Refresh"}</span>
          </button>

          <div className="hidden items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[10px] font-medium text-neutral-400 xl:flex">
            <ShieldCheck className="h-3 w-3 text-emerald-400/80" />
            Paper mode
          </div>

          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] py-1 pl-1 pr-2 text-left transition-colors hover:border-white/15"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.07] text-[10px] font-semibold text-neutral-300">
              {agents.length > 9 ? "9+" : agents.length || <Users className="h-3 w-3" />}
            </span>
            <span className="hidden text-[10.5px] text-neutral-500 lg:block">
              {agents.length} coworker{agents.length === 1 ? "" : "s"}
            </span>
            <Check className="hidden h-3 w-3 text-emerald-400 lg:block" />
          </button>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

export function CoworkerAvatar({ id, name, size = "md" }: { id: string; name: string; size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold ring-1",
        avatarTone(id),
        size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-[11px]",
      )}
    >
      {agentInitials(name)}
    </span>
  );
}
