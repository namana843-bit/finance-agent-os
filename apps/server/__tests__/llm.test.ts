// ============================================================================
// LLM module — OpenAICompatDriver, LlmService, LlmServiceWrapper + ChatCore fallback
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { TypedEventBus } from "@finance/core";
import { ChatCore } from "../src/chat/chat-service.js";
import { Storage } from "../src/core/storage.js";
import { OpenAICompatDriver } from "../src/llm/openai-compat.js";
import { LlmService } from "../src/llm/llm-service.js";
import { LlmServiceWrapper } from "../src/llm/service.js";
import type { LlmConfig } from "../src/llm/types.js";

let bus: TypedEventBus;

beforeEach(() => {
  bus = new TypedEventBus();
});

async function makeStorage(): Promise<Storage> {
  const dir = await mkdtemp(join(tmpdir(), "llm-test-"));
  return new Storage(dir);
}

function testCfg(apiKeyEnv = "LLM_TEST_KEY_ZZZ"): LlmConfig {
  return {
    provider: "openai-compat",
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv,
    model: "test-model",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// 1. OpenAICompatDriver.complete
// ---------------------------------------------------------------------------

describe("OpenAICompatDriver.complete", () => {
  it("POSTs correct URL/body/auth and returns content", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return jsonResponse({
        choices: [{ message: { content: "hello-llm" } }],
      });
    }) as typeof fetch;

    const cfg = testCfg("LLM_DRIVER_OK_KEY");
    const driver = new OpenAICompatDriver({
      baseUrl: cfg.baseUrl,
      apiKey: "sk-test-123",
      model: cfg.model,
      fetchImpl,
    });
    const out = await driver.complete("say hi");
    expect(out).toBe("hello-llm");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.endsWith("/chat/completions")).toBe(true);
    expect(seen[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe(cfg.model);
    expect(JSON.stringify(body["messages"])).toContain("say hi");
    const headers = (seen[0]!.init.headers ?? {}) as Record<string, string>;
    const auth =
      headers["authorization"] ?? headers["Authorization"] ?? JSON.stringify(headers);
    expect(String(auth)).toContain("sk-test-123");
  });

  it("throws on !ok with status in message", async () => {
    const fetchImpl = (async () =>
      new Response("server blew up", { status: 500 })) as typeof fetch;
    const driver = new OpenAICompatDriver({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      model: "m",
      fetchImpl,
    });
    await expect(driver.complete("hi")).rejects.toThrow(/500/);
  });

  it("throws on empty choices", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [] })) as typeof fetch;
    const driver = new OpenAICompatDriver({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      model: "m",
      fetchImpl,
    });
    await expect(driver.complete("hi")).rejects.toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// 2. LlmService — env gating + delegation + isConfigured
// ---------------------------------------------------------------------------

describe("LlmService", () => {
  it("isConfigured true/false based on env presence", () => {
    const svc = new LlmService();
    const cfg = testCfg("LLM_CFG_PRESENT_KEY");
    delete process.env[cfg.apiKeyEnv];
    expect(svc.isConfigured(cfg)).toBe(false);
    process.env[cfg.apiKeyEnv] = "sk-1";
    try {
      expect(svc.isConfigured(cfg)).toBe(true);
    } finally {
      delete process.env[cfg.apiKeyEnv];
    }
  });

  it("complete throws `LLM key missing` when env var absent", async () => {
    const svc = new LlmService();
    const cfg = testCfg("LLM_ABSENT_KEY_12345");
    delete process.env[cfg.apiKeyEnv];
    await expect(svc.complete(cfg, "hi")).rejects.toThrow("LLM key missing");
  });

  it("complete delegates when key present", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ choices: [{ message: { content: "delegated-ok" } }] })) as typeof fetch;
    const svc = new LlmService({ fetchImpl });
    const cfg = testCfg("LLM_DELEGATE_KEY");
    process.env[cfg.apiKeyEnv] = "sk-delegate";
    try {
      const out = await svc.complete(cfg, "hello");
      expect(out).toBe("delegated-ok");
    } finally {
      delete process.env[cfg.apiKeyEnv];
    }
  });
});

// ---------------------------------------------------------------------------
// 3. LlmServiceWrapper lifecycle
// ---------------------------------------------------------------------------

describe("LlmServiceWrapper lifecycle", () => {
  it("initialize/start/stop/getHealth/getInstance", async () => {
    const wrapper = new LlmServiceWrapper();
    const before = wrapper.getInstance();
    expect(before).toBeInstanceOf(LlmService);
    await wrapper.initialize();
    await wrapper.start();
    expect(wrapper.getHealth()).toBeDefined();
    expect(wrapper.getHealth().id).toBe("llm");
    const instance = wrapper.getInstance();
    expect(instance).toBe(before);
    expect(typeof instance.complete).toBe("function");
    expect(typeof instance.isConfigured).toBe("function");
    await wrapper.stop();
    expect(wrapper.getHealth().status).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// 4. ChatCore LLM fallback — rejecting service keeps existing behavior
// ---------------------------------------------------------------------------

describe("ChatCore LLM fallback", () => {
  it("bot with llm config whose service.complete rejects -> still resolves with planId (no throw)", async () => {
    const storage = await makeStorage();
    const rejectingService = {
      isConfigured: () => true,
      complete: async () => {
        throw new Error("llm down");
      },
    };
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async () => ({ planId: "plan-fallback-1" }),
      getLlm: () => rejectingService,
    } as unknown as ConstructorParameters<typeof ChatCore>[0]);

    const thread = await core.createThread({ title: "fallback", botId: "quant" });
    // BotConfig.llm is parallel-owned; inject via cast.
    const bot = core.bots.get("quant") as unknown as Record<string, unknown>;
    bot["llm"] = {
      provider: "openai-compat",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnv: "LLM_FALLBACK_TEST_KEY",
      model: "test-model",
    };

    const { message, planId } = await core.sendUserMessage(thread.id, "Analyze BTC");
    expect(planId).toBe("plan-fallback-1");
    expect(message.content).toBe("Analyze BTC");

    // Standard behavior preserved: user message persisted, no throw.
    const messages = await core.getMessages(thread.id);
    expect(
      messages.some((m) => m.role === "user" && m.content === "Analyze BTC"),
    ).toBe(true);
  });

  it("resolving service saves the LLM reply as assistant message", async () => {
    const storage = await makeStorage();
    const resolvingService = {
      isConfigured: () => true,
      complete: async (_cfg: unknown, prompt: string) => `reply-to:${prompt.slice(0, 20)}`,
    };
    const core = new ChatCore({
      bus,
      storage,
      submitTask: async () => ({ planId: "plan-ok-1" }),
      getLlm: () => resolvingService,
    } as unknown as ConstructorParameters<typeof ChatCore>[0]);

    const thread = await core.createThread({ title: "ok", botId: "quant" });
    const bot = core.bots.get("quant") as unknown as Record<string, unknown>;
    bot["llm"] = {
      provider: "openai-compat",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnv: "LLM_OK_TEST_KEY",
      model: "test-model",
    };

    const { planId } = await core.sendUserMessage(thread.id, "Hello quant");
    expect(planId).toBe("plan-ok-1");
    const messages = await core.getMessages(thread.id);
    const llmMsg = messages.find(
      (m) => m.role === "assistant" && m.agentId === "quant" && m.content.startsWith("reply-to:"),
    );
    expect(llmMsg).toBeDefined();
  });
});
