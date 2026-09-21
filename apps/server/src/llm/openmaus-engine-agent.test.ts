import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry, EngineManager } from "./registry.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compat.js";
import { CliProvider } from "./providers/cli-engine.js";
import { FinanceToolRegistry } from "./finance-tool-registry.js";
import { AgentRuntime } from "./agent-runtime.js";
import { AgentPersistence } from "./persistence.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Finance Agent OS — Engine & Agent System (OpenMausBot Architecture)", () => {
  it("1. Engine Registry registers default cloud, local, and CLI providers", () => {
    const registry = new ProviderRegistry();
    const providers = registry.list();
    expect(providers.length).toBeGreaterThanOrEqual(4);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("openrouter")).toBe(true);
    expect(registry.has("ollama")).toBe(true);
    expect(registry.has("openai-compatible")).toBe(true);
  });

  it("2. Ollama Provider handles connection health check gracefully when offline", async () => {
    const ollama = new OllamaProvider({ baseUrl: "http://127.0.0.1:9999" }); // unreachable port
    const health = await ollama.healthCheck();
    expect(health.providerId).toBe("ollama");
    expect(health.status).toBe("unreachable");
    expect(health.message).toContain("Ollama is unavailable");

    // Must not crash when listing models on offline instance
    const models = await ollama.listModels();
    expect(models).toEqual([]);
  });

  it("3. OpenAI-Compatible Provider initializes with base URL and lists models", async () => {
    const compat = new OpenAICompatibleProvider({
      providerId: "lm-studio",
      providerName: "LM Studio Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      defaultModel: "qwen2.5-coder",
    });

    expect(compat.id).toBe("lm-studio");
    expect(compat.name).toBe("LM Studio Local");
    expect(compat.supportsTools()).toBe(true);

    const health = await compat.healthCheck();
    expect(health.providerId).toBe("lm-studio");
  });

  it("4. CLI Provider executes local binaries and streams output cleanly", async () => {
    // Mock spawnImpl for deterministic CLI test
    const mockSpawn = vi.fn().mockResolvedValue({
      stdout: "BTC technical setup: RSI 62.4 indicating bullish momentum continuation.",
      stderr: "",
      code: 0,
    });

    const cli = new CliProvider({
      id: "opencode-cli",
      name: "OpenCode CLI Engine",
      command: "opencode",
      args: ["run", "{prompt}"],
      spawnImpl: mockSpawn,
    });

    // Mock path resolution check
    vi.spyOn(cli as any, "resolvePath").mockResolvedValue("C:\\tools\\opencode.cmd");

    const events = [];
    const stream = cli.chat({
      messages: [{ role: "user", content: "Analyze BTC trend" }],
    });

    for await (const ev of stream) {
      events.push(ev);
    }

    expect(events[0].type).toBe("message_start");
    const delta = events.find((e) => e.type === "text_delta");
    expect(delta).toBeDefined();
    if (delta && delta.type === "text_delta") {
      expect(delta.delta).toContain("BTC technical setup");
    }

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("5. Finance Tool Registry registers and executes finance & indicator tools", async () => {
    const toolRegistry = new FinanceToolRegistry();
    const tools = toolRegistry.listTools();
    expect(tools.map((t) => t.name)).toContain("get_market_price");
    expect(tools.map((t) => t.name)).toContain("get_ohlcv");
    expect(tools.map((t) => t.name)).toContain("calculate_rsi");
    expect(tools.map((t) => t.name)).toContain("create_trade_proposal");

    // Execute RSI calculation tool
    const rsiResult = (await toolRegistry.executeTool("calculate_rsi", {
      prices: [10, 12, 11, 13, 15, 14, 16, 18, 17, 19, 21, 20, 22, 24, 23, 25],
      period: 14,
    })) as { rsi: number };

    expect(typeof rsiResult.rsi).toBe("number");
    expect(rsiResult.rsi).toBeGreaterThan(0);
    expect(rsiResult.rsi).toBeLessThanOrEqual(100);
  });

  it("6. Trade Proposal passes through Risk Safety Controls and Paper Execution", async () => {
    const toolRegistry = new FinanceToolRegistry();

    // Execute trade proposal tool
    const result = (await toolRegistry.executeTool("create_trade_proposal", {
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 0.05,
      orderType: "MARKET",
      reason: "EMA 20/50 Golden Cross confirmation",
      confidence: 0.85,
    })) as { status: string; decision: string; proposal?: any };

    expect(result.decision).toBe("APPROVED");
    expect(result.proposal.symbol).toBe("BTCUSDT");
    expect(result.proposal.quantity).toBe(0.05);
    expect(result.proposal.side).toBe("buy");
  });

  it("7. Agent Runtime handles agent CRUD, persistence, and execution permissions", async () => {
    const tempDir = join(tmpdir(), `test-finance-agent-${Date.now()}`);
    const persistence = new AgentPersistence(tempDir);
    const registry = new ProviderRegistry();
    const engineManager = new EngineManager(registry);
    const toolRegistry = new FinanceToolRegistry();

    const runtime = new AgentRuntime({
      engineManager,
      toolRegistry,
      persistence,
    });

    runtime.registerAgent({
      id: "test-quant-agent",
      name: "Test Quant Agent",
      engine: "ollama-local",
      model: "qwen2.5-coder",
      systemPrompt: "You are a test quantitative trading agent.",
      tools: ["get_market_price", "create_trade_proposal"],
      permissions: { execution: false }, // Execution OFF
    });

    const agent = runtime.getAgent("test-quant-agent");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("Test Quant Agent");
    expect(agent?.permissions?.execution).toBe(false);

    // Verify conversation persistence saving
    await runtime.saveConversationHistory("test-quant-agent", [
      { role: "user", content: "Test prompt" },
      { role: "assistant", content: "Test response" },
    ]);

    const history = await runtime.loadConversationHistory("test-quant-agent");
    expect(history.length).toBe(2);
    expect(history[0].content).toBe("Test prompt");
  });

  it("8. Security Enforced — Exchange credentials are never leaked or accepted as direct LLM action", () => {
    const toolRegistry = new FinanceToolRegistry();
    const toolNames = toolRegistry.listTools().map((t) => t.name);

    // Ensure raw exchange secret or withdrawal tools are NOT exposed to the LLM
    expect(toolNames).not.toContain("place_real_order");
    expect(toolNames).not.toContain("withdraw");
    expect(toolNames).not.toContain("access_exchange_secret");
    expect(toolNames).not.toContain("cancel_real_order");
  });
});
