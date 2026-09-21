import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "@finance/core";
import type { ChatRequest, LLMEvent, LLMMessage } from "@finance/shared";
import {
  AgentRuntime,
  CliProvider,
  EngineManager,
  FinanceToolRegistry,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  ProviderRegistry,
} from "../src/llm/index.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import { RiskAgent } from "../src/agents/risk/index.js";
import { PaperBroker } from "../src/broker/paper-broker.js";

describe("Phase 4 — LLM Provider & Engine Layer Test Suite", () => {
  // -------------------------------------------------------------------------
  // 1. Provider Registry Tests
  // -------------------------------------------------------------------------
  describe("ProviderRegistry", () => {
    it("should register default providers on instantiation", () => {
      const registry = new ProviderRegistry();
      expect(registry.has("openai")).toBe(true);
      expect(registry.has("ollama")).toBe(true);
      expect(registry.has("openai-compatible")).toBe(true);
      expect(registry.has("cli-opencode")).toBe(true);
    });

    it("should allow registering custom providers and listing them", () => {
      const registry = new ProviderRegistry();
      const customProvider = new OpenAICompatibleProvider({
        providerId: "local-vllm",
        providerName: "Local vLLM",
        baseUrl: "http://127.0.0.1:8000/v1",
      });

      registry.register(customProvider);
      expect(registry.has("local-vllm")).toBe(true);
      expect(registry.get("local-vllm")?.name).toBe("Local vLLM");
      expect(registry.list().some((p) => p.id === "local-vllm")).toBe(true);
    });

    it("should return undefined for unknown provider and handle unregister", () => {
      const registry = new ProviderRegistry();
      expect(registry.get("unknown-provider")).toBeUndefined();
      expect(registry.unregister("unknown-provider")).toBe(false);
      expect(registry.unregister("openai")).toBe(true);
      expect(registry.has("openai")).toBe(false);
    });

    it("should return provider health check results", async () => {
      const registry = new ProviderRegistry();
      const health = await registry.getHealth();
      expect(health.openai).toBeDefined();
      expect(health.ollama).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 2. OpenAI & OpenAI-Compatible Provider Tests
  // -------------------------------------------------------------------------
  describe("OpenAI & OpenAI-Compatible Providers", () => {
    it("should stream text_delta and message_complete events using mock fetch", async () => {
      const mockResponseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
          );
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockResponseBody,
      } as unknown as Response);

      const provider = new OpenAIProvider({
        apiKey: "test-key",
        fetchImpl: mockFetch,
      });

      const events: LLMEvent[] = [];
      const req: ChatRequest = { messages: [{ role: "user", content: "Hi" }] };

      for await (const ev of provider.chat(req)) {
        events.push(ev);
      }

      expect(events[0]?.type).toBe("message_start");
      expect(events.some((e) => e.type === "text_delta" && e.delta === "Hello")).toBe(true);
      expect(events.some((e) => e.type === "text_delta" && e.delta === " World")).toBe(true);
      const last = events[events.length - 1];
      expect(last?.type).toBe("message_complete");
      if (last?.type === "message_complete") {
        expect(last.text).toBe("Hello World");
      }
    });

    it("should normalize API error response into error event", async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized API Key"),
      } as unknown as Response);

      const provider = new OpenAIProvider({
        apiKey: "invalid-key",
        fetchImpl: mockFetch,
      });

      const events: LLMEvent[] = [];
      for await (const ev of provider.chat({ messages: [{ role: "user", content: "Hi" }] })) {
        events.push(ev);
      }

      expect(events.some((e) => e.type === "error" && e.error.includes("401"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Ollama Local Provider Tests
  // -------------------------------------------------------------------------
  describe("OllamaProvider", () => {
    it("should handle graceful error when Ollama is offline", async () => {
      const mockFetch: typeof fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:11434"));
      const provider = new OllamaProvider({ fetchImpl: mockFetch });

      const health = await provider.healthCheck();
      expect(health.status).toBe("unreachable");
      expect(health.message).toContain("Ollama is not running");

      const events: LLMEvent[] = [];
      for await (const ev of provider.chat({ messages: [{ role: "user", content: "test" }] })) {
        events.push(ev);
      }
      expect(events.some((e) => e.type === "error" && e.error.includes("unavailable"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. CLI Engine Driver Tests
  // -------------------------------------------------------------------------
  describe("CliProvider", () => {
    it("should handle missing executable gracefully with user-readable error", async () => {
      const cli = new CliProvider({
        command: "non_existent_binary_xyz_12345",
      });

      const health = await cli.healthCheck();
      expect(health.status).toBe("unreachable");

      const events: LLMEvent[] = [];
      for await (const ev of cli.chat({ messages: [{ role: "user", content: "hi" }] })) {
        events.push(ev);
      }

      expect(events.some((e) => e.type === "error" && e.error.includes("not found"))).toBe(true);
    });

    it("should execute mock spawn implementation and normalize stdout text", async () => {
      const mockSpawn = vi.fn().mockResolvedValue({
        stdout: "CLI Assistant Output Result",
        stderr: "",
        code: 0,
      });

      const cli = new CliProvider({
        command: "opencode",
        args: ["run", "{prompt}"],
        spawnImpl: mockSpawn,
      });

      const events: LLMEvent[] = [];
      for await (const ev of cli.chat({ messages: [{ role: "user", content: "analyze btc" }] })) {
        events.push(ev);
      }

      expect(events[0]?.type).toBe("message_start");
      expect(events.some((e) => e.type === "text_delta" && e.delta === "CLI Assistant Output Result")).toBe(true);
      expect(events.some((e) => e.type === "message_complete")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Finance Tool Registry & Safety Trade Proposal Integration
  // -------------------------------------------------------------------------
  describe("FinanceToolRegistry & Safety Pipeline", () => {
    it("should execute registered indicators and market data tools", async () => {
      const registry = new FinanceToolRegistry();
      const rsiRes = await registry.executeTool("calculate_rsi", {
        prices: [10, 12, 11, 13, 14, 15, 14, 16, 17, 18, 19, 20, 21, 22, 23],
        period: 14,
      }) as { rsi: number };

      expect(typeof rsiRes.rsi).toBe("number");
      expect(rsiRes.rsi).toBeGreaterThan(0);

      const priceRes = await registry.executeTool("get_market_price", { symbol: "BTCUSDT" }) as { symbol: string; price: number };
      expect(priceRes.symbol).toBe("BTCUSDT");
      expect(priceRes.price).toBeGreaterThan(0);
    });

    it("should enforce ExecutionPipeline and RiskEngine on create_trade_proposal", async () => {
      const bus = new TypedEventBus();
      const riskAgent = new RiskAgent(bus);
      const paperBroker = new PaperBroker(bus);
      const pipeline = new ExecutionPipeline({
        bus,
        riskAgent,
        paperBroker,
      });

      const registry = new FinanceToolRegistry({ pipeline });

      // 1. Submit valid trade proposal
      const proposalRes = await registry.executeTool("create_trade_proposal", {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.01,
        reason: "RSI oversold crossover",
      }) as { status: string; decision: string };

      expect(proposalRes.decision).toBe("APPROVED");
      expect(proposalRes.status).toBe("EXECUTED");

      // 2. Submit trade proposal violating risk parameters (huge order size exceeding max limits)
      const hugeProposalRes = await registry.executeTool("create_trade_proposal", {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 999999999,
        reason: "YOLO trade",
      }) as { status: string; decision: string; reason?: string };

      expect(hugeProposalRes.decision).toBe("REJECTED");
      expect(hugeProposalRes.status).toBe("REJECTED");
      expect(hugeProposalRes.reason).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Agent Runtime Tests
  // -------------------------------------------------------------------------
  describe("AgentRuntime", () => {
    it("should orchestrate multi-turn tool calling loop and yield normalized LLMEvents", async () => {
      const providerRegistry = new ProviderRegistry();

      // Register mock OpenAI provider that returns a tool call on turn 1, and final text on turn 2
      let callCount = 0;
      const mockProvider = {
        id: "mock-llm",
        name: "Mock LLM",
        supportsTools: () => true,
        healthCheck: async () => ({ providerId: "mock-llm", status: "ok" as const }),
        listModels: async () => [{ id: "mock-model", name: "Mock Model", provider: "mock-llm" }],
        chat: async function* () {
          callCount++;
          const messageId = `msg-turn-${callCount}`;
          yield { type: "message_start" as const, messageId, model: "mock-model", timestamp: Date.now() };

          if (callCount === 1) {
            yield {
              type: "tool_call" as const,
              messageId,
              toolCallId: "call_123",
              name: "get_market_price",
              arguments: { symbol: "BTCUSDT" },
              timestamp: Date.now(),
            };
            yield { type: "message_complete" as const, messageId, text: "", timestamp: Date.now() };
          } else {
            yield {
              type: "text_delta" as const,
              messageId,
              delta: "BTC price is 68,500. Recommend holding position.",
              timestamp: Date.now(),
            };
            yield {
              type: "message_complete" as const,
              messageId,
              text: "BTC price is 68,500. Recommend holding position.",
              timestamp: Date.now(),
            };
          }
        },
      };

      providerRegistry.register(mockProvider);
      const engineManager = new EngineManager(providerRegistry);
      const toolRegistry = new FinanceToolRegistry();
      const agentRuntime = new AgentRuntime({ engineManager, toolRegistry });

      agentRuntime.registerAgent({
        id: "test-agent",
        name: "Test Agent",
        engine: "mock-llm",
        tools: ["get_market_price"],
      });

      const events: LLMEvent[] = [];
      for await (const ev of agentRuntime.runAgentStream("test-agent", "What is BTC price?")) {
        events.push(ev);
      }

      // Verify tool call was emitted
      expect(events.some((e) => e.type === "tool_call" && e.name === "get_market_price")).toBe(true);
      // Verify tool result was emitted
      expect(events.some((e) => e.type === "tool_result" && e.name === "get_market_price")).toBe(true);
      // Verify final text response was emitted after tool execution
      expect(events.some((e) => e.type === "text_delta" && e.delta.includes("BTC price is 68,500"))).toBe(true);
    });
  });
});
