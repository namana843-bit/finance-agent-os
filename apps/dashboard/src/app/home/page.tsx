import { useMemo } from "react";
import {
  ArrowUpRight,
  Briefcase,
  CircleDollarSign,
  Clock3,
  FileSearch,
  Radio,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { fmtCurrency, fmtPercent } from "../../lib/api";
import { navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  GhostLink,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  SectionHeading,
  StatCard,
  StatusPill,
} from "../shell/ui";
import { relativeTime, runStatusTone, useWorkspace } from "../shell/workspace-data";
import { cn } from "../../lib/utils";

function activityToneClass(tone: "neutral" | "good" | "warn" | "bad") {
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

export default function HomePage() {
  const {
    agents,
    agentsState,
    agentsError,
    runs,
    runsState,
    runsError,
    portfolio,
    portfolioState,
    portfolioError,
    research,
    researchState,
    researchError,
    activity,
    serverState,
    refresh,
  } = useWorkspace();

  const activeCoworkers = useMemo(() => {
    const active = new Set<string>();
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "awaiting_approval") continue;
      for (const step of run.agents ?? []) {
        if (step.agentId) active.add(step.agentId);
      }
    }
    return active;
  }, [runs]);

  const running = runs.filter((run) => run.status === "running");
  const queued = runs.filter((run) => run.status === "awaiting_approval");

  const dataUnavailable = serverState === "error";

  return (
    <div>
      <PageHeader
        eyebrow="Workspace overview"
        title="Home"
        description="Your financial research desk: coworker status, queued work and portfolio context in one place."
        actions={
          <div className="flex items-center gap-2">
            <StatusPill
              label={serverState === "ready" ? "Local API connected" : serverState === "loading" ? "Connecting" : "Local API offline"}
              className={
                serverState === "ready"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : serverState === "error"
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                    : "border-white/10 bg-white/5 text-neutral-400"
              }
              dotClassName={serverState === "ready" ? "bg-emerald-400" : serverState === "error" ? "bg-rose-400" : "bg-neutral-500"}
            />
            <button
              type="button"
              onClick={() => navigate("/workspace")}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
            >
              New conversation
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />

      {dataUnavailable ? (
        <div className="mb-5">
          <ErrorBanner
            title="Workspace data unavailable"
            message="The local Finance Agent API is not responding on :4132. Start the server, then refresh."
            onRetry={() => void refresh()}
          />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total coworkers"
          value={agents.length}
          hint={agentsState === "error" ? "Agent directory unavailable" : "Configured agents in the runtime"}
          icon={<Users className="h-3.5 w-3.5" />}
          loading={agentsState === "loading"}
          unavailable={agentsState === "error"}
        />
        <StatCard
          label="Active coworkers"
          value={activeCoworkers.size}
          hint={activeCoworkers.size ? "Assigned to live workflow runs" : "No coworker is executing right now"}
          icon={<Radio className="h-3.5 w-3.5" />}
          tone={activeCoworkers.size ? "good" : "default"}
          loading={agentsState === "loading" || runsState === "loading"}
          unavailable={runsState === "error"}
        />
        <StatCard
          label="Running tasks"
          value={running.length}
          hint={running.length ? `Latest: ${running[0].stage}` : "Queue is idle"}
          icon={<Briefcase className="h-3.5 w-3.5" />}
          loading={runsState === "loading"}
          unavailable={runsState === "error"}
        />
        <StatCard
          label="Queued tasks"
          value={queued.length}
          hint={queued.length ? "Awaiting human approval before execution" : "Nothing waiting on you"}
          icon={<Clock3 className="h-3.5 w-3.5" />}
          tone={queued.length ? "warn" : "default"}
          loading={runsState === "loading"}
          unavailable={runsState === "error"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel className="p-4">
            <SectionHeading
              title="Recent agent activity"
              description="Live events from the local event bus and recent workflow runs."
              meta={activity.length ? `${activity.length} items` : undefined}
              action={<GhostLink onClick={() => navigate("/tasks")}>All tasks</GhostLink>}
            />
            {runsState === "loading" && activity.length === 0 ? (
              <LoadingBlock rows={3} label="Loading activity" />
            ) : activity.length === 0 ? (
              <EmptyState
                compact
                icon={<Radio className="h-4 w-4" />}
                title="No activity yet"
                description="Runs, fills and channel events appear here as soon as a coworker starts working."
              />
            ) : (
              <ol className="space-y-0">
                {activity.slice(0, 7).map((item, index) => (
                  <li key={item.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn("mt-1.5 h-1.5 w-1.5 rounded-full", activityToneClass(item.tone))} />
                      {index < Math.min(activity.length, 7) - 1 ? <span className="mt-1 w-px flex-1 bg-white/[0.06]" /> : null}
                    </div>
                    <div className="min-w-0 flex-1 pb-3">
                      <div className="truncate text-[12px] text-neutral-200">{item.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-600">
                        <span className="truncate">{item.detail ?? "workspace"}</span>
                        <span>·</span>
                        <span className="shrink-0">{relativeTime(item.timestamp)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionHeading
              title="Recent research"
              description="Research memories saved by the supervisor. Evidence only — no invented data."
              action={<GhostLink onClick={() => navigate("/channels")}>Open channels</GhostLink>}
            />
            {researchState === "loading" ? (
              <LoadingBlock rows={2} label="Loading research" />
            ) : researchError ? (
              <ErrorBanner title="Research memory unavailable" message={researchError} onRetry={() => void refresh()} />
            ) : research.length === 0 ? (
              <EmptyState
                compact
                icon={<FileSearch className="h-4 w-4" />}
                title="No research briefs yet"
                description="When a coworker saves a research memory, the most recent notes show up here with their timestamp."
              />
            ) : (
              <div className="space-y-2">
                {research.slice(0, 4).map((entry) => (
                  <div key={entry.id} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10.5px] text-emerald-300/90">{entry.key}</span>
                      <span className="shrink-0 text-[9.5px] text-neutral-600">{relativeTime(entry.timestamp)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-neutral-500">
                      {typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="p-4">
            <SectionHeading
              title="Portfolio summary"
              description="Paper portfolio snapshot from the local risk and portfolio services."
              action={<GhostLink onClick={() => navigate("/terminal")}>Terminal</GhostLink>}
            />
            {portfolioState === "loading" ? (
              <LoadingBlock rows={2} label="Loading portfolio" />
            ) : portfolioState === "error" || !portfolio ? (
              <div>
                <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.015] px-3 py-4">
                  <div className="flex items-center gap-2 text-[12px] text-neutral-300">
                    <Wallet className="h-3.5 w-3.5 text-neutral-500" />
                    Portfolio unavailable
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-neutral-500">
                    {portfolioError || "The portfolio service did not return a snapshot."} No values are shown rather than
                    placeholder numbers.
                  </p>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/terminal")}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-400 hover:bg-white/5"
                  >
                    Open terminal
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <MonoLabel>Net asset value</MonoLabel>
                  <div className="mt-1 font-mono text-[22px] font-semibold tracking-tight text-neutral-100">
                    {fmtCurrency(portfolio.totalValue, portfolio.baseCurrency)}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "font-mono text-[11px]",
                        portfolio.pnl.percentDay >= 0 ? "text-emerald-400" : "text-rose-400",
                      )}
                    >
                      {fmtPercent(portfolio.pnl.percentDay)} today
                    </span>
                    <span className="text-[10px] text-neutral-600">
                      {portfolio.pnl.day >= 0 ? "+" : ""}
                      {fmtCurrency(portfolio.pnl.day, portfolio.baseCurrency)}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                    <MonoLabel>Cash</MonoLabel>
                    <div className="mt-0.5 font-mono text-[12px] text-neutral-200">
                      {fmtCurrency(portfolio.availableCash, portfolio.baseCurrency)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                    <MonoLabel>Exposure</MonoLabel>
                    <div className="mt-0.5 font-mono text-[12px] text-neutral-200">
                      {fmtCurrency(portfolio.risk.exposure, portfolio.baseCurrency)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                    <MonoLabel>Holdings</MonoLabel>
                    <div className="mt-0.5 font-mono text-[12px] text-neutral-200">{portfolio.holdings.length}</div>
                  </div>
                  <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                    <MonoLabel>Open positions</MonoLabel>
                    <div className="mt-0.5 font-mono text-[12px] text-neutral-200">{portfolio.positions.length}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                  <span className="flex items-center gap-1.5 text-[10.5px] text-neutral-400">
                    <ShieldCheck className="h-3 w-3 text-emerald-400/80" />
                    Risk status
                  </span>
                  <StatusPill
                    label={portfolio.risk.status === "ok" ? "Within limits" : portfolio.risk.status === "warn" ? "Warning" : "Breach"}
                    className={
                      portfolio.risk.status === "ok"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : portfolio.risk.status === "warn"
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                          : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                    }
                    dotClassName={
                      portfolio.risk.status === "ok" ? "bg-emerald-400" : portfolio.risk.status === "warn" ? "bg-amber-400" : "bg-rose-400"
                    }
                  />
                </div>
              </div>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionHeading
              title="Coworker snapshot"
              description="Runtime agents and the work currently assigned to them."
              action={<GhostLink onClick={() => navigate("/coworkers")}>Directory</GhostLink>}
            />
            {agentsState === "loading" ? (
              <LoadingBlock rows={2} label="Loading coworkers" />
            ) : agentsState === "error" ? (
              <ErrorBanner title="Coworkers unavailable" message={agentsError} onRetry={() => void refresh()} />
            ) : agents.length === 0 ? (
              <EmptyState
                compact
                icon={<Users className="h-4 w-4" />}
                title="No coworkers configured"
                description="Create an agent in the Agent Team screen to populate this workspace."
                action={
                  <button
                    type="button"
                    onClick={() => navigate("/team")}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5"
                  >
                    Open Agent Team
                  </button>
                }
              />
            ) : (
              <div className="space-y-1">
                {agents.slice(0, 5).map((agent) => {
                  const assigned = running.find((run) => run.agents?.some((step) => step.agentId === agent.id));
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => navigate("/workspace", { coworker: agent.id })}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] text-[9px] font-semibold text-neutral-300">
                        {agent.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] text-neutral-200">{agent.name}</span>
                        <span className="block truncate text-[9.5px] text-neutral-600">{agent.role ?? agent.engine}</span>
                      </span>
                      {assigned ? (
                        <span className="shrink-0 font-mono text-[9px] text-sky-300">{assigned.stage}</span>
                      ) : (
                        <CircleDollarSign className="h-3 w-3 shrink-0 text-neutral-700" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          {runsState === "error" ? <ErrorBanner title="Workflows unavailable" message={runsError} onRetry={() => void refresh()} /> : null}
        </div>
      </div>

      <div className="mt-6">
        <Panel className="p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <Clock3 className="h-3.5 w-3.5 text-neutral-600" />
              Queue depth is derived from workflow runs. Trade execution stays behind the deterministic risk gate.
            </div>
            <div className="flex gap-2">
              {runs.slice(0, 3).map((run) => {
                const tone = runStatusTone(run.status);
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => navigate("/tasks", { run: run.id })}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
                      tone.className,
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
                    {run.proposal ? run.proposal.symbol : run.id.slice(0, 6)} · {tone.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
