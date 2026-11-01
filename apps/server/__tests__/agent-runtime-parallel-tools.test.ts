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
    
    // Each tool takes 100ms. Track starts/ends so concurrency is proven
    // by real overlap, not a wall-clock upper bound (flaky on loaded CI runners).
    const starts: number[] = [];
    const ends: number[] = [];
    const instrumented = (id: number) => {
      toolRegistry.registerTool({
        name: `slow_tool_${id}`,
        description: `slow ${id}`,
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const t0 = Date.now();
          await new Promise((r) => setTimeout(r, 100));
          starts.push(t0);
          ends.push(Date.now());
          return { tool: id, ok: true };
        },
      });
    };
    instrumented(1);
    instrumented(2);
    instrumented(3);

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

    const stream = runtime.runAgentStream("parallel-test-agent", "run all tools");

    const events: LLMEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
    }

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(3);

    // Concurrency proof: at least two tool executions overlapped in time.
    // If serial, the i-th start is >= the (i-1)-th end and overlap is impossible.
    const maxConcurrent = (() => {
      let count = 0;
      let peak = 0;
      const marks = [
        ...starts.map((t) => ({ t, d: 1 })),
        ...ends.map((t) => ({ t, d: -1 })),
      ].sort((a, b) => a.t - b.t || a.d - b.d);
      for (const mark of marks) {
        count += mark.d;
        peak = Math.max(peak, count);
      }
      return peak;
    })();
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);

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
