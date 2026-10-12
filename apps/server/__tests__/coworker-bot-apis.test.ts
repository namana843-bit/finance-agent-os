// ============================================================================
// Step 2 — custom bot profile APIs: list/create/fetch/update/archive/
// unarchive/delete + providers, through the real Fastify app.
//
// Uses buildServer + inject with a stubbed default CliManager (a "cline"
// adapter backed by a fake runner, so engine validation resolves without an
// installed CLI) and a sandboxed FINANCE_DATA_DIR so persistence assertions
// never touch the developer's real agents.json.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/core/server.js";
import {
  CliAdapterBase,
  CliManager,
  resetDefaultCliManager,
  setDefaultCliManager,
} from "../src/cli/index.js";
import type {
  CliProcessResult,
  CliProcessSpec,
} from "../src/cli/process-runner.js";

class StubClineAdapter extends CliAdapterBase {
  constructor() {
    super({
      id: "cline",
      name: "Cline",
      description: "test Cline CLI",
      executable: "cline",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["--json", "{prompt}"],
      engineAliases: ["cline", "cline-cli"],
      installHint: "test only",
      sessionModes: ["one-shot"],
    });
  }

  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/cline";
  }
}

function stubRunner(): (spec: CliProcessSpec) => Promise<CliProcessResult> {
  return async () => ({
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 0,
  });
}

const GOOD_PROMPT =
  "You analyze BTC momentum on the 4h timeframe and draft proposals with entry, stop-loss, and confidence levels.";

let app: FastifyInstance;
let sandboxDir: string;
let prevDataDir: string | undefined;

beforeAll(async () => {
  prevDataDir = process.env.FINANCE_DATA_DIR;
  sandboxDir = mkdtempSync(join(tmpdir(), "bot-apis-"));
  process.env.FINANCE_DATA_DIR = sandboxDir;
  const manager = new CliManager({ runProcessImpl: stubRunner() });
  manager.register(new StubClineAdapter());
  setDefaultCliManager(manager);
  app = await buildServer({ logger: false });
});

afterAll(async () => {
  await app.close();
  resetDefaultCliManager();
  if (prevDataDir === undefined) delete process.env.FINANCE_DATA_DIR;
  else process.env.FINANCE_DATA_DIR = prevDataDir;
});

function agentsFile(): any[] {
  const p = join(sandboxDir, "agents.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8"));
}

/** Persistence saves are fire-and-forget; wait until the record lands. */
async function waitForPersisted(id: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (agentsFile().some((a) => a.id === id)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("bot APIs: list + templates", () => {
  it("lists built-in agents and templates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent-runtime/agents" });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { agents: Array<{ id: string }> }).agents.map((a) => a.id);
    expect(ids).toContain("btc-quant-agent");

    const tpl = await app.inject({ method: "GET", url: "/api/agent-runtime/templates" });
    expect(tpl.statusCode).toBe(200);
    const templates = (tpl.json() as { templates: Array<{ key: string; engine: string }> }).templates;
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const t of templates) expect(t.engine).toBe("cline-cli");
  });
});

describe("bot APIs: create", () => {
  it("creates a bot, appends safety rails, and persists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: {
        name: "Step Two Quant",
        engine: "cline-cli",
        systemPrompt: GOOD_PROMPT,
        tools: ["get_market_price"],
      },
    });
    expect(res.statusCode).toBe(200);
    const agent = (res.json() as { agent: Record<string, any> }).agent;
    expect(agent.id).toBe("coworker-step-two-quant");
    expect(agent.systemPrompt).toMatch(/Paper trading only/);
    expect(agent.createdAt).toBeDefined();
    expect(agent.updatedAt).toBeDefined();
    expect(await waitForPersisted(agent.id)).toBe(true);

    const fetched = await app.inject({ method: "GET", url: `/api/agent-runtime/agents/${agent.id}` });
    expect(fetched.statusCode).toBe(200);
  });

  it("rejects executable-smuggling fields with 400", async () => {
    for (const payload of [
      { name: "Evil Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, command: "cline" },
      { name: "Evil Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, args: ["--json"] },
      { name: "Evil Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, cwd: "/tmp" },
      { name: "Evil Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, executablePath: "/bin/sh" },
      { name: "Evil Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, env: { X: "1" } },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/agent-runtime/agents", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().details.join(" ")).toMatch(/forbidden fields/);
    }
  });

  it("409s on duplicate ids and 400s on invalid input", async () => {
    const dup = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Step Two Quant", engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    expect(dup.statusCode).toBe(409);

    const noName = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().details).toBeDefined();

    const badEngine = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Nope Bot", engine: "definitely-not-an-engine", systemPrompt: GOOD_PROMPT },
    });
    expect(badEngine.statusCode).toBe(400);

    const badTool = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Tool Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT, tools: ["hack_exchange"] },
    });
    expect(badTool.statusCode).toBe(400);

    const short = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Short Bot", engine: "cline-cli", systemPrompt: "too short" },
    });
    expect(short.statusCode).toBe(400);
  });

  it("404s on missing records", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent-runtime/agents/no-such-bot" });
    expect(res.statusCode).toBe(404);
  });
});

describe("bot APIs: update", () => {
  it("updates name/model, preserves createdAt, stamps updatedAt", async () => {
    const before = await app.inject({ method: "GET", url: "/api/agent-runtime/agents/coworker-step-two-quant" });
    const createdAt = (before.json() as any).agent.createdAt;

    const res = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
      payload: { name: "Step Two Quant v2", engine: "cline-cli", model: "test-model", systemPrompt: GOOD_PROMPT },
    });
    expect(res.statusCode).toBe(200);
    const agent = (res.json() as any).agent;
    expect(agent.name).toBe("Step Two Quant v2");
    expect(agent.model).toBe("test-model");
    expect(agent.createdAt).toBe(createdAt);
    expect(agent.updatedAt).toBeDefined();
  });

  it("400s on id mismatch and invalid engines, 404s on missing", async () => {
    const mismatch = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
      payload: { id: "other-id", name: "X", engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    expect(mismatch.statusCode).toBe(400);

    const badEngine = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
      payload: { name: "X", engine: "nope", systemPrompt: GOOD_PROMPT },
    });
    expect(badEngine.statusCode).toBe(400);

    const smuggled = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
      payload: { name: "X", engine: "cline-cli", systemPrompt: GOOD_PROMPT, command: "cline" },
    });
    expect(smuggled.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/no-such-bot",
      payload: { name: "X", engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("bot APIs: archive + delete safety", () => {
  it("archives, hides from default list, restores", async () => {
    const archived = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/coworker-step-two-quant/archive",
    });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as any).agent.archived).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/agent-runtime/agents" });
    expect((list.json() as any).agents.map((a: any) => a.id)).not.toContain("coworker-step-two-quant");

    const withArchived = await app.inject({
      method: "GET",
      url: "/api/agent-runtime/agents?includeArchived=1",
    });
    expect((withArchived.json() as any).agents.map((a: any) => a.id)).toContain("coworker-step-two-quant");

    const again = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/coworker-step-two-quant/archive",
    });
    expect(again.statusCode).toBe(409);

    const restored = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/coworker-step-two-quant/unarchive",
    });
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as any).agent.archived).toBeUndefined();

    const notArchived = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/coworker-step-two-quant/unarchive",
    });
    expect(notArchived.statusCode).toBe(409);
  });

  it("403s archive/delete of built-in agents, 404s on missing", async () => {
    const archBuiltIn = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/btc-quant-agent/archive",
    });
    expect(archBuiltIn.statusCode).toBe(403);

    const delBuiltIn = await app.inject({
      method: "DELETE",
      url: "/api/agent-runtime/agents/btc-quant-agent",
    });
    expect(delBuiltIn.statusCode).toBe(403);

    const archMissing = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents/no-such-bot/archive",
    });
    expect(archMissing.statusCode).toBe(404);
  });

  it("deletes a custom bot and 404s afterwards", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
    });
    expect(del.statusCode).toBe(200);

    const gone = await app.inject({ method: "GET", url: "/api/agent-runtime/agents/coworker-step-two-quant" });
    expect(gone.statusCode).toBe(404);

    const delAgain = await app.inject({
      method: "DELETE",
      url: "/api/agent-runtime/agents/coworker-step-two-quant",
    });
    expect(delAgain.statusCode).toBe(404);
  });
});

describe("bot APIs: providers", () => {
  it("lists providers with adapter capabilities and no secrets", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent-runtime/providers" });
    expect(res.statusCode).toBe(200);
    const providers = (res.json() as { providers: Array<Record<string, any>> }).providers;
    expect(providers.length).toBeGreaterThan(0);

    const cli = providers.find((p) => p.id === "cli-cline");
    expect(cli).toBeDefined();
    expect(cli?.kind).toBe("cli");
    expect(cli?.adapter).toMatchObject({
      id: "cline",
      executable: "cline",
      installed: true,
      resolvedPath: "/fake/bin/cline",
      taskDelivery: "argv",
      supportsStreaming: true,
      supportsCancellation: true,
    });
    expect(cli?.adapter.sessionModes).toEqual(["one-shot"]);
    expect(Array.isArray(cli?.engines)).toBe(true);
    expect(cli?.engines).toContain("cline-cli");
    expect(cli?.health.status).toBeDefined();

    // No secret material leaks through provider metadata.
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/"env"\s*:/);
    expect(serialized).not.toMatch(/sk-live|Bearer /);
  });
});
