// ============================================================================
// Finance Agent OS — Coding Agent Workspace: HTTP surface
//
// Every route answers with observed backend state. Nothing here decides that a
// provider "works" because it is registered — installation, version and auth
// come from the provider registry, and unsupported capabilities return an
// explicit `{ supported: false, reason }` payload.
// ============================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import type { CliSessionMode } from "../cli/index.js";
import type { CodingWorkspace } from "./index.js";
import { readProjectDiff, readProjectGit, validateProjectPath } from "./projects.js";
import { CodingSessionError } from "./sessions.js";
import { unsupported, type CodingTurnEvent } from "./types.js";

const MAX_TURN_CHARS = 200_000;
const MAX_PROJECT_PATH_CHARS = 1_024;

function statusForError(err: CodingSessionError): number {
  switch (err.code) {
    case "unknown_provider":
    case "unknown_project":
    case "unknown_session":
      return 404;
    case "provider_not_installed":
    case "session_start_failed":
    case "session_expired":
      return 409;
    case "unsupported_capability":
      return 501;
    case "isolation_unavailable":
    case "not_isolated":
      return 501;
    case "project_busy":
    case "worktree_remove_failed":
      return 409;
    case "session_busy":
      return 409;
    case "session_closed":
      return 409;
    case "invalid_turn":
      return 400;
    case "turn_failed":
      return 502;
    default:
      return 400;
  }
}

function errorPayload(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof CodingSessionError) {
    return { status: statusForError(err), body: { error: err.message, code: err.code } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerCodingRoutes(app: FastifyInstance, getWorkspace: () => CodingWorkspace): void {
  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { refresh?: string; only?: string } }>("/api/coding/providers", async (request) => {
    const workspace = getWorkspace();
    const refresh = request.query?.refresh === "1" || request.query?.refresh === "true";
    const providers = await workspace.providers.describeAll({ refresh });
    return { providers };
  });

  app.get<{ Params: { id: string } }>("/api/coding/providers/:id", async (request, reply) => {
    const provider = await getWorkspace().providers.describe(request.params.id);
    if (!provider) return reply.status(404).send({ error: `unknown coding provider '${request.params.id}'` });
    return { provider };
  });

  app.post<{ Params: { id: string } }>("/api/coding/providers/:id/refresh", async (request, reply) => {
    const provider = await getWorkspace().providers.describe(request.params.id, { refresh: true });
    if (!provider) return reply.status(404).send({ error: `unknown coding provider '${request.params.id}'` });
    return { provider };
  });

  app.get<{ Params: { id: string } }>("/api/coding/providers/:id/models", async (request, reply) => {
    const workspace = getWorkspace();
    if (!workspace.providers.has(request.params.id)) {
      return reply.status(404).send({ error: `unknown coding provider '${request.params.id}'` });
    }
    const result = await workspace.providers.listModels(request.params.id);
    if (!result.supported) {
      // 501: the capability itself is absent, not a transient failure.
      return reply.status(501).send({ supported: false, reason: result.reason, models: [] });
    }
    return { supported: true, models: result.value };
  });

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  app.get("/api/coding/projects", async () => {
    return { projects: getWorkspace().projects.list() };
  });

  app.post<{ Body: { path?: string } }>("/api/coding/projects", async (request, reply) => {
    const workspace = getWorkspace();
    const path = request.body?.path;
    const validation = await validateProjectPath(path);
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error, code: validation.code });
    }
    const git = await readProjectGit(validation.path);
    const project = workspace.projects.add(validation.path, git);
    return reply.status(201).send({ project });
  });

  app.delete<{ Params: { id: string } }>("/api/coding/projects/:id", async (request, reply) => {
    const workspace = getWorkspace();
    const project = workspace.projects.get(request.params.id);
    if (!project) return reply.status(404).send({ error: `unknown project '${request.params.id}'` });
    const active = workspace.sessions
      .list({ projectId: project.id })
      .filter((session) => session.status === "running");
    if (active.length > 0) {
      return reply.status(409).send({
        error: `project has ${active.length} running session(s); stop them before removing it`,
        sessionIds: active.map((session) => session.id),
      });
    }
    workspace.projects.remove(project.id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { providerId?: string; projectId?: string } }>("/api/coding/sessions", async (request) => {
    const { providerId, projectId } = request.query ?? {};
    return {
      sessions: getWorkspace().sessions.list({
        ...(providerId ? { providerId } : {}),
        ...(projectId ? { projectId } : {}),
      }),
    };
  });

  app.post<{ Body: { providerId?: string; projectId?: string; model?: string; mode?: string; title?: string; isolate?: boolean } }>(
    "/api/coding/sessions",
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.providerId !== "string" || !body.providerId.trim()) {
        return reply.status(400).send({ error: "providerId is required" });
      }
      if (typeof body.projectId !== "string" || !body.projectId.trim()) {
        return reply.status(400).send({ error: "projectId is required" });
      }
      if (body.mode !== undefined && body.mode !== "one-shot" && body.mode !== "persistent") {
        return reply.status(400).send({ error: "mode must be 'one-shot' or 'persistent'" });
      }
      if (body.isolate !== undefined && typeof body.isolate !== "boolean") {
        return reply.status(400).send({ error: "isolate must be a boolean" });
      }
      if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 256)) {
        return reply.status(400).send({ error: "model must be a string of at most 256 characters" });
      }
      try {
        const session = await getWorkspace().sessions.create({
          providerId: body.providerId,
          projectId: body.projectId,
          ...(body.model ? { model: body.model } : {}),
          ...(body.mode ? { mode: body.mode as CliSessionMode } : {}),
          ...(body.isolate ? { isolate: true } : {}),
          ...(body.title ? { title: body.title } : {}),
        });
        return reply.status(201).send({ session });
      } catch (err) {
        const { status, body: payload } = errorPayload(err);
        return reply.status(status).send(payload);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/coding/sessions/:id", async (request, reply) => {
    const session = getWorkspace().sessions.get(request.params.id);
    if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });
    return { session };
  });

  /** Non-streaming turn (used by scripts and tests). */
  app.post<{ Params: { id: string }; Body: { text?: string; model?: string; timeoutMs?: number } }>(
    "/api/coding/sessions/:id/turns",
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return reply.status(400).send({ error: "text is required" });
      }
      try {
        const events: CodingTurnEvent[] = [];
        const iterator = getWorkspace().sessions.streamTurn(request.params.id, body.text, {
          ...(body.model ? { model: body.model } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        });
        let result = await iterator.next();
        while (!result.done) {
          events.push(result.value);
          result = await iterator.next();
        }
        const session = getWorkspace().sessions.get(request.params.id);
        return { turn: result.value, events, session };
      } catch (err) {
        const { status, body: payload } = errorPayload(err);
        return reply.status(status).send(payload);
      }
    },
  );

  /** Streaming turn — server-sent events, one event per structured chunk. */
  app.post<{ Params: { id: string }; Body: { text?: string; model?: string; timeoutMs?: number } }>(
    "/api/coding/sessions/:id/turns/stream",
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return reply.status(400).send({ error: "text is required" });
      }
      if (body.text.length > MAX_TURN_CHARS) {
        return reply.status(400).send({ error: `text allows at most ${MAX_TURN_CHARS} characters` });
      }
      const session = getWorkspace().sessions.get(request.params.id);
      if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      try {
        const iterator = getWorkspace().sessions.streamTurn(request.params.id, body.text, {
          ...(body.model ? { model: body.model } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        });
        let result = await iterator.next();
        while (!result.done) {
          writeSse(reply, result.value.type, result.value);
          result = await iterator.next();
        }
        writeSse(reply, "turn_complete", result.value);
      } catch (err) {
        const { body: payload } = errorPayload(err);
        writeSse(reply, "error", { ...payload, fatal: true });
      } finally {
        reply.raw.end();
      }
      return reply;
    },
  );

  app.post<{ Params: { id: string } }>("/api/coding/sessions/:id/cancel", async (request, reply) => {
    const session = await getWorkspace().sessions.cancel(request.params.id);
    if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });
    return { session };
  });

  app.delete<{ Params: { id: string } }>("/api/coding/sessions/:id", async (request, reply) => {
    const session = await getWorkspace().sessions.close(request.params.id);
    if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });
    return { ok: true, session };
  });

  /**
   * Drop the isolated worktree of a session. `?force=1` is required to discard
   * uncommitted changes — the default refuses and reports why.
   */
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/coding/sessions/:id/worktree",
    async (request, reply) => {
      const force = request.query?.force === "1" || request.query?.force === "true";
      try {
        const session = await getWorkspace().sessions.removeWorktree(request.params.id, force);
        if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });
        return { ok: true, session };
      } catch (err) {
        const { status, body } = errorPayload(err);
        return reply.status(status).send(body);
      }
    },
  );

  /**
   * Permission requests. No adapter exposes an interactive permission channel,
   * so this is an explicit unsupported response rather than a silent empty list.
   */
  app.get<{ Params: { id: string } }>("/api/coding/sessions/:id/permissions", async (request, reply) => {
    const workspace = getWorkspace();
    const session = workspace.sessions.get(request.params.id);
    if (!session) return reply.status(404).send({ error: `unknown coding session '${request.params.id}'` });
    const provider = await workspace.providers.describe(session.providerId);
    if (!provider) {
      return reply.status(404).send({ error: `unknown coding provider '${session.providerId}'` });
    }
    if (!provider.capabilities.permission_requests.supported) {
      return reply.status(501).send({
        ...unsupported(provider.capabilities.permission_requests.reason),
        requests: [],
      });
    }
    return { supported: true, requests: [] };
  });

  // -------------------------------------------------------------------------
  // Project working-tree review (provider-independent)
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/coding/projects/:id/status", async (request, reply) => {
    const project = getWorkspace().projects.get(request.params.id);
    if (!project) return reply.status(404).send({ error: `unknown project '${request.params.id}'` });
    const git = await readProjectGit(project.path);
    return { project: { ...project, git } };
  });

  /**
   * Uncommitted working-tree changes. Read-only; a non-repo project answers
   * `isRepo: false` rather than an error.
   */
  app.get<{ Params: { id: string } }>("/api/coding/projects/:id/diff", async (request, reply) => {
    const project = getWorkspace().projects.get(request.params.id);
    if (!project) return reply.status(404).send({ error: `unknown project '${request.params.id}'` });
    return { diff: await readProjectDiff(project.path) };
  });
}

export const CODING_ROUTE_MAX_PATH_CHARS = MAX_PROJECT_PATH_CHARS;
