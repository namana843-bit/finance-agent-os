import { describe, it, expect, vi } from "vitest";
import { AgentRuntime } from "../src/llm/agent-runtime.js";
import { ProviderRegistry, EngineManager } from "../src/llm/registry.js";
import { FinanceToolRegistry } from "../src/llm/finance-tool-registry.js";
import type { LLMProvider, LLMProviderOptions } from "../src/llm/provider.js";
import type { ChatRequest, LLMEvent, ModelInfo, ProviderHealth } from "@finance/shared";

class MockMultiToolProvider implements LLMProvider {
  readonly id = "mock-multi-tool";
  readonly name = "Mock Multi Tool";
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

  async *chat(request: ChatRequest, opts?: LLMProviderOptions): AsyncIterable<LLMEvent> {
    const messageId = `msg-${Date.now()}`;
    yield { type: "message_start", messageId, model: "mock", timestamp: Date.now() };

    this.turn++;
    if (this.turn === 1) {
      // Return 3 tool calls simultaneously
      yield {
        type: "tool_call",
        messageId,
        toolCallId: "call-1",
        name: "slow_tool_1",
        arguments: {},
        timestamp: Date.now(),
      };
      yield {
        type: "tool_call",
        messageId,
        toolCallId: "call-2",
        name: "slow_tool_2",
        arguments: {},
        timestamp: Date.now(),
      };
      yield {
        type: "tool_call",
        messageId,
        toolCallId: "call-3",
        name: "slow_tool_3",
        arguments: {},
        timestamp: Date.now(),
      };
    } else {
      yield {
        type: "text_delta",
        messageId,
        delta: "All tools completed in parallel.",
        timestamp: Date.now(),
      };
      yield {
        type: "message_complete",
        messageId,
        text: "All tools completed in parallel.",
        timestamp: Date.now(),
      };
    }
  }
}

describe("AgentRuntime — Parallel Tool Execution via Promise.all", () => {
  it("executes multiple tool calls concurrently rather than serially", async () => {
    const registry = new ProviderRegistry();
    const provider = new MockMultiToolProvider();
    registry.register(provider);

    const engineManager = new EngineManager(registry);
    engineManager.setEngineConfig("mock-engine", {
      type: "cli",
      provider: "mock-multi-tool",
      name: "Mock Engine",
      command: "mock",
    });

    const toolRegistry = new FinanceToolRegistry();
    
    // Each tool takes 100ms
    toolRegistry.registerTool({
      name: "slow_tool_1",
      description: "slow 1",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { tool: 1, ok: true };
      },
    });
    toolRegistry.registerTool({
      name: "slow_tool_2",
      description: "slow 2",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { tool: 2, ok: true };
      },
    });
    toolRegistry.registerTool({
      name: "slow_tool_3",
      description: "slow 3",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { tool: 3, ok: true };
      },
    });

    const runtime = new AgentRuntime({
      engineManager,
      toolRegistry,
    });

    runtime.registerAgent({
      id: "parallel-test-agent",
      name: "Parallel Test Agent",
      engine: "mock-engine",
      tools: ["slow_tool_1", "slow_tool_2", "slow_tool_3"],
      permissions: { execution: true },
    });

    const start = Date.now();
    const stream = runtime.runAgentStream("parallel-test-agent", "run all tools");

    const events: LLMEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
    }
    const elapsed = Date.now() - start;

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(3);

    // If serial, 3 x 100ms = 300ms+. In parallel, ~100ms - 220ms.
    expect(elapsed).toBeLessThan(280);

    const messageComplete = events.find((e) => e.type === "message_complete");
    expect(messageComplete).toBeDefined();
    expect((messageComplete as any).text).toBe("All tools completed in parallel.");
  });

  it("isolates errors so a failed tool does not abort concurrent siblings", async () => {
    const registry = new ProviderRegistry();
    const provider = new MockMultiToolProvider();
    registry.register(provider);

    const engineManager = new EngineManager(registry);
    engineManager.setEngineConfig("mock-engine", {
      type: "cli",
      provider: "mock-multi-tool",
      name: "Mock Engine",
      command: "mock",
    });

    const toolRegistry = new FinanceToolRegistry();
    toolRegistry.registerTool({
      name: "slow_tool_1",
      description: "fails",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("Tool 1 simulated explosion");
      },
    });
    toolRegistry.registerTool({
      name: "slow_tool_2",
      description: "succeeds",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return { tool: 2, status: "success" };
      },
    });
    toolRegistry.registerTool({
      name: "slow_tool_3",
      description: "succeeds",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return { tool: 3, status: "success" };
      },
    });

    const runtime = new AgentRuntime({
      engineManager,
      toolRegistry,
    });

    runtime.registerAgent({
      id: "parallel-error-agent",
      name: "Parallel Error Agent",
      engine: "mock-engine",
      tools: ["slow_tool_1", "slow_tool_2", "slow_tool_3"],
      permissions: { execution: true },
    });

    const stream = runtime.runAgentStream("parallel-error-agent", "run all tools");
    const events: LLMEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
    }

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(3);

    const failed = toolResults.find((e: any) => e.toolCallId === "call-1") as any;
    expect(failed.isError).toBe(true);
    expect(failed.result.error).toContain("Tool 1 simulated explosion");

    const passed2 = toolResults.find((e: any) => e.toolCallId === "call-2") as any;
    expect(passed2.isError).toBe(false);
    expect(passed2.result.status).toBe("success");

    const passed3 = toolResults.find((e: any) => e.toolCallId === "call-3") as any;
    expect(passed3.isError).toBe(false);
    expect(passed3.result.status).toBe("success");
  });
});
