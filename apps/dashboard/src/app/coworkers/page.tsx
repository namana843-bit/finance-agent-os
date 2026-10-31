import { useMemo, useState } from "react";
import { MessageSquare, Search, Users, Zap } from "lucide-react";
import { cn } from "../../lib/utils";
import { navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  StatusPill,
  TextButton,
} from "../shell/ui";
import { avatarTone, agentInitials, useWorkspace } from "../shell/workspace-data";

type CoworkerStatus = "working" | "waiting" | "ready" | "unknown";

function statusStyle(status: CoworkerStatus) {
  switch (status) {
    case "working":
      return { label: "Working", pill: "border-sky-500/30 bg-sky-500/10 text-sky-300", dot: "bg-sky-400 animate-pulse" };
    case "waiting":
      return { label: "Waiting approval", pill: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-400" };
    case "ready":
      return { label: "Ready", pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" };
    default:
      return { label: "Unknown", pill: "border-white/10 bg-white/5 text-neutral-400", dot: "bg-neutral-500" };
  }
}

export default function CoworkersPage() {
  const { agents, agentsState, agentsError, runs, runsState, refresh } = useWorkspace();
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents
      .map((agent) => {
        const activeRun = runs.find(
          (run) => run.status === "running" && run.agents?.some((step) => step.agentId === agent.id),
        );
        const waitingRun = runs.find(
          (run) => run.status === "awaiting_approval" && run.agents?.some((step) => step.agentId === agent.id),
        );
        const status: CoworkerStatus =
          agentsState === "error" ? "unknown" : activeRun ? "working" : waitingRun ? "waiting" : "ready";
        const currentTask =
          activeRun?.proposal
            ? `${activeRun.proposal.side.toUpperCase()} ${activeRun.proposal.symbol} · ${activeRun.stage}`
            : activeRun
              ? `${activeRun.stage} · run ${activeRun.id.slice(0, 6)}`
              : waitingRun
                ? `Awaiting approval · run ${waitingRun.id.slice(0, 6)}`
                : null;
        return { agent, status, currentTask };
      })
      .filter(({ agent }) => {
        if (!needle) return true;
        return `${agent.name} ${agent.role ?? ""} ${agent.engine ?? ""} ${agent.model ?? ""} ${agent.description ?? ""}`
          .toLowerCase()
          .includes(needle);
      });
  }, [agents, runs, query, agentsState]);

  return (
    <div>
      <PageHeader
        eyebrow="Coworker directory"
        title="Coworkers"
        description="Every agent the runtime has configured, with its provider, model and the task it currently owns."
        actions={
          <TextButton onClick={() => navigate("/team")}>
            <Users className="h-3.5 w-3.5" />
            Manage team
          </TextButton>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, role, model..."
            className="h-8 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-8 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors placeholder:text-neutral-600 focus:border-emerald-500/40"
          />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          {agentsState === "loading" ? "Loading" : `${rows.length} of ${agents.length}`}
        </span>
      </div>

      {agentsState === "error" ? (
        <ErrorBanner
          title="Coworker directory unavailable"
          message={`${agentsError} Start the local API, then refresh.`}
          onRetry={() => void refresh()}
        />
      ) : agentsState === "loading" ? (
        <LoadingBlock rows={4} label="Loading coworkers" />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<Users className="h-4 w-4" />}
          title="No coworkers configured"
          description="The runtime has no agents yet. Create one in Agent Team, or seed the built-in finance teammates, and it will appear here with its provider and model."
          action={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => navigate("/team")}
                className="rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 hover:bg-emerald-400"
              >
                Open Agent Team
              </button>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="rounded-md border border-white/10 px-3 py-1.5 text-[11.5px] text-neutral-300 hover:bg-white/5"
              >
                Check providers
              </button>
            </div>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Search className="h-4 w-4" />}
          title="No coworker matches that search"
          description="Try a different name, role or model identifier."
          action={<TextButton onClick={() => setQuery("")}>Clear search</TextButton>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ agent, status, currentTask }) => {
            const style = statusStyle(status);
            return (
              <Panel key={agent.id} className="flex flex-col p-4 transition-colors hover:border-white/15">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[12px] font-semibold ring-1",
                      avatarTone(agent.id),
                    )}
                  >
                    {agentInitials(agent.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-neutral-100">{agent.name}</div>
                    <div className="truncate text-[11px] text-neutral-500">{agent.role ?? "Finance coworker"}</div>
                  </div>
                  <StatusPill label={style.label} className={style.pill} dotClassName={style.dot} />
                </div>

                <p className="mt-3 line-clamp-2 min-h-[32px] text-[11px] leading-relaxed text-neutral-500">
                  {agent.description ?? "No description configured for this coworker."}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5">
                    <MonoLabel>Provider</MonoLabel>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] text-neutral-300">{agent.engine ?? "—"}</div>
                  </div>
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5">
                    <MonoLabel>Model</MonoLabel>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] text-neutral-300" title={agent.model}>
                      {agent.model || "default"}
                    </div>
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5">
                  <MonoLabel>Current task</MonoLabel>
                  <div className="mt-0.5 truncate text-[10.5px] text-neutral-400">
                    {runsState === "loading" ? "Loading tasks…" : currentTask ?? "Idle — no assigned run"}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 border-t border-white/[0.05] pt-3">
                  <button
                    type="button"
                    onClick={() => navigate("/workspace", { coworker: agent.id })}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
                  >
                    <MessageSquare className="h-3 w-3" />
                    Open chat
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/tasks", { coworker: agent.id })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 transition-colors hover:bg-white/5"
                  >
                    <Zap className="h-3 w-3" />
                    Tasks
                  </button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-[10.5px] text-neutral-600">
        Model and provider values come from the agent runtime API. A coworker without a model override uses the workspace
        default.
      </p>
    </div>
  );
}
