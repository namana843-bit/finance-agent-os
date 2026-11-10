import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { navigate } from "../shell/nav";
import {
  bulkSetAgentModel,
  bulkSetAgentProvider,
  createAgent,
  fetchAgentAssignments,
  fetchAgents,
  fetchDefaultModel,
  fetchDefaultProvider,
  fetchFreeModels,
  setAgentModel,
  setAgentProvider,
  setDefaultModel,
  setDefaultProvider,
  type AgentAssignment,
} from "../../lib/api";
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
import { useWorkspace } from "../shell/workspace-data";

function statusPill(status: string) {
  switch (status) {
    case "ok":
      return { label: "Connected", pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" };
    case "unreachable":
      return { label: "Not installed", pill: "border-rose-500/30 bg-rose-500/10 text-rose-300", dot: "bg-rose-400" };
    case "error":
      return { label: "Error", pill: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-400" };
    default:
      return { label: "Unknown", pill: "border-white/10 bg-white/5 text-neutral-400", dot: "bg-neutral-500" };
  }
}

export default function CliManagementPage() {
  const { agents, agentsState, agentsError, refresh } = useWorkspace();
  const [assignments, setAssignments] = useState<AgentAssignment[]>([]);
  const [defaultProvider, setDefaultProviderState] = useState<string | null>(null);
  const [freeModels, setFreeModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModelState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkType, setBulkType] = useState<"provider" | "model">("provider");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkAgentIds, setBulkAgentIds] = useState<string[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [assignmentsResult, defaultResult, modelsResult] = await Promise.all([
        fetchAgentAssignments(),
        fetchDefaultProvider(),
        fetchFreeModels(),
      ]);
      setAssignments(assignmentsResult.assignments);
      setDefaultProviderState(defaultResult.providerId ?? null);
      setFreeModels(modelsResult.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of assignments) {
      const pid = a.providerId ?? "default";
      counts[pid] = (counts[pid] || 0) + 1;
    }
    return counts;
  }, [assignments]);

  // Discovered provider inventory
  const providers = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; name: string; count: number; status: string }> = [];
    for (const a of assignments) {
      const pid = a.providerId ?? "default";
      if (seen.has(pid)) continue;
      seen.add(pid);
      list.push({
        id: pid,
        name: pid === "default" ? "Default (inherited)" : pid,
        count: providerCounts[pid] ?? 0,
        status: "ok",
      });
    }
    return list;
  }, [assignments, providerCounts]);

  // Explicit provider ids across agents
  const assignedProviderIds = useMemo(
    () => [...new Set(assignments.flatMap((a) => (a.providerId ? [a.providerId] : [])))],
    [assignments],
  );

  const handleToggleSelect = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedAgentIds.size === assignments.length) {
      setSelectedAgentIds(new Set());
    } else {
      setSelectedAgentIds(new Set(assignments.map((a) => a.agentId)));
    }
  };

  const handleBulkAssign = async () => {
    setSaving(true);
    try {
      const targetIds = bulkAgentIds.length > 0 ? bulkAgentIds : undefined;
      if (bulkType === "provider") {
        await bulkSetAgentProvider({ providerId: bulkValue.trim(), agentIds: targetIds });
      } else {
        await bulkSetAgentModel({ model: bulkValue.trim(), agentIds: targetIds });
      }
      setShowBulk(false);
      setBulkValue("");
      setBulkAgentIds([]);
      setSelectedAgentIds(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async () => {
    setSaving(true);
    try {
      await setDefaultProvider(defaultProvider);
      await setDefaultModel(defaultModel);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAssignAgent = async (agentId: string, providerId: string | null, model: string | null) => {
    setSaving(true);
    try {
      await setAgentProvider(agentId, providerId);
      await setAgentModel(agentId, model);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAssignAll = async (providerId: string) => {
    setSaving(true);
    try {
      await bulkSetAgentProvider({ providerId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingBlock rows={4} label="Loading CLI management" />;
  if (error) return <ErrorBanner title="CLI management unavailable" message={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        eyebrow="CLI Management"
        title="CLI Providers & Agent Assignments"
        description="Connect any CLI provider (Codex, Claude Code, Gemini, OpenCode) to one agent, selected agents, or all agents. Assign free OpenCode models to coworkers."
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <TextButton
              onClick={() => setShowBulk(true)}
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5"
            >
              <Zap className="h-3 w-3" /> Bulk assign
            </TextButton>
            <TextButton onClick={() => void refresh()} className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5">
              <RefreshCw className="h-3 w-3" /> Refresh
            </TextButton>
          </div>
        }
      />

      {/* Free models from OpenCode */}
      <Panel className="p-4 mb-5">
        <SectionHeading
          title="Free OpenCode Models"
          description="Discover genuinely available free models from your local OpenCode CLI installation. No API key required."
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <MonoLabel>Available models</MonoLabel>
          {freeModels.length === 0 ? (
            <span className="text-[11px] text-neutral-500">No free models discovered. Install OpenCode CLI and run \`opencode providers\` to authenticate.</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {freeModels.map((m) => (
                <span
                  key={m}
                  className="rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[10.5px] text-neutral-200 font-mono"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
          {freeModels.length > 0 && (
            <div className="mt-3 flex items-center gap-3">
              <MonoLabel>Global default free model</MonoLabel>
              <select
                value={defaultModel ?? ""}
                onChange={(e) => setDefaultModelState(e.target.value || null)}
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
              >
                <option value="">None</option>
                {freeModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={saving}
                onClick={() => setDefaultModel(defaultModel)}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11.5px] font-medium text-neutral-200 transition-colors disabled:opacity-50 hover:border-white/20"
              >
                {saving ? "Saving…" : "Set default model"}
              </button>
            </div>
          )}
        </div>
      </Panel>

      {/* Global default provider */}
      <Panel className="p-4 mb-5">
        <SectionHeading
          title="Global default CLI provider"
          description="Agents without an explicit provider override inherit this default. Three-level override: global default → agent → task."
        />
        <div className="mt-4 flex items-center gap-3">
          <MonoLabel>Default provider</MonoLabel>
          <select
            value={defaultProvider ?? ""}
            onChange={(e) => setDefaultProviderState(e.target.value || null)}
            className="rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
          >
            <option value="">None (agents choose their own)</option>
            {assignedProviderIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={saving}
            onClick={handleSetDefault}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11.5px] font-medium text-neutral-200 transition-colors disabled:opacity-50 hover:border-white/20"
          >
            {saving ? "Saving…" : "Set default"}
          </button>
        </div>
      </Panel>

      {/* Provider inventory */}
      <Panel className="p-4 mb-5">
        <SectionHeading
          title="Provider inventory"
          description="Discovered CLI providers and how many agents are assigned to each."
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.05]">
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Provider</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Agents</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-[11px] text-neutral-500">
                    No CLI providers configured. Connect one in Settings or add a coworker to auto-discover.
                  </td>
                </tr>
              ) : (
                providers.map((p) => (
                  <tr key={p.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-3 font-mono text-[10.5px] text-neutral-200">{p.name}</td>
                    <td className="py-3 font-mono text-[10.5px] text-neutral-400">
                      {p.count} agent{p.count !== 1 ? "s" : ""}
                    </td>
                    <td className="py-3">
                      {p.count > 0 ? (
                        <button
                          type="button"
                          onClick={() => handleAssignAll(p.id)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-neutral-300 transition-colors hover:border-white/20"
                        >
                          Assign all to <span className="text-emerald-400">{p.id}</span>
                        </button>
                      ) : (
                        <span className="text-[10px] text-neutral-600">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Agent assignments */}
      <Panel className="p-4">
        <SectionHeading
          title="Agent assignments"
          description="Each agent's current CLI provider and free model. Override per agent or use bulk actions below."
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSelectAll}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-white/5"
          >
            {selectedAgentIds.size === assignments.length ? "Deselect all" : "Select all"}
          </button>
          <span className="w-px bg-white/[0.05] h-4 mx-2" />
          <span className="font-mono text-[10px] text-neutral-500">{selectedAgentIds.size} selected</span>
        </div>
        {showBulk && (
          <Panel className="mt-4 p-4 border-white/[0.05] bg-white/[0.02]">
            <SectionHeading title={`Bulk assign to ${selectedAgentIds.size || "all"} agents`} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <MonoLabel>Assign type</MonoLabel>
                <select
                  value={bulkType}
                  onChange={(e) => setBulkType(e.target.value as "provider" | "model")}
                  className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
                >
                  <option value="provider">Provider</option>
                  <option value="model">Free model</option>
                </select>
              </div>
              <div>
                <MonoLabel>{bulkType === "provider" ? "Provider ID" : "Free model ID"}</MonoLabel>
                <input
                  required
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                  placeholder={bulkType === "provider" ? "e.g. cli-opencode" : "e.g. opencode/nemotron-3.5-super-vl-free"}
                  className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] pl-3 pr-3 text-[11.5px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
                />
              </div>
              <div className="lg:col-span-2 flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowBulk(false)}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11.5px] font-medium text-neutral-200 transition-colors disabled:opacity-50 hover:border-white/20"
                >
                  Cancel
                </button>
                <PrimaryButton disabled={saving || !bulkValue.trim()} onClick={() => handleBulkAssign()}>
                  {saving ? "Assigning…" : `Assign to ${selectedAgentIds.size || "all"} agents`}
                </PrimaryButton>
              </div>
            </div>
          </Panel>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.05]">
                <th className="pb-2 pl-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">
                  <input
                    type="checkbox"
                    checked={selectedAgentIds.size === assignments.length && assignments.length > 0}
                    onChange={handleSelectAll}
                    className="h-4 w-4 rounded border-white/10 bg-white/[0.02] text-emerald-500 focus:ring-emerald-500"
                  />
                </th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Agent</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Engine</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Provider</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Model</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Status</th>
                <th className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600">Override</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => {
                const isSelected = selectedAgentIds.has(a.agentId);
                const style = statusPill(a.status);
                return (
                  <tr key={a.agentId} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-3 pl-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleSelect(a.agentId)}
                        className="h-4 w-4 rounded border-white/10 bg-white/[0.02] text-emerald-500 focus:ring-emerald-500"
                      />
                    </td>
                    <td className="py-3 font-mono text-[10.5px] text-neutral-200 truncate max-w-[200px]">
                      {a.agentName}
                    </td>
                    <td className="py-3 font-mono text-[10.5px] text-neutral-400">{a.engine}</td>
                    <td className="py-3 font-mono text-[10.5px]">
                      {a.providerId ? (
                        <span className="text-emerald-400">{a.providerId}</span>
                      ) : (
                        <span className="text-neutral-500">default</span>
                      )}
                    </td>
                    <td className="py-3 font-mono text-[10.5px] text-neutral-400 truncate max-w-[200px]">
                      {a.model ?? "default"}
                    </td>
                    <td className="py-3">
                      <StatusPill label={style.label} className={style.pill} dotClassName={style.dot} />
                    </td>
                    <td className="py-3">
                      <div className="flex gap-1">
                        <select
                          value={a.providerId ?? ""}
                          onChange={(e) => handleAssignAgent(a.agentId, e.target.value || null, a.model)}
                          disabled={saving}
                          className="rounded-lg border border-white/[0.07] bg-white/[0.02] pl-2 pr-2 text-[10px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40"
                        >
                          <option value="">Default</option>
                          {assignedProviderIds.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                        <select
                          value={a.model ?? ""}
                          onChange={(e) => handleAssignAgent(a.agentId, a.providerId, e.target.value || null)}
                          disabled={saving}
                          className="rounded-lg border border-white/[0.07] bg-white/[0.02] pl-2 pr-2 text-[10px] text-neutral-200 outline-none transition-colors focus:border-emerald-500/40 ml-1"
                        >
                          <option value="">Default</option>
                          {freeModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[10.5px] text-neutral-600">
          Built-in safety-critical agents cannot be reassigned. Changes persist across server restarts.
        </p>
      </Panel>
    </div>
  );
}
