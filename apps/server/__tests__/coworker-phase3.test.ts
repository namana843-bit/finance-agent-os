// ============================================================================
// Phase 3 — FinanceBot Coworker Management
// CRUD lifecycle, duplicate, activity, defaults, built-in protection and
// backend permission enforcement for the persistent coworker system.
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
import { AgentRuntime } from "../src/llm/agent-runtime.js";
import { EngineManager, ProviderRegistry } from "../src/llm/registry.js";
import { FinanceToolRegistry } from "../src/llm/finance-tool-registry.js";
import type { LLMProvider, LLMProviderOptions } from "../src/llm/provider.js";
import type { ChatRequest, LLMEvent, ModelInfo, ProviderHealth } from "@finance/shared";

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

class MockPermProvider implements LLMProvider {
  readonly id = "mock-perm-agent";
  readonly name = "Mock Perm Agent";
  private turn = 0;

  supportsTools(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { providerId: this.id, status: "ok" };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", name: "Mock", provider: this.id }];
  }

  async *chat(_request: ChatRequest, _opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    const messageId = `msg-${Date.now()}-${Math.random()}`;
    yield { type: "message_start", messageId, model: "mock", timestamp: Date.now() };

    this.turn++;
    if (this.turn === 1) {
      yield {
        type: "tool_call",
        messageId,
        toolCallId: "call-perm-1",
        name: "create_trade_proposal",
        arguments: {
          symbol: "BTCUSDT",
          side: "BUY",
          quantity: 0.01,
          orderType: "MARKET",
          reason: "test proposal",
          confidence: 0.8,
        },
        timestamp: Date.now(),
      };
    } else {
      yield { type: "text_delta", messageId, delta: "Done.", timestamp: Date.now() };
      yield { type: "message_complete", messageId, text: "Done.", timestamp: Date.now() };
    }
  }
}

const GOOD_PROMPT =
  "You analyze BTC momentum on the 4h timeframe and draft proposals with entry, stop-loss, and confidence levels.";

let app: FastifyInstance;
let sandboxDir: string;
let prevDataDir: string | undefined;

beforeAll(async () => {
  prevDataDir = process.env.FINANCE_DATA_DIR;
  sandboxDir = mkdtempSync(join(tmpdir(), "coworker-phase3-"));
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

async function waitForPersisted(id: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (agentsFile().some((a) => a.id === id)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const FINANCEBOT_DEFAULT_IDS = [
  "financebot-supervisor",
  "financebot-market-researcher",
  "financebot-quant-researcher",
  "financebot-risk-guardian",
  "financebot-portfolio-manager",
  "financebot-execution-analyst",
  "financebot-macro-economist",
];

describe("Phase 3 — FinanceBot coworker management: defaults", () => {
  it("seeds the seven FinanceBot default coworkers with valid status fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent-runtime/agents" });
    expect(res.statusCode).toBe(200);
    const agents = (res.json() as { agents: Array<Record<string, any>> }).agents;
    const byId = new Map(agents.map((a) => [a.id, a]));

    for (const id of FINANCEBOT_DEFAULT_IDS) {
      expect(byId.has(id), `missing default coworker ${id}`).toBe(true);
      const agent = byId.get(id)!;
      expect(["active", "busy", "idle", "archived"]).toContain(agent.status);
    }

    const supervisor = byId.get("financebot-supervisor")!;
    expect(supervisor.name).toBe("FinanceBot Supervisor");
    expect(supervisor.engine).toBe("cline-cli");
    expect(supervisor.avatar).toBeDefined();
    expect(typeof supervisor.personality).toBe("string");
    expect(supervisor.memoryScope).toBeDefined();
    expect(supervisor.concurrency).toBeDefined();
  });
});

describe("Phase 3 — FinanceBot coworker management: duplicate + activity + lifecycle", () => {
  it("creates, duplicates, and cleans up a custom coworker with persistence", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Phase Three Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    expect(created.statusCode).toBe(200);
    const createdAgent = (created.json() as { agent: Record<string, any> }).agent;
    const id = createdAgent.id as string;

    const dup = await app.inject({ method: "POST", url: `/api/agent-runtime/agents/${id}/duplicate` });
    expect(dup.statusCode).toBe(200);
    const dupBody = dup.json() as { ok: boolean; agent: Record<string, any> };
    expect(dupBody.ok).toBe(true);
    expect(dupBody.agent.id).toBe(`${id}-copy`);
    expect(dupBody.agent.name).toBe(`${createdAgent.name} (Copy)`);
    expect(dupBody.agent.archived).toBeFalsy();
    expect(await waitForPersisted(`${id}-copy`)).toBe(true);

    const missing = await app.inject({ method: "POST", url: "/api/agent-runtime/agents/no-such-coworker/duplicate" });
    expect(missing.statusCode).toBe(404);

    const del = await app.inject({ method: "DELETE", url: `/api/agent-runtime/agents/${id}` });
    expect(del.statusCode).toBe(200);
    const delCopy = await app.inject({ method: "DELETE", url: `/api/agent-runtime/agents/${id}-copy` });
    expect(delCopy.statusCode).toBe(200);
  });

  it("exposes coworker activity with a derived status", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/agents",
      payload: { name: "Activity Bot", engine: "cline-cli", systemPrompt: GOOD_PROMPT },
    });
    const agent = (created.json() as { agent: Record<string, any> }).agent;
    const id = agent.id as string;

    const res = await app.inject({ method: "GET", url: `/api/agent-runtime/agents/${id}/activity` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent: Record<string, any>; status: string };
    expect(body.agent.id).toBe(id);
    expect(["active", "busy", "idle", "archived"]).toContain(body.status);

    const missing = await app.inject({ method: "GET", url: "/api/agent-runtime/agents/no-such-coworker/activity" });
    expect(missing.statusCode).toBe(404);

    await app.inject({ method: "DELETE", url: `/api/agent-runtime/agents/${id}` });
  });
});

describe("Phase 3 — FinanceBot coworker management: built-in protection", () => {
  it("refuses to weaken built-in safety-critical agents via update", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/agent-runtime/agents/risk-guardian-agent",
      payload: { name: "Risk Guardian", engine: "cline-cli", systemPrompt: GOOD_PROMPT, permissions: { execution: true } },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/built-in/);
  });
});

describe("Phase 3 — FinanceBot coworker management: runtime permission enforcement", () => {
  it("rejects create_trade_proposal when riskPermissions.allowTradeProposals is false even with execution on", async () => {
    const registry = new ProviderRegistry();
    const provider = new MockPermProvider();
    registry.register(provider);
    const engineManager = new EngineManager(registry);
    engineManager.setEngineConfig("mock-engine", {
      type: "cli",
      provider: "mock-perm-agent",
      name: "Mock Engine",
      command: "mock",
    });
    const toolRegistry = new FinanceToolRegistry();

    const runtime = new AgentRuntime({ engineManager, toolRegistry });
    runtime.registerAgent({
      id: "phase3-perm-agent",
      name: "Phase 3 Perm Agent",
      engine: "mock-engine",
      tools: ["create_trade_proposal"],
      permissions: { execution: true },
      riskPermissions: { allowTradeProposals: false },
    });

    const stream = runtime.runAgentStream("phase3-perm-agent", "draft a proposal");
    const events: LLMEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
    }

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    const toolResult = toolResults[0] as any;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.result.status).toBe("REJECTED");
    expect(toolResult.result.decision).toBe("REJECTED");

    expect(runtime.getStatus("phase3-perm-agent")).toBe("active");
  });
});
