// ============================================================================
// Finance Agent OS — Coding Agent Workspace API client.
// Consumes /api/coding/* only. No provider names are hard-coded here: the
// workspace renders whatever the backend discovers.
// ============================================================================

import { API_BASE, fetchJson } from "./fetch";

export type Capability = { supported: true } | { supported: false; reason: string };

export interface ProviderStatus {
  installed: boolean;
  version: string | null;
  auth: "unknown" | "authenticated" | "unauthenticated";
  resolvedPath: string | null;
  error?: string;
  checkedAt: number;
}

export interface CodingProvider {
  providerId: string;
  name: string;
  description: string;
  executable: string;
  adapterId: string;
  status: ProviderStatus;
  capabilities: Record<string, Capability>;
  installHint?: string;
  authHint?: string;
}

export interface CodingProject {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
  git?: { isRepo: boolean; branch?: string; dirty?: boolean };
}

export interface CodingTurnEvent {
  type: string;
  content?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  stream?: "stdout" | "stderr";
  chunk?: string;
  status?: string;
  reason?: string;
  message?: string;
  fatal?: boolean;
  exitCode?: number | null;
  durationMs?: number;
}

export interface CodingTurn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  events?: CodingTurnEvent[];
  cancelled?: boolean;
  durationMs?: number;
}

export interface CodingSession {
  id: string;
  providerId: string;
  cliSessionId: string | null;
  projectId: string;
  projectPath: string;
  model?: string;
  status: "idle" | "running" | "cancelled" | "failed" | "closed";
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: CodingTurn[];
  isolated?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  error?: string;
}

export interface CodingProjectDiffFile {
  path: string;
  status: string;
}

export interface CodingProjectDiff {
  isRepo: boolean;
  files: CodingProjectDiffFile[];
  stat: string;
  patch: string;
  truncated: boolean;
  error?: string;
}

export async function fetchProjectDiff(projectId: string): Promise<CodingProjectDiff> {
  const data = await fetchJson<{ diff: CodingProjectDiff }>(
    `/api/coding/projects/${encodeURIComponent(projectId)}/diff`,
  );
  return data.diff;
}

export async function fetchProviders(refresh = false): Promise<CodingProvider[]> {
  const data = await fetchJson<{ providers: CodingProvider[] }>(
    `/api/coding/providers${refresh ? "?refresh=1" : ""}`,
  );
  return data.providers;
}

export async function refreshProvider(providerId: string): Promise<CodingProvider> {
  const data = await fetchJson<{ provider: CodingProvider }>(
    `/api/coding/providers/${encodeURIComponent(providerId)}/refresh`,
    { method: "POST" },
  );
  return data.provider;
}

export async function fetchProjects(): Promise<CodingProject[]> {
  const data = await fetchJson<{ projects: CodingProject[] }>("/api/coding/projects");
  return data.projects;
}

export async function addProject(path: string): Promise<CodingProject> {
  const data = await fetchJson<{ project: CodingProject }>("/api/coding/projects", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return data.project;
}

export async function removeProject(id: string): Promise<void> {
  await fetchJson(`/api/coding/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchSessions(filter: { providerId?: string; projectId?: string } = {}): Promise<CodingSession[]> {
  const query = new URLSearchParams();
  if (filter.providerId) query.set("providerId", filter.providerId);
  if (filter.projectId) query.set("projectId", filter.projectId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const data = await fetchJson<{ sessions: CodingSession[] }>(`/api/coding/sessions${suffix}`);
  return data.sessions;
}

export async function createSession(input: {
  providerId: string;
  projectId: string;
  mode?: "one-shot" | "persistent";
  isolate?: boolean;
}): Promise<CodingSession> {
  const data = await fetchJson<{ session: CodingSession }>("/api/coding/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.session;
}

export async function fetchSession(id: string): Promise<CodingSession> {
  const data = await fetchJson<{ session: CodingSession }>(`/api/coding/sessions/${encodeURIComponent(id)}`);
  return data.session;
}

export async function cancelSession(id: string): Promise<CodingSession> {
  const data = await fetchJson<{ session: CodingSession }>(
    `/api/coding/sessions/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
  return data.session;
}

export async function closeSession(id: string): Promise<CodingSession> {
  const data = await fetchJson<{ session: CodingSession }>(
    `/api/coding/sessions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return data.session;
}

/** Remove a session's isolated worktree (force discards uncommitted changes). */
export async function removeSessionWorktree(id: string, force = false): Promise<CodingSession> {
  const data = await fetchJson<{ session: CodingSession }>(
    `/api/coding/sessions/${encodeURIComponent(id)}/worktree${force ? "?force=1" : ""}`,
    { method: "DELETE" },
  );
  return data.session;
}

/** Human-readable error for API failures (server returns `{ error, code }`). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const match = /^\d+\s+\S*\s*(\{.*\})$/s.exec(err.message);
  if (match) {
    try {
      const payload = JSON.parse(match[1]) as { error?: string };
      if (payload.error) return payload.error;
    } catch {
      // fall through
    }
  }
  return err.message;
}

/**
 * Stream one turn over SSE. Returns when the turn finishes; the caller keeps
 * its own accumulated text so a dropped connection never loses the transcript
 * already rendered.
 */
export async function streamTurn(
  sessionId: string,
  text: string,
  onEvent: (event: CodingTurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/coding/sessions/${encodeURIComponent(sessionId)}/turns/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    let message = `Request failed with status ${res.status}`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (raw) message = raw;
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const payload = JSON.parse(raw) as CodingTurnEvent & { type?: string };
          onEvent({ ...payload, type: payload.type || eventName });
        } catch {
          // Ignore keep-alive or malformed frames.
        }
      }
    }
  }
}
