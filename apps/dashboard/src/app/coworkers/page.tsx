import { useMemo, useState } from "react";
import { ArrowRight, MessageSquare, Search, Users, Plus, X, Zap, Terminal, Copy } from "lucide-react";
import { cn } from "../../lib/utils";
import { navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  PrimaryButton,
  SectionHeading,
  StatusPill,
  TextButton,
} from "../shell/ui";
import { avatarTone, agentInitials, useWorkspace } from "../shell/workspace-data";
import { createAgent, fetchAgents, setAgentProvider, bulkSetAgentProvider, type AgentApiConfig } from "../../lib/api";

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

type NewCoworker = {
  name: string;
  role: string;
  description: string;
  engine: string;
  model: string;
  systemPrompt: string;
  tools: string;
  execution: boolean;
  allowTradeProposals: boolean;
  avatar: string;
  personality: string;
  memoryScope: string;
  maxConcurrent: string;
};

export default function CoworkersPage() {
  const { agents, agentsState, agentsError, runs, runsState, refresh } = useWorkspace();
  const [query, setQuery] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [providerSaving, setProviderSaving] = useState<Set<string>>(new Set());
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [newProviderId, setNewProviderId] = useState("");

  const [form, setForm] = useState<NewCoworker>({
    name: "",
    role: "Finance coworker",
    description: "",
    engine: "cline-cli",
    model: "",
    systemPrompt: "",
    tools: "",
    execution: false,
    allowTradeProposals: false,
    avatar: "AI",
    personality: "steady",
    memoryScope: "",
    maxConcurrent: "1",
  });

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

  const assignmentsProviderOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const a of agents) {
      if (a.providerId) seen.add(a.providerId);
    }
    return Array.from(seen).sort();
  }, [agents]);

  const slugify = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-+$)/g, "") || "coworker";

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      const id = form.name.trim() ? `bot-${slugify(form.name)}-${Date.now().toString(36).slice(4)}` : "";
      const tools = form.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const body: AgentApiConfig & {
        avatar?: string;
        personality?: string;
        memoryScope?: string;
        concurrency?: { maxConcurrent?: number };
      } = {
        id,
        name: form.name.trim(),
        role: form.role.trim() || undefined,
        description: form.description.trim() || undefined,
        engine: form.engine.trim(),
        model: form.model.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        tools: tools.length ? tools : undefined,
        permissions: { execution: form.execution },
        riskPermissions: { allowTradeProposals: form.allowTradeProposals },
        avatar: form.avatar.trim() || undefined,
        personality: form.personality.trim() || undefined,
        memoryScope: form.memoryScope.trim() || undefined,
        concurrency: { maxConcurrent: form.maxConcurrent ? Number(form.maxConcurrent) : 1 },
      };
      await createAgent(body);
      setShowAddForm(false);
      setForm({
        name: "",
        role: "Finance coworker",
        description: "",
        engine: "cline-cli",
        model: "",
        systemPrompt: "",
        tools: "",
        execution: false,
        allowTradeProposals: false,
        avatar: "AI",
        personality: "steady",
        memoryScope: "",
        maxConcurrent: "1",
      });
      await refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleAssignProvider = async (agentId: string, providerId: string | null) => {
    setProviderSaving((prev) => new Set([...prev, agentId]));
    try {
      await setAgentProvider(agentId, providerId);
      setEditingProvider(null);
      setNewProviderId("");
      await refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderSaving((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  };

  const handleBulkAssign = async (providerId: string) => {
    setProviderSaving((prev) => new Set([...prev, ...agents.map((a) => a.id)]));
    try {
      await bulkSetAgentProvider({ providerId });
      setEditingProvider(null);
      setNewProviderId("");
      await refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderSaving((prev) => {
        const next = new Set(prev);
        for (const a of agents) next.delete(a.id);
        return next;
      });
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Coworker directory"
        title="Coworkers"
        description="Every agent the runtime has configured, with its provider, model and the task it currently owns."
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
            >
              <Plus className="h-3 w-3" /> Add coworker
            </button>
            <TextButton
              onClick={() => {
                setEditingProvider(null);
                setNewProviderId("");
              }}
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-400 hover:bg-white/5"
            >
              <Terminal className="h-3 w-3" /> CLI management
            </TextButton>
          </div>
        }
      />

      {showAddForm && (
        <Panel className="p-5 mb-5">
          <SectionHeading
            title="Add coworker"
            description="Create a new FinanceBot coworker. Built-in safety rules apply — execution and trade-proposal
            permissions are enforced on the backend."
            action={
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-400 hover:bg-white/5"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
            }
          />
          {addError && (
            <ErrorBanner title="Could not create coworker" message={addError} />
          )}
          <form onSubmit={handleAdd} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <MonoLabel>Name</MonoLabel>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Market Scanner"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Role</MonoLabel>
              <input
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                placeholder="e.g. Researcher"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div className="lg:col-span-2">
              <MonoLabel>Description</MonoLabel>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this coworker does"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Engine</MonoLabel>
              <input
                value={form.engine}
                onChange={(e) => setForm({ ...form, engine: e.target.value })}
                placeholder="cline-cli"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Model</MonoLabel>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="default model"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div className="lg:col-span-2">
              <MonoLabel>System prompt</MonoLabel>
              <textarea
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                rows={3}
                placeholder="Instructions for this coworker"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div className="lg:col-span-2">
              <MonoLabel>Tools (comma-separated)</MonoLabel>
              <input
                value={form.tools}
                onChange={(e) => setForm({ ...form, tools: e.target.value })}
                placeholder="get_market_price, get_ohlcv"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="execution"
                type="checkbox"
                checked={form.execution}
                onChange={(e) => setForm({ ...form, execution: e.target.checked })}
                className="h-4 w-4 rounded border-white/10 bg-white/[0.02] text-emerald-500 focus:ring-emerald-500"
              />
              <label htmlFor="execution" className="text-[11px] text-neutral-300">
                Execution permission
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="allowTradeProposals"
                type="checkbox"
                checked={form.allowTradeProposals}
                onChange={(e) => setForm({ ...form, allowTradeProposals: e.target.checked })}
                className="h-4 w-4 rounded border-white/10 bg-white/[0.02] text-emerald-500 focus:ring-emerald-500"
              />
              <label htmlFor="allowTradeProposals" className="text-[11px] text-neutral-300">
                Allow trade proposals
              </label>
            </div>
            <div>
              <MonoLabel>Avatar (1-2 chars)</MonoLabel>
              <input
                maxLength={2}
                value={form.avatar}
                onChange={(e) => setForm({ ...form, avatar: e.target.value })}
                placeholder="AI"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Personality</MonoLabel>
              <input
                value={form.personality}
                onChange={(e) => setForm({ ...form, personality: e.target.value })}
                placeholder="steady"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Memory scope</MonoLabel>
              <input
                value={form.memoryScope}
                onChange={(e) => setForm({ ...form, memoryScope: e.target.value })}
                placeholder="coworker:general"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div>
              <MonoLabel>Max concurrent runs</MonoLabel>
              <input
                type="number"
                min="1"
                value={form.maxConcurrent}
                onChange={(e) => setForm({ ...form, maxConcurrent: e.target.value })}
                placeholder="1"
                className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              />
            </div>
            <div className="lg:col-span-2 flex items-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                disabled={adding}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11.5px] font-medium text-neutral-200 transition-colors disabled:opacity-50 hover:border-white/20"
              >
                Cancel
              </button>
              <PrimaryButton disabled={adding || !form.name.trim()}>
                {adding ? "Creating…" : "Create coworker"}
              </PrimaryButton>
            </div>
          </form>
        </Panel>
      )}

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
          description="Use Add coworker above to create one, or seed the built-in finance teammates, and it will appear here with its provider and model."
          action={
            <div className="flex gap-2">
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
                    {editingProvider === agent.id ? (
                      <select
                        value={newProviderId}
                        onChange={(e) => setNewProviderId(e.target.value)}
                        disabled={providerSaving.has(agent.id)}
                        className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-2 pr-2 text-[10px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
                      >
                        <option value="">Default</option>
                        {assignmentsProviderOptions.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-neutral-300" title={agent.providerId ?? agent.engine}>
                        {agent.providerId ?? agent.engine ?? "—"}
                        {agent.providerId && (
                          <span className="ml-1 text-emerald-400">●</span>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        editingProvider === agent.id ? setEditingProvider(null) : setEditingProvider(agent.id)
                      }
                      className="rounded-md border border-white/10 px-2 py-1 text-[9px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200 transition-colors"
                    >
                      {editingProvider === agent.id ? <X className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    </button>
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
                  {editingProvider === agent.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleAssignProvider(agent.id, newProviderId || null)}
                        disabled={providerSaving.has(agent.id)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {providerSaving.has(agent.id) ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingProvider(null)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-white/5"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
