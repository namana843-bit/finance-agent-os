// ============================================================================
// CLI API surface — route-level tests through the real Fastify app.
// Uses buildServer + inject with a stubbed default CliManager (fake runner,
// no installed CLI, no credentials). Covers success, invalid input,
// unavailable providers/sessions, stopped sessions, process failures, the
// no-secret-leak guarantee, and the documented localhost trust model.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
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

class FakeApiAdapter extends CliAdapterBase {
  constructor(id = "fake") {
    super({
      id,
      name: `Fake ${id}`,
      description: "API test CLI",
      executable: `fake-${id}`,
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["run", "{prompt}"],
      engineAliases: [id],
      installHint: "test only",
      authHint: "test only",
      sessionModes: ["one-shot"],
    });
  }

  override async resolveExecutable(): Promise<string | null> {
    return `/fake/bin/${this.getMetadata().id}`;
  }
}

function stubRunner(seen: CliProcessSpec[]): (
  spec: CliProcessSpec,
  handlers?: CliProcessHandlers,
) => Promise<CliProcessResult> {
  return async (spec, handlers = {}) => {
    seen.push(spec);
    const started = Date.now();
    const prompt = spec.args[spec.args.length - 1] ?? "";
    if (prompt.includes("boom")) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        spawnError: "spawn ENOENT (test)",
        durationMs: Date.now() - started,
      };
    }
    if (prompt.includes("fail")) {
      handlers.onStdoutChunk?.("error: bad credentials (test)\n");
      return {
        exitCode: 1,
        stdout: "error: bad credentials (test)\n",
        stderr: "",
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started,
      };
    }
    handlers.onStdoutChunk?.("ok\n");
    return {
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
    };
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  const seen: CliProcessSpec[] = [];
  const manager = new CliManager({ runProcessImpl: stubRunner(seen) });
  manager.register(new FakeApiAdapter());
  setDefaultCliManager(manager);
  app = await buildServer({ logger: false });
});

afterAll(async () => {
  await app.close();
  resetDefaultCliManager();
});

describe("CLI API: adapters", () => {
  it("lists adapters with capabilities and installation info", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cli/adapters" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { adapters: Array<Record<string, unknown>> };
    const fake = body.adapters.find((a) => a.id === "fake");
    expect(fake).toMatchObject({
      executable: "fake-fake",
      taskDelivery: "argv",
      supportsStreaming: true,
      supportsCancellation: true,
    });
    expect(fake?.sessionModes).toEqual(["one-shot"]);
    expect(fake).toHaveProperty("installation");
    expect(fake).toHaveProperty("authHint");
  });

  it("inspects one adapter and 404s on unknown ids", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/cli/adapters/fake" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty("adapter");
    const missing = await app.inject({ method: "GET", url: "/api/cli/adapters/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("validates installations and 404s on unknown ids", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/cli/adapters/fake/validate" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().validation).toMatchObject({ adapterId: "fake" });
    const missing = await app.inject({ method: "POST", url: "/api/cli/adapters/nope/validate" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("CLI API: sessions", () => {
  it("starts and inspects a session", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    expect(started.statusCode).toBe(200);
    const session = (started.json() as { session: { id: string; mode: string } }).session;
    expect(session.mode).toBe("one-shot");

    const fetched = await app.inject({ method: "GET", url: `/api/cli/sessions/${session.id}` });
    expect(fetched.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/cli/sessions" });
    expect(listed.statusCode).toBe(200);
    expect(Array.isArray((listed.json() as { sessions: unknown[] }).sessions)).toBe(true);
  });

  it("rejects invalid start payloads", async () => {
    const cases: Array<{ payload: unknown; status: number }> = [
      { payload: {}, status: 400 },
      { payload: { adapterId: "" }, status: 400 },
      { payload: { adapterId: "nope" }, status: 404 },
      { payload: { adapterId: "fake", mode: "telepathy" }, status: 400 },
      { payload: { adapterId: "fake", mode: "persistent" }, status: 400 },
      { payload: { adapterId: "fake", timeoutMs: "soon" }, status: 400 },
      { payload: { adapterId: "fake", timeoutMs: -5 }, status: 400 },
      { payload: { adapterId: "fake", env: { "BAD-KEY!": "x" } }, status: 400 },
      { payload: { adapterId: "fake", env: { OK: 42 } }, status: 400 },
      { payload: { adapterId: "fake", args: "run" }, status: 400 },
      { payload: { adapterId: "fake", cwd: "/definitely/not/a/real/dir-xyz" }, status: 400 },
    ];
    for (const { payload, status } of cases) {
      const res = await app.inject({ method: "POST", url: "/api/cli/sessions", payload });
      expect(res.statusCode).toBe(status);
    }
  });

  it("404s on unknown sessions and stops sessions", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/cli/sessions/nope" });
    expect(missing.statusCode).toBe(404);

    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    const id = (started.json() as { session: { id: string } }).session.id;
    const stopped = await app.inject({ method: "DELETE", url: `/api/cli/sessions/${id}` });
    expect(stopped.statusCode).toBe(200);

    const stopMissing = await app.inject({ method: "DELETE", url: "/api/cli/sessions/nope" });
    expect(stopMissing.statusCode).toBe(404);
  });
});

describe("CLI API: tasks", () => {
  it("runs a task and reports the normalized result", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    const id = (started.json() as { session: { id: string } }).session.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("rejects empty tasks, unknown sessions and stopped sessions", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    const id = (started.json() as { session: { id: string } }).session.id;

    const empty = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "   " },
    });
    expect(empty.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "x", model: "m".repeat(300) },
    });
    expect(oversized.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/cli/sessions/nope/tasks",
      payload: { task: "hi" },
    });
    expect(unknown.statusCode).toBe(404);

    await app.inject({ method: "DELETE", url: `/api/cli/sessions/${id}` });
    const stopped = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "late" },
    });
    expect(stopped.statusCode).toBe(409);
  });

  it("surfaces startup and process failures as 500 results", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    const id = (started.json() as { session: { id: string } }).session.id;

    const spawnFail = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "please boom" },
    });
    expect(spawnFail.statusCode).toBe(500);
    expect(spawnFail.json().result).toMatchObject({ ok: false });

    // A fresh session is needed: the spawn failure marks it failed.
    const started2 = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake" },
    });
    const id2 = (started2.json() as { session: { id: string } }).session.id;
    const exitFail = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id2}/tasks`,
      payload: { task: "please fail" },
    });
    expect(exitFail.statusCode).toBe(500);
    expect(exitFail.json().result).toMatchObject({ ok: false, exitCode: 1 });
  });

  it("never leaks session env values in any response", async () => {
    const secret = "sk-test-never-leak-12345";
    const started = await app.inject({
      method: "POST",
      url: "/api/cli/sessions",
      payload: { adapterId: "fake", env: { MY_API_KEY: secret } },
    });
    expect(started.statusCode).toBe(200);
    expect(started.body).not.toContain(secret);
    const id = (started.json() as { session: { id: string } }).session.id;

    const fetched = await app.inject({ method: "GET", url: `/api/cli/sessions/${id}` });
    expect(fetched.body).not.toContain(secret);

    const tasked = await app.inject({
      method: "POST",
      url: `/api/cli/sessions/${id}/tasks`,
      payload: { task: "hi" },
    });
    expect(tasked.body).not.toContain(secret);

    const adapters = await app.inject({ method: "GET", url: "/api/cli/adapters" });
    expect(adapters.body).not.toContain(secret);
  });

  it("documents the localhost trust model: no auth headers required", async () => {
    // The whole server (all routes, not just CLI) is a single-user localhost
    // app with no per-route auth. This test locks in that contract: CLI
    // routes must behave exactly like the existing routes — open, with
    // safety enforced by argv-only spawning and input validation instead.
    const res = await app.inject({ method: "GET", url: "/api/cli/adapters" });
    expect(res.statusCode).toBe(200);
  });
});
