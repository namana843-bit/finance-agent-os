import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Cpu, Database, KeyRound, Plug, Server, ShieldCheck, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { API_BASE, fetchEnginesApi, fetchOpencodeModelsApi, type EngineApiStatus, type OpencodeModelsResponse } from "../../lib/api";
import { navigate } from "../shell/nav";
import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  MonoLabel,
  PageHeader,
  Panel,
  SectionHeading,
  StatusPill,
} from "../shell/ui";
import { relativeTime, useWorkspace } from "../shell/workspace-data";

function healthStyle(status: string) {
  if (status === "ok" || status === "healthy" || status === "ready")
    return { pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", label: "Healthy" };
  if (status === "degraded" || status === "unknown")
    return { pill: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-400", label: status };
  return { pill: "border-rose-500/30 bg-rose-500/10 text-rose-300", dot: "bg-rose-400", label: status || "error" };
}

export default function SettingsPage() {
  const { health, serverState, providers, providersState, providersError, agents, portfolio, lastUpdated, refresh } =
    useWorkspace();
  const [engines, setEngines] = useState<EngineApiStatus[]>([]);
  const [enginesState, setEnginesState] = useState<"loading" | "ready" | "error">("loading");
  const [enginesError, setEnginesError] = useState("");
  const [models, setModels] = useState<OpencodeModelsResponse | null>(null);
  const [modelsState, setModelsState] = useState<"loading" | "ready" | "error">("loading");
  const [modelsError, setModelsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchEnginesApi();
        if (!cancelled) {
          setEngines(data.engines ?? []);
          setEnginesState("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setEngines([]);
          setEnginesState("error");
          setEnginesError(error instanceof Error ? error.message : String(error));
        }
      }
      try {
        const data = await fetchOpencodeModelsApi();
        if (!cancelled) {
          setModels(data);
          setModelsState("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setModels(null);
          setModelsState("error");
          setModelsError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const installedProviders = providers.filter((provider) => provider.adapter?.installed || provider.kind === "api");

  return (
    <div>
      <PageHeader
        eyebrow="Workspace configuration"
        title="Settings"
        description="Connections, providers and model defaults for this desktop workspace. Secrets are never rendered here."
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11.5px] text-neutral-300 transition-colors hover:bg-white/5"
          >
            Re-check connection
          </button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <SectionHeading
            title="Local connection"
            description="The desktop UI talks only to the local Fastify service."
            meta={lastUpdated ? relativeTime(lastUpdated) : undefined}
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                <Server className="h-3 w-3 text-neutral-600" />
                API base
              </span>
              <span className="font-mono text-[10.5px] text-neutral-300">{API_BASE}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                <Plug className="h-3 w-3 text-neutral-600" />
                Status
              </span>
              <StatusPill
                label={serverState === "ready" ? "Connected" : serverState === "loading" ? "Checking" : "Offline"}
                className={
                  serverState === "ready"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : serverState === "error"
                      ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                      : "border-white/10 bg-white/5 text-neutral-400"
                }
                dotClassName={serverState === "ready" ? "bg-emerald-400" : serverState === "error" ? "bg-rose-400" : "bg-neutral-500"}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                <Database className="h-3 w-3 text-neutral-600" />
                Runtime
              </span>
              <span className="font-mono text-[10.5px] text-neutral-300">
                {health ? `v${health.version} · ${Math.floor(health.uptime / 60)}m uptime` : "unknown"}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                <Cpu className="h-3 w-3 text-neutral-600" />
                Coworkers · holdings
              </span>
              <span className="font-mono text-[10.5px] text-neutral-300">
                {agents.length} · {portfolio ? portfolio.holdings.length : "n/a"}
              </span>
            </div>
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionHeading
            title="Provider connections"
            description="Names, kinds and health only. API keys stay in the server environment or OS credential store."
            meta={providersState === "ready" ? `${providers.length} providers` : undefined}
          />
          {providersState === "loading" ? (
            <LoadingBlock rows={3} label="Loading providers" />
          ) : providersState === "error" ? (
            <ErrorBanner title="Provider registry unavailable" message={providersError} onRetry={() => void refresh()} />
          ) : providers.length === 0 ? (
            <EmptyState
              compact
              icon={<Plug className="h-4 w-4" />}
              title="No providers registered"
              description="The server has no LLM providers configured. Add one through the server environment, then reload."
            />
          ) : (
            <div className="space-y-1.5">
              {providers.map((provider) => {
                const style = healthStyle(provider.health?.status ?? "unknown");
                return (
                  <div
                    key={provider.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] text-neutral-200">{provider.name}</span>
                      <span className="block truncate font-mono text-[9.5px] text-neutral-600">
                        {provider.id} · {provider.kind}
                        {provider.adapter ? ` · ${provider.adapter.installed ? "installed" : "not installed"}` : ""}
                      </span>
                    </span>
                    {provider.adapter ? (
                      provider.adapter.installed ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <X className="h-3 w-3 text-neutral-600" />
                      )
                    ) : null}
                    <StatusPill label={style.label} className={style.pill} dotClassName={style.dot} />
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
            <span className="flex items-center gap-2 text-[10.5px] text-neutral-500">
              <KeyRound className="h-3 w-3 text-neutral-600" />
              {installedProviders.length} usable connections · no secrets exposed
            </span>
            <button
              type="button"
              onClick={() => navigate("/engines")}
              className="inline-flex items-center gap-1 text-[10.5px] text-emerald-400 hover:text-emerald-300"
            >
              Open engine registry
              <ArrowUpRight className="h-2.5 w-2.5" />
            </button>
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionHeading
            title="CLI engines"
            description="Detected coding-agent engines and their resolved executables."
            meta={enginesState === "ready" ? `${engines.filter((engine) => engine.found).length}/${engines.length} found` : undefined}
          />
          {enginesState === "loading" ? (
            <LoadingBlock rows={3} label="Loading engines" />
          ) : enginesState === "error" ? (
            <ErrorBanner title="Engine registry unavailable" message={enginesError} onRetry={() => void refresh()} />
          ) : engines.length === 0 ? (
            <EmptyState
              compact
              icon={<Cpu className="h-4 w-4" />}
              title="No engines reported"
              description="The server did not return any engine entries."
            />
          ) : (
            <div className="space-y-1.5">
              {engines.map((engine) => (
                <div
                  key={engine.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-neutral-200">{engine.name}</span>
                    <span className="block truncate font-mono text-[9.5px] text-neutral-600">
                      {engine.effectiveCommand || engine.command}
                      {engine.version ? ` · ${engine.version}` : ""}
                    </span>
                  </span>
                  <StatusPill
                    label={engine.found ? "Detected" : "Unavailable"}
                    className={
                      engine.found
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-white/10 bg-white/5 text-neutral-400"
                    }
                    dotClassName={engine.found ? "bg-emerald-400" : "bg-neutral-500"}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="p-4">
          <SectionHeading
            title="Model defaults"
            description="Workspace default models used by coworkers without an explicit override."
          />
          {modelsState === "loading" ? (
            <LoadingBlock rows={2} label="Loading model defaults" />
          ) : modelsState === "error" ? (
            <ErrorBanner title="Model registry unavailable" message={modelsError} onRetry={() => void refresh()} />
          ) : !models?.projectConfig?.exists ? (
            <EmptyState
              compact
              icon={<Cpu className="h-4 w-4" />}
              title="No project model config"
              description="The workspace has no opencode.json model bindings, so each coworker keeps its own configured model."
            />
          ) : (
            <div className="space-y-2">
              <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <MonoLabel>Default primary model</MonoLabel>
                <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-200">{models.projectConfig.default_model ?? "—"}</div>
                <div className={cn("mt-0.5 text-[9.5px]", models.projectConfig.default_model_available ? "text-emerald-400" : "text-amber-400")}>
                  {models.projectConfig.default_model_available ? "Verified available" : "Unverified"}
                </div>
              </div>
              <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <MonoLabel>Default small model</MonoLabel>
                <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-200">{models.projectConfig.small_model ?? "—"}</div>
                <div className={cn("mt-0.5 text-[9.5px]", models.projectConfig.small_model_available ? "text-emerald-400" : "text-amber-400")}>
                  {models.projectConfig.small_model_available ? "Verified available" : "Unverified"}
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-neutral-600">
                <span>{models.total} models discovered</span>
                <button
                  type="button"
                  onClick={() => navigate("/engines")}
                  className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                >
                  Change defaults
                  <ArrowUpRight className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
          )}
        </Panel>

        <Panel className="p-4 lg:col-span-2">
          <SectionHeading
            title="Safety & permissions"
            description="These constraints are enforced by the server; this screen only reports them."
          />
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                Paper mode
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                Live execution stays disabled unless the existing environment gates and approval process are satisfied.
              </p>
            </div>
            <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-200">
                <AlertTriangle className="h-3 w-3 text-amber-400" />
                Risk gate
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                Every order needs a valid, unexpired HMAC risk ticket and passes the seven-stage execution pipeline.
              </p>
            </div>
            <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-200">
                <KeyRound className="h-3 w-3 text-neutral-500" />
                Secrets
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                Provider keys never reach the renderer. This screen shows names, paths and health only.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.05] pt-3">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-600">Original screens</span>
            {[
              { label: "Agent Team", route: "/team" },
              { label: "Model Engines", route: "/engines" },
              { label: "Coding Agents", route: "/coding" },
              { label: "Finance Terminal", route: "/terminal" },
            ].map((item) => (
              <button
                key={item.route}
                type="button"
                onClick={() => navigate(item.route)}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-200"
              >
                {item.label}
                <ArrowUpRight className="h-2.5 w-2.5" />
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
