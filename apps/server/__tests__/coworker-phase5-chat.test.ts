// ============================================================================
// Phase 5 — FinanceBot Coworker Chat
// Persistent conversations, streaming replies, stop, regenerate, search and
// model switching for AI coworkers.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
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
import type { CliProcessResult, CliProcessSpec } from "../src/cli/process-runner.js";
import { AgentRuntime } from "../src/llm/agent-runtime.js";
import { AgentPersistence } from "../src/llm/persistence.js";
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

class MockChatProvider implements LLMProvider {
  readonly id = "mock-chat";
  readonly name = "Mock Chat";
  private turn = 0;

  supportsTools(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { providerId: this.id, status: "ok" };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-chat-model", name: "Mock Chat", provider: this.id }];
  }

  async *chat(_request: ChatRequest, _opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    this.turn += 1;
    const messageId = `msg-${Date.now()}-${this.turn}`;
    const text = "Risk reviewed: position sizing looks acceptable.";
    yield { type: "message_start", messageId, model: "mock-chat-model", timestamp: Date.now() };
    yield { type: "text_delta", messageId, delta: text, timestamp: Date.now() };
    yield { type: "message_complete", messageId, text, timestamp: Date.now() };
  }
}

class BlockingProvider implements LLMProvider {
  readonly id = "mock-block";
  readonly name = "Mock Block";
  supportsTools(): boolean {
    return false;
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { providerId: this.id, status: "ok" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-block-model", name: "Mock Block", provider: this.id }];
  }
  async *chat(_request: ChatRequest, opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    const messageId = "msg-block";
    yield { type: "message_start", messageId, model: "mock-block-model", timestamp: Date.now() };
    yield { type: "text_delta", messageId, delta: "Working", timestamp: Date.now() };
    // Block until the run is aborted; the stream must not finish on its own.
    if (opts?.signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 30_000);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

function buildEngineManager(provider: LLMProvider, engineId: string, model: string) {
  const registry = new ProviderRegistry();
  registry.register(provider);
  const engineManager = new EngineManager(registry);
  engineManager.setEngineConfig(engineId, {
    type: "cli",
    provider: provider.id,
    name: "Mock Engine",
    command: "mock",
    model,
  });
  return engineManager;
}

describe("Phase 5 — FinanceBot coworker chat", () => {
  let prevDataDir: string | undefined;
  let sandboxDir: string;

  beforeAll(() => {
    prevDataDir = process.env.FINANCE_DATA_DIR;
    sandboxDir = mkdtempSync(join(tmpdir(), "coworker-phase5-runtime-"));
    process.env.FINANCE_DATA_DIR = sandboxDir;
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env.FINANCE_DATA_DIR;
    else process.env.FINANCE_DATA_DIR = prevDataDir;
  });

  it("creates conversations, streams replies, and persists history per conversation", async () => {
    const engineManager = buildEngineManager(new MockChatProvider(), "mock-chat-engine", "mock-chat-model");
    const toolRegistry = new FinanceToolRegistry();
    const persistence = new AgentPersistence();
    const runtime = new AgentRuntime({ engineManager, toolRegistry, persistence });

    const agentId = "phase5-chat-agent";
    runtime.registerAgent({
      id: agentId,
      name: "Phase 5 Chat Agent",
      engine: "mock-chat-engine",
      systemPrompt: "You are a Phase 5 chat test agent.",
      tools: [],
      permissions: { execution: false },
      riskPermissions: { allowTradeProposals: false },
    });

    const conversationId = await runtime.createConversation(agentId);
    expect(conversationId).toMatch(new RegExp(`^${agentId}-conv-`));

    const listBefore = await runtime.listConversations(agentId);
    expect(listBefore.length).toBe(1);
    expect(listBefore[0].id).toBe(conversationId);
    expect(listBefore[0].messageCount).toBe(0);

    let streamedText = "";
    const stream = runtime.runAgentStream(agentId, "Review the BTC risk", [], { conversationId });
    for await (const event of stream) {
      if (event.type === "text_delta") streamedText += event.delta;
    }
    expect(streamedText).toContain("Risk reviewed");

    const history = await runtime.getConversation(agentId, conversationId);
    expect(history.filter((m) => m.role === "user").length).toBe(1);
    expect(history.filter((m) => m.role === "assistant").length).toBe(1);

    // Second conversation for the same coworker is isolated.
    const secondConversationId = await runtime.createConversation(agentId);
    const stream2 = runtime.runAgentStream(agentId, "Second question", [], { conversationId: secondConversationId });
    let secondText = "";
    for await (const event of stream2) {
      if (event.type === "text_delta") secondText += event.delta;
    }
    expect(secondText).toContain("Risk reviewed");

    const firstHistory = await runtime.getConversation(agentId, conversationId);
    const secondHistory = await runtime.getConversation(agentId, secondConversationId);
    expect(firstHistory.length).toBe(2);
    expect(secondHistory.length).toBe(2);

    // Persist across restart: a fresh runtime over the same persistence loads history.
    const runtime2 = new AgentRuntime({ engineManager, toolRegistry, persistence });
    const reloaded = await runtime2.getConversation(agentId, conversationId);
    expect(reloaded.length).toBe(2);
    const reloadedList = await runtime2.listConversations(agentId);
    expect(reloadedList.length).toBe(2);
  });

  it("stops an in-flight agent run and ends the stream", async () => {
    const provider = new BlockingProvider();
    const engineManager = buildEngineManager(provider, "mock-block-engine", "mock-block-model");
    const runtime = new AgentRuntime({
      engineManager,
      toolRegistry: new FinanceToolRegistry(),
    });
    runtime.registerAgent({
      id: "phase5-block-agent",
      name: "Phase 5 Block Agent",
      engine: "mock-block-engine",
      systemPrompt: "You are a Phase 5 blocking test agent.",
      tools: [],
      permissions: { execution: false },
    });

    const conversationId = await runtime.createConversation("phase5-block-agent");
    const stream = runtime.runAgentStream("phase5-block-agent", "hold", [], { conversationId });
    const iterator = stream[Symbol.asyncIterator]();
    // The provider streams a little then blocks, so the first event arrives
    // while the run is still in flight and can be stopped.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(runtime.stopAgent("phase5-block-agent")).toBe(true);
    let ended = false;
    for (let i = 0; i < 10 && !ended; i += 1) {
      ended = (await iterator.next()).done === true;
    }
    expect(ended).toBe(true);
  });

  it("regenerates a conversation reply from the last user message", async () => {
    const engineManager = buildEngineManager(new MockChatProvider(), "mock-chat-engine", "mock-chat-model");
    const runtime = new AgentRuntime({ engineManager, toolRegistry: new FinanceToolRegistry() });
    runtime.registerAgent({
      id: "phase5-regen-agent",
      name: "Phase 5 Regen Agent",
      engine: "mock-chat-engine",
      systemPrompt: "You are a Phase 5 regen test agent.",
      tools: [],
      permissions: { execution: false },
    });

    const conversationId = await runtime.createConversation("phase5-regen-agent");
    let streamedText = "";
    const firstStream = runtime.runAgentStream("phase5-regen-agent", "first question", [], { conversationId });
    for await (const event of firstStream) {
      if (event.type === "text_delta") streamedText += event.delta;
    }
    expect(streamedText).toContain("Risk reviewed");
    expect((await runtime.getConversation("phase5-regen-agent", conversationId)).length).toBe(2);

    const outcome = await runtime.regenerateConversation("phase5-regen-agent", conversationId);
    expect(outcome).toBeDefined();
    expect(outcome?.prompt).toBe("first question");

    let regenText = "";
    const regenStream = runtime.runAgentStream("phase5-regen-agent", outcome?.prompt ?? "", outcome?.history ?? [], { conversationId });
    for await (const event of regenStream) {
      if (event.type === "text_delta") regenText += event.delta;
    }
    expect(regenText).toContain("Risk reviewed");
    expect((await runtime.getConversation("phase5-regen-agent", conversationId)).length).toBe(2);
  });

  it("searches conversation history for prior messages", async () => {
    const engineManager = buildEngineManager(new MockChatProvider(), "mock-chat-engine", "mock-chat-model");
    const runtime = new AgentRuntime({ engineManager, toolRegistry: new FinanceToolRegistry() });
    runtime.registerAgent({
      id: "phase5-search-agent",
      name: "Phase 5 Search Agent",
      engine: "mock-chat-engine",
      systemPrompt: "You are a Phase 5 search test agent.",
      tools: [],
      permissions: { execution: false },
    });
    const conversationId = await runtime.createConversation("phase5-search-agent");
    const stream = runtime.runAgentStream("phase5-search-agent", "Summarize the risk proposal for Q3", [], { conversationId });
    for await (const event of stream) {
      // consume until completion
    }

    const hits = await runtime.searchConversations("phase5-search-agent", "risk proposal");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].conversationId).toBe(conversationId);
    expect(hits[0].role).toBe("user");

    const noHits = await runtime.searchConversations("phase5-search-agent", "zzzz-not-present");
    expect(noHits.length).toBe(0);
  });

  it("switches models only for permitted (custom) agents and refuses built-ins", async () => {
    const engineManager = buildEngineManager(new MockChatProvider(), "mock-chat-engine", "mock-chat-model");
    const runtime = new AgentRuntime({ engineManager, toolRegistry: new FinanceToolRegistry() });
    const custom = runtime.registerAgent({
      id: "phase5-custom-agent",
      name: "Phase 5 Custom Agent",
      engine: "mock-chat-engine",
      systemPrompt: "You are a Phase 5 custom agent.",
      tools: [],
      permissions: { execution: false },
    });
    void custom;

    const switched = runtime.setAgentModel("phase5-custom-agent", "mock-chat-model-2");
    expect(switched?.model).toBe("mock-chat-model-2");

    const builtInSwitch = runtime.setAgentModel("financebot-macro-economist", "some-other-model");
    expect(builtInSwitch).toBeUndefined();
  });
});

describe("Phase 5 — FinanceBot coworker chat: api surface", () => {
  let app: FastifyInstance;
  let sandboxDir: string;
  let prevDataDir: string | undefined;

  beforeAll(async () => {
    prevDataDir = process.env.FINANCE_DATA_DIR;
    sandboxDir = mkdtempSync(join(tmpdir(), "coworker-phase5-"));
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

  it("creates, lists, reads history, stops, and regenerates conversations", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-runtime/conversations",
      payload: { agentId: "financebot-macro-economist" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { ok: boolean; conversationId: string };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.conversationId).toMatch(/^financebot-macro-economist-conv-/);
    const conversationId = createdBody.conversationId;

    const list = await app.inject({
      method: "GET",
      url: "/api/agent-runtime/conversations?agentId=financebot-macro-economist",
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { conversations: Array<{ id: string }> };
    expect(listBody.conversations.some((c) => c.id === conversationId)).toBe(true);

    const history = await app.inject({
      method: "GET",
      url: `/api/agent-runtime/conversations/financebot-macro-economist/${conversationId}/messages`,
    });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { messages: unknown[] }).messages).toEqual([]);

    const missing = await app.inject({
      method: "GET",
      url: "/api/agent-runtime/conversations/no-such-agent/no-such-convo/messages",
    });
    expect(missing.statusCode).toBe(404);

    const noPrompt = await app.inject({
      method: "POST",
      url: `/api/agent-runtime/conversations/financebot-macro-economist/${conversationId}/messages`,
      payload: {},
    });
    expect(noPrompt.statusCode).toBe(400);

    const stop = await app.inject({
      method: "POST",
      url: `/api/agent-runtime/conversations/financebot-macro-economist/${conversationId}/stop`,
    });
    expect(stop.statusCode).toBe(200);
    expect((stop.json() as { ok: boolean; stopped: boolean }).stopped).toBe(false);

    const regenerateEmpty = await app.inject({
      method: "POST",
      url: `/api/agent-runtime/conversations/financebot-macro-economist/${conversationId}/regenerate`,
    });
    expect(regenerateEmpty.statusCode).toBe(404);

    const search = await app.inject({
      method: "GET",
      url: "/api/agent-runtime/conversations/search?agentId=financebot-macro-economist&q=volatility",
    });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { results: unknown[] }).results).toEqual([]);
  });

  it("guards coworker model switching (400/404/403)", async () => {
    const missingModel = await app.inject({
      method: "PATCH",
      url: "/api/agent-runtime/agents/financebot-macro-economist/model",
      payload: {},
    });
    expect(missingModel.statusCode).toBe(400);

    const unknownAgent = await app.inject({
      method: "PATCH",
      url: "/api/agent-runtime/agents/no-such-agent/model",
      payload: { model: "some-model" },
    });
    expect(unknownAgent.statusCode).toBe(404);

    const builtIn = await app.inject({
      method: "PATCH",
      url: "/api/agent-runtime/agents/financebot-macro-economist/model",
      payload: { model: "some-other-model" },
    });
    expect(builtIn.statusCode).toBe(403);
    expect((builtIn.json() as { error: string }).error).toMatch(/built-in/);
  });
});
