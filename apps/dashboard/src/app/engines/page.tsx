"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SettingsEngines } from "@/components/chat/EnginesPanel";
import { fetchBots, type Bot } from "@/lib/chat-api";
import {
  fetchEngineStatuses,
  fetchLlmModels,
  resetEngineCli,
  setBotEngine,
  setBotEngineById,
  setEngineCli,
  type EngineStatus,
  type LlmModelInfo,
} from "@/lib/llm-api";

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function EnginesPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [b, m, e] = await Promise.all([
      fetchBots(),
      fetchLlmModels(),
      fetchEngineStatuses(),
    ]);
    setBots(b);
    setModels(m);
    setEngines(e);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setError(null);
      try {
        const [b, m, e] = await Promise.all([
          fetchBots(),
          fetchLlmModels(),
          fetchEngineStatuses(),
        ]);
        if (cancelled) return;
        setBots(b);
        setModels(m);
        setEngines(e);
      } catch (e) {
        if (!cancelled)
          setError(
            errText(
              e,
              "Failed to load engines. Is the backend running (GET /api/llm/engines)?"
            )
          );
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveEngine = useCallback(
    async (id: string, command: string) => {
      setBusy(true);
      setError(null);
      try {
        await setEngineCli(id, command);
        await refresh();
      } catch (e) {
        setError(errText(e, "Failed to set engine CLI"));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleResetEngine = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await resetEngineCli(id);
        await refresh();
      } catch (e) {
        setError(errText(e, "Failed to reset engine CLI"));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleAssignBot = useCallback(
    async (botId: string, engineId: string | "none", model?: string) => {
      setBusy(true);
      setError(null);
      try {
        if (engineId === "none") {
          await setBotEngine(botId, { provider: "none" });
        } else {
          await setBotEngineById(botId, engineId, model);
        }
        await refresh();
      } catch (e) {
        setError(errText(e, "Failed to assign bot engine"));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleCheckAccount = useCallback(async (id: string) => {
    const statuses = await fetchEngineStatuses();
    const found = statuses.find((e) => e.id === id);
    if (!found) throw new Error(`Engine ${id} not found`);
    return `${found.name} ${found.version ?? "version unknown"} @ ${
      found.path ?? found.effectiveCommand
    }`;
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Engines</h1>
          <p className="text-xs opacity-50">
            Detect local CLI engines and assign one per bot.
          </p>
        </div>
        <Link
          href="/chat"
          className="ml-auto text-xs px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10"
        >
          Back to chat
        </Link>
      </div>

      <SettingsEngines
        bots={bots}
        models={models}
        engines={engines}
        busy={busy}
        onSaveEngine={(id, command) => void handleSaveEngine(id, command)}
        onResetEngine={(id) => void handleResetEngine(id)}
        onAssignBot={(botId, engineId, model) =>
          void handleAssignBot(botId, engineId, model)
        }
        onCheckAccount={handleCheckAccount}
      />

      {error && (
        <p className="text-xs text-red-300 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
