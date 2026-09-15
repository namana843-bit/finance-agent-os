import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReportedUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface RecordTurnInput {
  model?: string;
  provider?: string;
  command?: string;
  promptChars: number;
  completionChars: number;
  usage?: ReportedUsage;
  /** Engine-reported cost wins when present. */
  costUsd?: number;
}

export interface UsageRow {
  botId: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  /** Null when no engine reported a price and no known pricing applies. */
  costUsd: number | null;
}

export interface UsageTotals {
  turns: number;
  tokens: number;
  costUsd: number | null;
}

export interface UsageSnapshot {
  rows: UsageRow[];
  totals: UsageTotals;
}

/** Rough token estimate for engines that don't report usage (~4 chars/token). */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function cleanCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// USD per 1M tokens: [input, output]. Approximate public list prices.
const PRICE_TABLE: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /haiku/i, input: 0.8, output: 4 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /opus/i, input: 15, output: 75 },
  { match: /flash/i, input: 0.3, output: 2.5 },
  { match: /gemini/i, input: 0.3, output: 2.5 },
];

// CLI engines bill through the user's subscription, not per token. Known
// free/local CLIs report no charge ($0); anything else reports no price (—).
const FREE_CLI = /gemini|ollama|llama|qwen|local|free/i;

type Price = { input: number; output: number } | { zero: true } | null;

export function priceForModel(
  model?: string,
  provider?: string,
  command?: string,
): Price {
  const hay = `${model ?? ""} ${command ?? ""}`;
  if (provider === "cli" && FREE_CLI.test(hay)) return { zero: true };
  if (!model || model.trim().length === 0) return null;
  for (const entry of PRICE_TABLE) {
    if (entry.match.test(model)) return { input: entry.input, output: entry.output };
  }
  return null;
}

interface StoredBotUsage {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  hasCost: boolean;
}

function defaultDataDir(): string {
  // src/llm -> src -> server root, then .data (mirrors core/storage.ts)
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const serverRoot = join(currentDir, "..", "..");
    return join(serverRoot, ".data");
  } catch {
    return join(process.cwd(), ".data");
  }
}

function toRow(botId: string, stored: StoredBotUsage): UsageRow {
  return {
    botId,
    turns: stored.turns,
    promptTokens: stored.promptTokens,
    completionTokens: stored.completionTokens,
    tokens: stored.promptTokens + stored.completionTokens,
    costUsd: stored.hasCost ? stored.costUsd : null,
  };
}

export class UsageTracker {
  private readonly dataDir?: string;
  private readonly byBot = new Map<string, StoredBotUsage>();
  readonly ready: Promise<void>;

  constructor(dataDir?: string) {
    this.dataDir = dataDir;
    this.ready = this.load();
  }

  private file(): string {
    return join(this.dataDir ?? defaultDataDir(), "usage.json");
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.file(), "utf-8");
      const data: unknown = JSON.parse(raw);
      if (typeof data !== "object" || data === null) return;
      for (const [botId, value] of Object.entries(
        data as Record<string, unknown>,
      )) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Record<string, unknown>;
        const turns = v["turns"];
        const promptTokens = v["promptTokens"];
        const completionTokens = v["completionTokens"];
        const costUsd = v["costUsd"];
        const hasCost = v["hasCost"];
        if (
          typeof turns !== "number" ||
          typeof promptTokens !== "number" ||
          typeof completionTokens !== "number"
        ) {
          continue;
        }
        this.byBot.set(botId, {
          turns: Math.max(0, Math.floor(turns)),
          promptTokens: Math.max(0, Math.floor(promptTokens)),
          completionTokens: Math.max(0, Math.floor(completionTokens)),
          costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : 0,
          hasCost: hasCost === true,
        });
      }
    } catch {
      // Missing or corrupt file: start empty. Never throws.
    }
  }

  private async save(): Promise<void> {
    try {
      const file = this.file();
      await mkdir(dirname(file), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.byBot), null, 2);
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, payload, "utf-8");
      try {
        await rename(tmp, file);
      } catch {
        await writeFile(file, payload, "utf-8");
      }
    } catch {
      // Persistence is best-effort. Never throws.
    }
  }

  /** Record one settled turn. Only call after a completion succeeded. */
  async record(botId: string, input: RecordTurnInput): Promise<UsageRow> {
    await this.ready;
    const promptTokens =
      cleanCount(input.usage?.promptTokens) ?? estimateTokens(input.promptChars);
    const completionTokens =
      cleanCount(input.usage?.completionTokens) ??
      estimateTokens(input.completionChars);
    let cost: number | null =
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0
        ? input.costUsd
        : null;
    if (cost === null) {
      const price = priceForModel(input.model, input.provider, input.command);
      if (price !== null) {
        cost =
          "zero" in price
            ? 0
            : (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
      }
    }
    const prev = this.byBot.get(botId);
    const next: StoredBotUsage = {
      turns: (prev?.turns ?? 0) + 1,
      promptTokens: (prev?.promptTokens ?? 0) + promptTokens,
      completionTokens: (prev?.completionTokens ?? 0) + completionTokens,
      costUsd: (prev?.costUsd ?? 0) + (cost ?? 0),
      hasCost: (prev?.hasCost ?? false) || cost !== null,
    };
    this.byBot.set(botId, next);
    void this.save();
    return toRow(botId, next);
  }

  snapshot(): UsageSnapshot {
    const rows = [...this.byBot.entries()]
      .filter(([, v]) => v.turns > 0)
      .map(([botId, v]) => toRow(botId, v))
      .sort((a, b) => b.tokens - a.tokens);
    let costSum = 0;
    let anyCost = false;
    for (const row of rows) {
      if (row.costUsd !== null) {
        costSum += row.costUsd;
        anyCost = true;
      }
    }
    return {
      rows,
      totals: {
        turns: rows.reduce((sum, r) => sum + r.turns, 0),
        tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
        costUsd: anyCost ? costSum : null,
      },
    };
  }
}
