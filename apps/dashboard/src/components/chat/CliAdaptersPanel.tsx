// ============================================================================
// Agent CLI adapters — backend-discovered through /api/cli/adapters.
// No CLI names are hard-coded here; the list renders adapter metadata only.
// ============================================================================

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchCliAdapters,
  startCliSession,
  stopCliSession,
  validateCliAdapter,
  type CliAdapterInfo,
} from "@/lib/cli-api";

function statusText(adapter: CliAdapterInfo): string {
  const installation = adapter.installation;
  if (!installation) return "unknown";
  if (!installation.ok) return "not installed";
  if (installation.version) return `v${installation.version}`;
  return "installed";
}

export function CliAdaptersPanel() {
  const [adapters, setAdapters] = useState<CliAdapterInfo[]>([]);
  const [sessions, setSessions] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setAdapters(await fetchCliAdapters());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load CLI adapters");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleValidate = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const validation = await validateCliAdapter(id);
      setAdapters((prev) =>
        prev.map((a) => (a.id === id ? { ...a, installation: validation } : a)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const handleStartSession = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const { session } = await startCliSession(id);
      setSessions((prev) => ({ ...prev, [session.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start session");
    } finally {
      setBusy(null);
    }
  }, []);

  /** Session ids tracked locally for one adapter (server ids: cli-<adapter>-<uuid>). */
  const sessionsFor = useCallback(
    (id: string) =>
      Object.keys(sessions).filter((sessionId) => sessionId.startsWith(`cli-${id}-`)),
    [sessions],
  );

  const runningFor = (id: string) => sessionsFor(id).length;

  const handleStopSessions = useCallback(
    async (id: string) => {
      const ids = sessionsFor(id);
      if (ids.length === 0) return;
      setBusy(id);
      try {
        await Promise.all(ids.map((sessionId) => stopCliSession(sessionId)));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to stop session");
      } finally {
        setSessions((prev) => {
          const next = { ...prev };
          for (const sessionId of ids) delete next[sessionId];
          return next;
        });
        setBusy(null);
      }
    },
    [sessionsFor],
  );

  return (
    <section className="card p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Agent CLIs</h2>
          <p className="text-[11px] opacity-60">
            Registered CLI adapters (backend-discovered via /api/cli/adapters). Add a new CLI by
            implementing an adapter — no runtime or UI changes required.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-300 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2">
          {error}
        </p>
      )}

      {adapters.length === 0 ? (
        <p className="text-xs opacity-40">No CLI adapters registered.</p>
      ) : (
        <div className="space-y-2">
          {adapters.map((adapter) => (
            <div
              key={adapter.id}
              className="rounded-2xl bg-black/30 border border-white/10 p-3 flex items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate">{adapter.name}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 font-mono">
                    {adapter.executable}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${
                      adapter.installation?.ok
                        ? "border-green-500/30 bg-green-500/10 text-green-300"
                        : "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
                    }`}
                  >
                    {statusText(adapter)}
                  </span>
                </div>
                <p className="text-[11px] opacity-60 truncate">{adapter.description}</p>
                <p className="text-[10px] opacity-40 font-mono">
                  {adapter.installation?.resolvedPath ?? adapter.installHint ?? ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={busy === adapter.id}
                  onClick={() => void handleValidate(adapter.id)}
                  className="text-xs px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
                >
                  {busy === adapter.id ? "…" : "Validate"}
                </button>
                <button
                  type="button"
                  disabled={busy === adapter.id}
                  onClick={() => void handleStartSession(adapter.id)}
                  className="text-xs px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
                >
                  Start session
                </button>
                <button
                  type="button"
                  disabled={busy === adapter.id || runningFor(adapter.id) === 0}
                  onClick={() => void handleStopSessions(adapter.id)}
                  className="text-xs px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
                >
                  Stop{runningFor(adapter.id) > 0 ? ` (${runningFor(adapter.id)})` : ""}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

