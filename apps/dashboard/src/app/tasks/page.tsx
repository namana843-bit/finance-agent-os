import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Briefcase, ChevronDown, ChevronRight, ShieldAlert, Workflow } from "lucide-react";
import { cn } from "../../lib/utils";
import { fmtCurrency } from "../../lib/api";
import { currentHashQuery, navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  SectionHeading,
  StatusPill,
  TextButton,
} from "../shell/ui";
import { relativeTime, runStatusTone, useWorkspace, type WorkflowRun } from "../shell/workspace-data";

type Filter = "all" | "active" | "awaiting_approval" | "completed" | "failed";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function matches(run: WorkflowRun, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return run.status === "running";
    case "awaiting_approval":
      return run.status === "awaiting_approval";
    case "completed":
      return run.status === "completed";
    case "failed":
      return run.status === "failed" || run.status === "user_rejected";
    default:
      return true;
  }
}

function RunDetail({ run, coworker }: { run: WorkflowRun; coworker?: string }) {
  const agents = run.agents ?? [];
  return (
    <div className="border-t border-white/[0.06] bg-black/20 px-4 py-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <MonoLabel>Agent steps</MonoLabel>
          <div className="mt-1.5 space-y-1">
            {agents.length === 0 ? (
              <div className="text-[11px] text-neutral-500">No agent steps were recorded for this run.</div>
            ) : (
              agents.map((step, index) => (
                <div
                  key={`${step.agentId}-${index}`}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2.5 py-1.5",
                    coworker && step.agentId === coworker
                      ? "border-emerald-500/25 bg-emerald-500/[0.05]"
                      : "border-white/[0.05] bg-white/[0.02]",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      step.ok ? "bg-emerald-400" : "bg-rose-400",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-neutral-200">{step.agentId}</span>
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-neutral-600">
                        {step.stage}
                      </span>
                    </div>
                    {step.error ? (
                      <p className="mt-0.5 text-[10px] text-rose-300/80">{step.error}</p>
                    ) : step.output ? (
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-neutral-500">{step.output}</p>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <MonoLabel>Risk review</MonoLabel>
            {run.riskReview ? (
              <div className="mt-1.5 rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-3 w-3 text-amber-400" />
                  <span className="text-[11px] font-medium text-neutral-200">{run.riskReview.verdict}</span>
                  <span className="ml-auto font-mono text-[9px] text-neutral-600">{run.riskReview.agentId}</span>
                </div>
                {run.riskReview.concerns?.length ? (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[10.5px] text-neutral-500">
                    {run.riskReview.concerns.map((concern, index) => (
                      <li key={index}>{concern}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <div className="mt-1.5 text-[10.5px] text-neutral-600">No risk review attached to this run.</div>
            )}
          </div>

          <div>
            <MonoLabel>Execution</MonoLabel>
            {run.execution ? (
              <div className="mt-1.5 rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-2 text-[10.5px] text-neutral-400">
                <div className="flex items-center justify-between">
                  <span>{run.execution.success ? "Paper order filled" : "Execution blocked"}</span>
                  <span className="font-mono text-[9px] text-neutral-600">{run.execution.stage}</span>
                </div>
                <p className="mt-1 text-neutral-500">{run.execution.reason}</p>
                {run.execution.filledPrice ? (
                  <p className="mt-1 font-mono text-[10px] text-emerald-300/90">
                    {run.execution.filledQuantity} @ {fmtCurrency(run.execution.filledPrice)}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="mt-1.5 text-[10.5px] text-neutral-600">No execution result yet.</div>
            )}
          </div>

          {run.proposal ? (
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] px-2.5 py-2">
              <MonoLabel>Proposal rationale</MonoLabel>
              <p className="mt-1 text-[10.5px] leading-relaxed text-neutral-400">{run.proposal.rationale}</p>
              {run.proposal.assumptions ? (
                <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">Assumptions: {run.proposal.assumptions}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.05] pt-2.5">
        <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">
          {run.auditIds?.length ?? 0} audit records
        </span>
        <span className="text-[10px] text-neutral-600">Run {run.id}</span>
        <button
          type="button"
          onClick={() => navigate("/team")}
          className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-emerald-400 transition-colors hover:text-emerald-300"
        >
          Approve or reject in Agent Team
          <ArrowUpRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export default function TasksPage() {
  const { runs, runsState, runsError, agents, refresh } = useWorkspace();
  const query = currentHashQuery();
  const initialRun = query.get("run");
  const coworker = query.get("coworker") ?? undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(initialRun);

  useEffect(() => {
    setExpanded(initialRun);
  }, [initialRun]);

  const rows = useMemo(() => {
    const filtered = runs.filter((run) => matches(run, filter));
    const scoped = coworker
      ? filtered.filter((run) => run.agents?.some((step) => step.agentId === coworker))
      : filtered;
    return [...scoped].sort(
      (a, b) => (Date.parse(b.updatedAt ?? b.createdAt ?? "") || 0) - (Date.parse(a.updatedAt ?? a.createdAt ?? "") || 0),
    );
  }, [runs, filter, coworker]);

  const countFor = (key: Filter) =>
    runs.filter((run) => matches(run, key) && (!coworker || run.agents?.some((step) => step.agentId === coworker))).length;

  return (
    <div>
      <PageHeader
        eyebrow="Work queue"
        title="Tasks"
        description="Durable workflow runs: who acted, what risk said, and whether a human approved execution."
        actions={
          <TextButton onClick={() => void refresh()}>
            <Workflow className="h-3.5 w-3.5" />
            Refresh queue
          </TextButton>
        }
      />

      {coworker ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] text-neutral-400">
          <span className="text-neutral-600">Filtered by coworker</span>
          <span className="font-mono text-[10.5px] text-emerald-300">{agents.find((a) => a.id === coworker)?.name ?? coworker}</span>
          <button
            type="button"
            onClick={() => navigate("/tasks")}
            className="ml-auto rounded border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-white/5"
          >
            Clear
          </button>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] transition-colors",
              filter === item.key
                ? "border-emerald-500/30 bg-emerald-500/10 font-medium text-emerald-300"
                : "border-white/[0.07] bg-white/[0.02] text-neutral-400 hover:border-white/15 hover:text-neutral-200",
            )}
          >
            {item.label}
            <span className="ml-1.5 font-mono text-[9px] text-neutral-600">{countFor(item.key)}</span>
          </button>
        ))}
      </div>

      {runsState === "error" ? (
        <ErrorBanner title="Task queue unavailable" message={runsError} onRetry={() => void refresh()} />
      ) : runsState === "loading" ? (
        <LoadingBlock rows={4} label="Loading tasks" />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<Briefcase className="h-4 w-4" />}
          title="No tasks yet"
          description="Workflow runs appear here when the orchestrator researches a symbol, drafts a proposal, and asks for approval. Nothing is queued right now."
          action={
            <button
              type="button"
              onClick={() => navigate("/team")}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 hover:bg-emerald-400"
            >
              Start a workflow in Agent Team
            </button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Workflow className="h-4 w-4" />}
          title="No tasks match this view"
          description="Try another status filter, or clear the coworker filter."
          action={<TextButton onClick={() => setFilter("all")}>Show all</TextButton>}
        />
      ) : (
        <Panel className="overflow-hidden">
          <div className="hidden items-center gap-3 border-b border-white/[0.06] px-4 py-2 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-600 md:flex">
            <span className="w-4" />
            <span className="w-40">Task</span>
            <span className="flex-1">Stage</span>
            <span className="w-32">Coworkers</span>
            <span className="w-32">Updated</span>
            <span className="w-36 text-right">Status</span>
          </div>

          {rows.map((run) => {
            const tone = runStatusTone(run.status);
            const isOpen = expanded === run.id;
            return (
              <div key={run.id} className="border-b border-white/[0.05] last:border-0">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : run.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] md:flex-nowrap md:px-4"
                >
                  <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 text-neutral-600 transition-transform", isOpen && "rotate-180")}
                  />
                  <span className="min-w-0 flex-1 md:w-40 md:flex-none">
                    <span className="block truncate text-[12px] font-medium text-neutral-100">
                      {run.proposal
                        ? `${run.proposal.side.toUpperCase()} ${run.proposal.quantity} ${run.proposal.symbol}`
                        : `Run ${run.id.slice(0, 8)}`}
                    </span>
                    <span className="block truncate font-mono text-[9.5px] text-neutral-600">
                      {run.proposal ? run.proposal.type : run.id}
                    </span>
                  </span>
                  <span className="hidden min-w-0 flex-1 truncate text-[11px] text-neutral-400 md:block">{run.stage}</span>
                  <span className="hidden w-32 shrink-0 truncate text-[10.5px] text-neutral-500 md:block">
                    {(run.agents ?? []).length} agent{(run.agents ?? []).length === 1 ? "" : "s"}
                  </span>
                  <span className="hidden w-32 shrink-0 text-[10.5px] text-neutral-600 md:block">
                    {relativeTime(Date.parse(run.updatedAt ?? run.createdAt ?? ""))}
                  </span>
                  <span className="ml-auto shrink-0 md:ml-0 md:w-36 md:text-right">
                    <StatusPill label={tone.label} className={tone.className} dotClassName={tone.dot} />
                  </span>
                </button>
                {isOpen ? <RunDetail run={run} coworker={coworker} /> : null}
              </div>
            );
          })}
        </Panel>
      )}

      <div className="mt-5">
        <SectionHeading
          title="Execution stays gated"
          description="Tasks can draft proposals, but a paper order still needs deterministic risk approval and your confirmation."
        />
        <Panel className="flex flex-wrap items-center gap-3 px-4 py-3">
          <ShieldAlert className="h-4 w-4 text-amber-400/80" />
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-neutral-500">
            This screen is read-only. Approvals happen in Agent Team, where the risk ticket and confirmation are checked.
          </p>
          <button
            type="button"
            onClick={() => navigate("/team")}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 transition-colors hover:bg-white/5"
          >
            Open Agent Team
            <ChevronRight className="h-3 w-3" />
          </button>
        </Panel>
      </div>
    </div>
  );
}
