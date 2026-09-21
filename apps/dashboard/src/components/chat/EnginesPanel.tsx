"use client";

import { useEffect, useMemo, useState } from "react";
import type { Bot } from "@/lib/chat-api";
import type {
  EngineStatus,
  LlmModelInfo,
  UsageRow,
  UsageTotals,
} from "@/lib/llm-api";
import { fetchUsage } from "@/lib/llm-api";
import { useClipboard } from "@/lib/clipboard";

interface SettingsEnginesProps {
  bots: Bot[];
  models: LlmModelInfo[];
  engines: EngineStatus[];
  busy: boolean;
  onSaveEngine: (id: string, command: string) => void | Promise<void>;
  onResetEngine: (id: string) => void | Promise<void>;
  onAssignBot: (
    botId: string,
    engineId: string | "none",
    model?: string
  ) => void | Promise<void>;
  onCheckAccount?: (id: string) => Promise<string>;
}

const NAV_ITEMS = [
  "General",
  "Appearance",
  "Connections",
  "Remote access",
  "Local VM",
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.floor(n)}`;
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "—";
  if (costUsd === 0) return "$0";
  return `$${costUsd.toFixed(2)}`;
}

function UsagePanel({ bots }: { bots: Bot[] }) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUsage()
      .then(({ usage, totals }) => {
        if (cancelled) return;
        setRows(usage);
        setTotals(totals);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const avatarFor = (botId: string): string =>
    bots.find((b) => b.id === botId)?.avatar ?? "🤖";

  return (
    <section className="card p-4 flex-1 min-w-0 space-y-4">
      <div className="flex items-start justify-between">
        <h2 className="text-sm font-bold tracking-tight">Usage</h2>
      </div>

      <div className="rounded-2xl bg-black/30 border border-white/10 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-bold">Usage</h3>
          <p className="text-[11px] opacity-60">
            Tokens and cost per bot, added up from every settled turn. Only
            engines that report a price show one.
          </p>
        </div>

        {error ? (
          <p className="text-xs text-red-400">Usage unavailable: {error}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs opacity-40">
            No settled turns yet — chat with a bot to record usage.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_64px_64px_64px] items-center gap-2 text-[11px] font-semibold opacity-80 pb-2">
              <span>BOT</span>
              <span className="text-right">TURNS</span>
              <span className="text-right">TOKENS</span>
              <span className="text-right">COST</span>
            </div>
            {rows.map((row) => (
              <div
                key={row.botId}
                className="grid grid-cols-[1fr_64px_64px_64px] items-center gap-2 py-2 border-t border-white/5 text-xs"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-base leading-none">{avatarFor(row.botId)}</span>
                  <span className="truncate font-medium">{row.name}</span>
                </span>
                <span className="text-right tabular-nums">{row.turns}</span>
                <span className="text-right tabular-nums">
                  {formatTokens(row.tokens)}
                </span>
                <span className="text-right tabular-nums">
                  {formatCost(row.costUsd)}
                </span>
              </div>
            ))}
            {totals !== null && (
              <div className="grid grid-cols-[1fr_64px_64px_64px] items-center gap-2 py-2 border-t border-white/10 text-xs font-bold">
                <span>All bots</span>
                <span className="text-right tabular-nums">{totals.turns}</span>
                <span className="text-right tabular-nums">
                  {formatTokens(totals.tokens)}
                </span>
                <span className="text-right tabular-nums">
                  {formatCost(totals.costUsd)}
                </span>
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] opacity-50">
          Cost is as reported by the engine.
        </p>
      </div>
    </section>
  );
}

const inputCls =
  "w-full text-xs px-3 py-2 rounded-xl bg-black/30 border border-white/10 placeholder:text-white/30 focus:outline-none focus:border-violet-500/50";

function isClaudeEngine(e: EngineStatus): boolean {
  return /claude/i.test(`${e.id} ${e.name} ${e.command}`);
}

function EngineRow({
  engine,
  busy,
  onSaveEngine,
  onResetEngine,
  onCheckAccount,
}: {
  engine: EngineStatus;
  busy: boolean;
  onSaveEngine: SettingsEnginesProps["onSaveEngine"];
  onResetEngine: SettingsEnginesProps["onResetEngine"];
  onCheckAccount?: SettingsEnginesProps["onCheckAccount"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { copied, copy: handleCopy } = useClipboard(1500);
  const [checking, setChecking] = useState(false);
  const [checkLine, setCheckLine] = useState<string | null>(null);

  function openEditor() {
    setDraft(engine.effectiveCommand);
    setEditing(true);
  }

  async function handleCheck() {
    if (!onCheckAccount) return;
    setChecking(true);
    setCheckLine(null);
    try {
      const line = await onCheckAccount(engine.id);
      setCheckLine(line);
    } catch (e) {
      setCheckLine(
        e instanceof Error && e.message ? e.message : "Account check failed"
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          aria-hidden
          title={engine.found ? "found" : "missing"}
          className={`inline-block h-2 w-2 rounded-full shrink-0 ${
            engine.found ? "bg-green-400" : "bg-white/25"
          }`}
        />
        <span className="text-sm font-semibold">{engine.name}</span>
        <span className="font-mono text-[11px] opacity-50 truncate">
          {engine.overridden
            ? engine.effectiveCommand
            : `${engine.effectiveCommand} · default`}
        </span>
        {engine.version && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-600/20 border border-violet-500/30 text-violet-200">
            {engine.version}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {engine.overridden && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onResetEngine(engine.id)}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
            >
              Reset
            </button>
          )}
          {isClaudeEngine(engine) && onCheckAccount && (
            <button
              type="button"
              disabled={busy || checking}
              onClick={() => void handleCheck()}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
            >
              {checking ? "Checking…" : "Check"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => (editing ? setEditing(false) : openEditor())}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
          >
            Set CLI…
          </button>
        </span>
      </div>

      {checkLine && (
        <p className="mt-2 font-mono text-[11px] opacity-70 break-all">
          {checkLine}
        </p>
      )}

      {editing && (
        <div className="mt-2 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. /usr/local/bin/codex"
            className={inputCls}
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => {
              void onSaveEngine(engine.id, draft.trim());
              setEditing(false);
            }}
            className="shrink-0 text-xs px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="shrink-0 text-xs px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10"
          >
            Cancel
          </button>
        </div>
      )}

      {engine.kind === "cli" && !engine.found && (
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="font-mono text-[11px] text-amber-200">
            `{engine.command}` CLI not found
          </p>
          {engine.install && (
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 font-mono text-[11px] opacity-80 break-all">
                {engine.install}
              </code>
              <button
                type="button"
                onClick={() => void handleCopy(engine.install as string)}
                className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
              >
                {copied ? "copied" : "Copy"}
              </button>
            </div>
          )}
          <p className="mt-1.5 text-[11px] opacity-60">
            Requires Node.js and npm — run it in your terminal, then refresh.
          </p>
        </div>
      )}
    </div>
  );
}

function BotAssignRow({
  bot,
  entry,
  engines,
  busy,
  onAssignBot,
}: {
  bot: Bot;
  entry?: LlmModelInfo;
  engines: EngineStatus[];
  busy: boolean;
  onAssignBot: SettingsEnginesProps["onAssignBot"];
}) {
  const [engineChoice, setEngineChoice] = useState<string>("none");
  const [model, setModel] = useState("");

  // Seed the controls from current model info when it first arrives.
  useEffect(() => {
    if (!entry) return;
    const match = engines.find(
      (e) =>
        e.id === entry.command ||
        e.command === entry.command ||
        e.name === entry.command ||
        e.effectiveCommand === entry.command
    );
    if (entry.provider !== "none" && match) {
      setEngineChoice(match.id);
    }
    if (entry.model && entry.model !== "deterministic") {
      setModel(entry.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.botId]);

  return (
    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none" aria-hidden>
          {bot.avatar ?? "🤖"}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{bot.name}</div>
          <div
            className="text-[11px] opacity-50 truncate"
            title={entry?.reason ?? "no model info"}
          >
            {entry
              ? entry.provider === "none"
                ? `deterministic • ${entry.reason}`
                : `${entry.provider} • ${entry.model}${
                    entry.command ? ` • ${entry.command}` : ""
                  }`
              : "no model info"}
          </div>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={engineChoice}
          onChange={(e) => setEngineChoice(e.target.value)}
          className={`${inputCls} sm:max-w-[220px]`}
        >
          <option value="none">Deterministic</option>
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.found ? "found" : "missing"})
            </option>
          ))}
        </select>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model (optional)"
          className={inputCls}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onAssignBot(
              bot.id,
              engineChoice,
              model.trim() ? model.trim() : undefined
            )
          }
          className="shrink-0 text-xs px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export function SettingsEngines({
  bots,
  models,
  engines,
  busy,
  onSaveEngine,
  onResetEngine,
  onAssignBot,
  onCheckAccount,
}: SettingsEnginesProps) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"engines" | "usage">("engines");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return engines;
    return engines.filter((e) => e.name.toLowerCase().includes(q));
  }, [engines, query]);

  const cloud = useMemo(
    () => filtered.filter((e) => e.group === "cloud"),
    [filtered]
  );
  const local = useMemo(
    () => filtered.filter((e) => e.group !== "cloud"),
    [filtered]
  );

  const rowProps = { busy, onSaveEngine, onResetEngine, onCheckAccount };

  return (
    <div className="flex flex-col md:flex-row gap-4">
      {/* Left mini sidebar */}
      <aside className="card p-4 md:w-56 shrink-0 space-y-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search engines…"
          className={inputCls}
        />
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <div
              key={item}
              aria-disabled
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-xl opacity-40 cursor-not-allowed"
            >
              <span>{item}</span>
              <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-white/10">
                soon
              </span>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setView("engines")}
            className={
              view === "engines"
                ? "w-full flex items-center gap-2 text-xs px-3 py-2 rounded-xl bg-violet-600/20 border border-violet-500/30 font-semibold"
                : "w-full flex items-center gap-2 text-xs px-3 py-2 rounded-xl opacity-60 hover:opacity-100 hover:bg-white/5"
            }
          >
            <span>Engines</span>
          </button>
          <button
            type="button"
            onClick={() => setView("usage")}
            className={
              view === "usage"
                ? "w-full flex items-center gap-2 text-xs px-3 py-2 rounded-xl bg-violet-600/20 border border-violet-500/30 font-semibold"
                : "w-full flex items-center gap-2 text-xs px-3 py-2 rounded-xl opacity-60 hover:opacity-100 hover:bg-white/5"
            }
          >
            <span>Usage</span>
          </button>
        </nav>
      </aside>

      {/* Right panel */}
      {view === "usage" ? (
        <UsagePanel bots={bots} />
      ) : (
      <section className="card p-4 flex-1 min-w-0 space-y-4">
        <div>
          <h2 className="text-sm font-bold tracking-tight">
            Engines and accounts
          </h2>
          <p className="text-xs opacity-50">Manage engine binaries</p>
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider opacity-60">
            Cloud
          </h3>
          {cloud.length === 0 ? (
            <p className="text-xs opacity-40">No cloud engines.</p>
          ) : (
            cloud.map((e) => (
              <EngineRow key={e.id} engine={e} {...rowProps} />
            ))
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider opacity-60">
            Local
          </h3>
          {local.length === 0 ? (
            <p className="text-xs opacity-40">No local engines.</p>
          ) : (
            local.map((e) => (
              <EngineRow key={e.id} engine={e} {...rowProps} />
            ))
          )}
        </div>

        <p className="text-[11px] opacity-50">
          Set CLI points an engine at a specific binary — a versioned build,
          wrapper script, or absolute path.
        </p>

        <div className="space-y-2 pt-2 border-t border-white/10">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider opacity-60">
            Bots
          </h3>
          {bots.length === 0 ? (
            <p className="text-xs opacity-40">No bots found.</p>
          ) : (
            bots.map((bot) => (
              <BotAssignRow
                key={bot.id}
                bot={bot}
                entry={models.find((m) => m.botId === bot.id)}
                engines={engines}
                busy={busy}
                onAssignBot={onAssignBot}
              />
            ))
          )}
        </div>
      </section>
      )}
    </div>
  );
}
