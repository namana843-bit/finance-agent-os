// ============================================================================
// Coding Agent Workspace — HTTP surface through the real Fastify app.
//
// A stubbed CLI manager provides two fake providers with an injected process
// runner, so discovery, project validation and streaming are deterministic.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/core/server.js";
import {
  CliAdapterBase,
  CliManager,
  resetDefaultCliManager,
  setDefaultCliManager,
} from "../src/cli/index.js";
import type {
  CliProcessHandlers,
  CliProcessResult,
  CliProcessSpec,
} from "../src/cli/process-runner.js";
import { CodingWorkspace, resetCodingWorkspace, setCodingWorkspace } from "../src/coding/index.js";

class FakeCodingAdapter extends CliAdapterBase {
  constructor(id: string, private readonly installed: boolean) {
    super({
      id,
      name: `Fake ${id}`,
      description: "coding api test",
      executable: `fake-${id}`,
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["run", "{prompt}"],
      engineAliases: [id],
      installHint: "npm i -g fake",
    });
  }

  override async resolveExecutable(): Promise<string | null> {
    return this.installed ? `/fake/bin/${this.getMetadata().id}` : null;
  }

  override async validateInstallation() {
    const metadata = this.getMetadata();
    return this.installed
      ? {
          adapterId: metadata.id,
          ok: true,
          executable: metadata.executable,
          resolvedPath: `/fake/bin/${metadata.id}`,
          version: "9.9.9",
          checkedAt: Date.now(),
        }
      : {
          adapterId: metadata.id,
          ok: false,
          executable: metadata.executable,
          resolvedPath: null,
          version: null,
          error: "executable not found on PATH",
          checkedAt: Date.now(),
        };
  }
}

function runner(spec: CliProcessSpec, handlers: CliProcessHandlers = {}): Promise<CliProcessResult> {
  const started = Date.now();
  const prompt = spec.args[spec.args.length - 1] ?? "";
  if (prompt.includes("AUTH_FAIL")) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "unauthorized: login required\n",
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
    });
  }
  handlers.onStdoutChunk?.('{"delta":"Done."}\n');
  return Promise.resolve({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: Date.now() - started,
  });
}

let app: FastifyInstance;
let root: string;
let projectPath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coding-api-"));
  projectPath = join(root, "demo-project");
  await mkdir(projectPath, { recursive: true });

  const manager = new CliManager({ runProcessImpl: runner, validationTtlMs: 0 });
  manager.register(new FakeCodingAdapter("opencode", true));
  manager.register(new FakeCodingAdapter("gemini", false));
  setDefaultCliManager(manager);

  setCodingWorkspace(new CodingWorkspace({ dataDir: root, only: ["opencode", "gemini"] }));
  app = await buildServer({ logger: false });
});

afterAll(async () => {
  await app.close();
  resetCodingWorkspace();
  resetDefaultCliManager();
  await rm(root, { recursive: true, force: true });
});

describe("coding API: providers", () => {
  it("reports observed install status per provider", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/providers" });
    expect(res.statusCode).toBe(200);
    const providers = (res.json() as { providers: Array<Record<string, unknown>> }).providers;
    const opencode = providers.find((provider) => provider.providerId === "opencode") as {
      status: { installed: boolean; version: string | null };
    };
    const gemini = providers.find((provider) => provider.providerId === "gemini") as {
      status: { installed: boolean; resolvedPath: string | null };
    };
    expect(opencode.status.installed).toBe(true);
    expect(opencode.status.version).toBe("9.9.9");
    expect(gemini.status.installed).toBe(false);
    expect(gemini.status.resolvedPath).toBeNull();
  });

  it("exposes explicit unsupported capabilities instead of bare false", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/providers/opencode" });
    const provider = (res.json() as {
      provider: { capabilities: Record<string, { supported: boolean; reason?: string }> };
    }).provider;
    expect(provider.capabilities.permission_requests?.supported).toBe(false);
    expect(provider.capabilities.permission_requests?.reason?.length ?? 0).toBeGreaterThan(10);
  });

  it("answers 501 for model enumeration with a reason", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/providers/opencode/models" });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { supported: boolean; reason: string };
    expect(body.supported).toBe(false);
    expect(body.reason).toMatch(/model/i);
  });

  it("404s on unknown providers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/providers/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("does not leak environment values in provider payloads", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/providers" });
    const text = res.body;
    expect(text).not.toMatch(/api[_-]?key\s*[:=]\s*\S/i);
    expect(text).not.toContain("process.env");
  });
});

describe("coding API: projects", () => {
  it("rejects a relative or missing path with a typed code", async () => {
    const relative = await app.inject({
      method: "POST",
      url: "/api/coding/projects",
      payload: { path: "relative/dir" },
    });
    expect(relative.statusCode).toBe(400);
    expect((relative.json() as { code: string }).code).toBe("not_absolute");

    const missing = await app.inject({
      method: "POST",
      url: "/api/coding/projects",
      payload: { path: join(root, "nope") },
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { code: string }).code).toBe("missing");
  });

  it("adds a valid project and lists it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/projects",
      payload: { path: projectPath },
    });
    expect(created.statusCode).toBe(201);
    const project = (created.json() as { project: { id: string; path: string; name: string } }).project;
    expect(project.name).toBe("demo-project");

    const listed = await app.inject({ method: "GET", url: "/api/coding/projects" });
    const projects = (listed.json() as { projects: Array<{ id: string }> }).projects;
    expect(projects.some((entry) => entry.id === project.id)).toBe(true);

    const status = await app.inject({ method: "GET", url: `/api/coding/projects/${project.id}/status` });
    expect(status.statusCode).toBe(200);
  });

  it("reports a non-repo project as having no diff", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/projects",
      payload: { path: projectPath },
    });
    const project = (created.json() as { project: { id: string } }).project;
    const res = await app.inject({ method: "GET", url: `/api/coding/projects/${project.id}/diff` });
    expect(res.statusCode).toBe(200);
    const diff = (res.json() as { diff: { isRepo: boolean; files: unknown[]; patch: string } }).diff;
    expect(diff.isRepo).toBe(false);
    expect(diff.files).toEqual([]);
    expect(diff.patch).toBe("");
  });

  it("404s a diff for an unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/coding/projects/prj-nope/diff" });
    expect(res.statusCode).toBe(404);
  });
});

describe("coding API: sessions and streaming", () => {
  async function createProject(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/coding/projects", payload: { path: projectPath } });
    return (res.json() as { project: { id: string } }).project.id;
  }

  it("starts a session, streams a turn and keeps history", async () => {
    const projectId = await createProject();
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId },
    });
    expect(created.statusCode).toBe(201);
    const session = (created.json() as { session: { id: string; providerId: string; projectPath: string } }).session;
    expect(session.providerId).toBe("opencode");

    const turn = await app.inject({
      method: "POST",
      url: `/api/coding/sessions/${session.id}/turns`,
      payload: { text: "say done" },
    });
    expect(turn.statusCode).toBe(200);
    const body = turn.json() as { turn: { role: string; content: string }; session: { turns: unknown[] } };
    expect(body.turn.role).toBe("assistant");
    expect(body.turn.content).toContain("Done");
    expect(body.session.turns.length).toBe(2);

    const fetched = await app.inject({ method: "GET", url: `/api/coding/sessions/${session.id}` });
    expect(fetched.statusCode).toBe(200);
  });

  it("streams SSE events for a turn", async () => {
    const projectId = await createProject();
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId },
    });
    const session = (created.json() as { session: { id: string } }).session;
    const res = await app.inject({
      method: "POST",
      url: `/api/coding/sessions/${session.id}/turns/stream`,
      payload: { text: "stream this" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: turn_complete");
  });

  it("refuses isolation when the project is not a git repository", async () => {
    const projectId = await createProject();
    const res = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId, isolate: true },
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { code: string }).code).toBe("isolation_unavailable");
  });

  it("404s removing a worktree for an unknown session", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/coding/sessions/cs-nope/worktree" });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a session for an uninstalled provider", async () => {
    const projectId = await createProject();
    const res = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "gemini", projectId },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("provider_not_installed");
  });

  it("rejects invalid session payloads", async () => {
    const cases: Array<{ payload: unknown; status: number }> = [
      { payload: {}, status: 400 },
      { payload: { providerId: "opencode" }, status: 400 },
      { payload: { providerId: "opencode", projectId: "prj-nope" }, status: 404 },
      { payload: { providerId: "ghost", projectId: "prj-nope" }, status: 404 },
    ];
    for (const { payload, status } of cases) {
      const res = await app.inject({ method: "POST", url: "/api/coding/sessions", payload });
      expect(res.statusCode).toBe(status);
    }
  });

  it("reports an unsupported permission channel as 501", async () => {
    const projectId = await createProject();
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId },
    });
    const session = (created.json() as { session: { id: string } }).session;
    const res = await app.inject({
      method: "GET",
      url: `/api/coding/sessions/${session.id}/permissions`,
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { supported: boolean }).supported).toBe(false);
  });

  it("cancels and closes a session", async () => {
    const projectId = await createProject();
    const created = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId },
    });
    const session = (created.json() as { session: { id: string } }).session;

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/coding/sessions/${session.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);

    const closed = await app.inject({ method: "DELETE", url: `/api/coding/sessions/${session.id}` });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { session: { status: string } }).session.status).toBe("closed");
  });

  it("separates history per provider, project and session", async () => {
    const projectId = await createProject();
    const a = await app.inject({
      method: "POST",
      url: "/api/coding/sessions",
      payload: { providerId: "opencode", projectId },
    });
    const sessionA = (a.json() as { session: { id: string } }).session;
    await app.inject({
      method: "POST",
      url: `/api/coding/sessions/${sessionA.id}/turns`,
      payload: { text: "only here" },
    });
    const filtered = await app.inject({
      method: "GET",
      url: `/api/coding/sessions?providerId=gemini`,
    });
    const sessions = (filtered.json() as { sessions: Array<{ id: string }> }).sessions;
    expect(sessions.some((entry) => entry.id === sessionA.id)).toBe(false);
  });
});
