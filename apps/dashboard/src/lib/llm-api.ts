import { fetchJson } from "./fetch";

export interface LlmModelInfo {
  botId: string;
  name: string;
  provider: string;
  model: string;
  configured: boolean;
  reason: string;
  command?: string;
}

export async function fetchLlmModels(): Promise<LlmModelInfo[]> {
  const data = await fetchJson<{ models: LlmModelInfo[] }>("/api/llm/models");
  return data.models;
}

export async function setBotModel(
  botId: string,
  model: string
): Promise<{ bot: unknown }> {
  const data = await fetchJson<{ ok: boolean; bot: unknown }>(
    `/api/bots/${encodeURIComponent(botId)}/model`,
    {
      method: "POST",
      body: JSON.stringify({ model }),
    }
  );
  return { bot: data.bot };
}

export interface DetectedEngine {
  name: string;
  command: string;
  found: boolean;
  path?: string;
  suggestedArgs?: string[];
}

export async function fetchEngines(): Promise<DetectedEngine[]> {
  const data = await fetchJson<{ engines: DetectedEngine[] }>(
    "/api/llm/engines"
  );
  return data.engines;
}

export async function setBotEngine(
  botId: string,
  input: {
    provider: "cli" | "openai-compat" | "none";
    command?: string;
    model?: string;
    args?: string[];
    baseUrl?: string;
    apiKeyEnv?: string;
  }
): Promise<{ bot: unknown }> {
  const data = await fetchJson<{ ok: boolean; bot: unknown }>(
    `/api/bots/${encodeURIComponent(botId)}/engine`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return { bot: data.bot };
}

export interface EngineStatus {
  id: string;
  name: string;
  group: "cloud" | "local";
  kind: string;
  command: string;
  install?: string;
  suggestedArgs?: string[];
  found: boolean;
  path?: string;
  overridden: boolean;
  effectiveCommand: string;
  version?: string;
}

export async function fetchEngineStatuses(): Promise<EngineStatus[]> {
  const data = await fetchJson<{ engines: EngineStatus[] }>(
    "/api/llm/engines"
  );
  return data.engines;
}

export async function setEngineCli(
  id: string,
  command: string
): Promise<{ engine: EngineStatus }> {
  const data = await fetchJson<{ ok: boolean; engine: EngineStatus }>(
    `/api/llm/engines/${encodeURIComponent(id)}/cli`,
    {
      method: "POST",
      body: JSON.stringify({ command }),
    }
  );
  return { engine: data.engine };
}

export async function resetEngineCli(
  id: string
): Promise<{ engine: EngineStatus }> {
  const data = await fetchJson<{ ok: boolean; engine: EngineStatus }>(
    `/api/llm/engines/${encodeURIComponent(id)}/cli`,
    { method: "DELETE" }
  );
  return { engine: data.engine };
}

export interface UsageRow {
  botId: string;
  name: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  costUsd: number | null;
}

export interface UsageTotals {
  turns: number;
  tokens: number;
  costUsd: number | null;
}

export async function fetchUsage(): Promise<{
  usage: UsageRow[];
  totals: UsageTotals;
}> {
  const data = await fetchJson<{ usage: UsageRow[]; totals: UsageTotals }>(
    "/api/llm/usage"
  );
  return { usage: data.usage, totals: data.totals };
}

export async function setBotEngineById(
  botId: string,
  engineId: string,
  model?: string
): Promise<{ bot: unknown }> {
  const data = await fetchJson<{ ok: boolean; bot: unknown }>(
    `/api/bots/${encodeURIComponent(botId)}/engine`,
    {
      method: "POST",
      body: JSON.stringify({
        engine: engineId,
        ...(model !== undefined && model.trim() ? { model: model.trim() } : {}),
      }),
    }
  );
  return { bot: data.bot };
}
