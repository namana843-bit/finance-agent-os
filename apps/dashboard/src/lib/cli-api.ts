// ============================================================================
// Finance Agent OS — Generic CLI adapter discovery for the desktop UI.
// Consumes only /api/cli/* (backend-metadata); no CLI names are hard-coded.
// ============================================================================

import { fetchJson } from "./fetch";

export interface CliAdapterInfo {
  id: string;
  name: string;
  description: string;
  executable: string;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  taskDelivery: string;
  defaultArgs: string[];
  engineAliases: string[];
  installHint?: string;
  installation: {
    adapterId: string;
    ok: boolean;
    executable: string;
    resolvedPath: string | null;
    version: string | null;
    error?: string;
    checkedAt: number;
  } | null;
}

export interface CliSessionInfo {
  id: string;
  adapterId: string;
  status: string;
  command: string;
  cwd?: string;
  createdAt: number;
  lastActivityAt: number;
  tasks: number;
  runningTask: boolean;
}

export async function fetchCliAdapters(): Promise<CliAdapterInfo[]> {
  const data = await fetchJson<{ adapters: CliAdapterInfo[] }>("/api/cli/adapters");
  return data.adapters;
}

export async function validateCliAdapter(id: string): Promise<CliAdapterInfo["installation"]> {
  const data = await fetchJson<{ validation: CliAdapterInfo["installation"] }>(
    `/api/cli/adapters/${encodeURIComponent(id)}/validate`,
    { method: "POST" }
  );
  return data.validation;
}

export async function fetchCliSessions(): Promise<CliSessionInfo[]> {
  const data = await fetchJson<{ sessions: CliSessionInfo[] }>("/api/cli/sessions");
  return data.sessions;
}

export async function startCliSession(
  adapterId: string,
): Promise<{ session: CliSessionInfo }> {
  const data = await fetchJson<{ session: CliSessionInfo }>("/api/cli/sessions", {
    method: "POST",
    body: JSON.stringify({ adapterId }),
  });
  return { session: data.session };
}

export async function stopCliSession(id: string): Promise<{ ok: boolean }> {
  const data = await fetchJson<{ ok: boolean }>(
    `/api/cli/sessions/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  return { ok: data.ok };
}
