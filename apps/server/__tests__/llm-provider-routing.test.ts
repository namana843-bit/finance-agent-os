// ============================================================================
// LLM provider routing — engine ID → provider → CLI adapter integration.
// Uses the real ProviderRegistry/EngineManager/CliManager wiring with mocked
// providers and sessions; only the node executable is spawned for real.
// ============================================================================

import { describe, it, expect } from "vitest";
import { ProviderRegistry, EngineManager } from "../src/llm/registry.js";
import { CliProvider } from "../src/llm/providers/cli-engine.js";
import { CliManager } from "../src/cli/cli-manager.js";
import { createCustomCliAdapter } from "../src/cli/index.js";
import type { ChatRequest, LLMEvent } from "@finance/shared";

function chatRequest(text: string): ChatRequest {
  return { model: "test", messages: [{ role: "user", content: text }] };
}

async function collectEvents(
  provider: { chat: (req: ChatRequest, opts?: any) => AsyncIterable<LLMEvent> },
  req: ChatRequest,
  opts?: any,
): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.chat(req, opts)) {
    events.push(event);
  }
  return events;
}

function freshStack(): { registry: ProviderRegistry; manager: EngineManager } {
  const registry = new ProviderRegistry();
  const manager = new EngineManager(registry);
  return { registry, manager };
}

describe("engine → provider → adapter routing", () => {
  it("routes claude/codex/gemini/opencode engines to their adapter providers", async () => {
    const { manager } = freshStack();
    for (const [engine, providerId] of [
      ["claude", "cli-claude"],
      ["codex", "cli-codex"],
      ["gemini", "cli-gemini"],
      ["opencode", "cli-opencode"],
    ] as Array<[string, string]>) {
      const { provider } = await manager.getProviderForEngine(engine);
      expect(provider.id).toBe(providerId);
    }
  });

  it("preserves API providers (openai, ollama)", async () => {
    const { manager } = freshStack();
    expect((await manager.getProviderForEngine("openai-gpt4")).provider.id).toBe("openai");
    expect((await manager.getProviderForEngine("ollama-local")).provider.id).toBe("ollama");
  });

  it("rejects dangling API engine configs explicitly instead of running a CLI", async () => {
    const { manager } = freshStack();
    // openrouter-claude names provider "openrouter", which is not registered.
    await expect(manager.getProviderForEngine("openrouter-claude")).rejects.toThrow(
      /needs API provider 'openrouter'/,
    );
  });

  it("resolves catalog ids without adapters to a CLI provider (missing executable surfaces at chat time)", async () => {
    const { manager } = freshStack();
    // NB: no chat spawn here — some catalog CLIs (e.g. kilocode) may be
    // installed and would block on auth; the missing-executable path is
    // covered by the definitely-missing-cli test below.
    const { provider } = await manager.getProviderForEngine("gencode");
    expect(provider.id).toBe("gencode");
  });

  it("throws for completely unknown engine ids", async () => {
    const { manager } = freshStack();
    await expect(manager.getProviderForEngine("nope-unknown-xyz")).rejects.toThrow(
      /No provider registered for engine/,
    );
  });

  it("fails explicitly for rpc-transport adapters instead of running argv", async () => {
    const cliManager = new CliManager();
    cliManager.register(
      createCustomCliAdapter({
        id: "rpc-stub",
        name: "RPC Stub",
        executablePath: "rpc-cli-stub",
        taskDelivery: "rpc",
      }),
    );
    const provider = new CliProvider({ command: "rpc-cli-stub", cliManager });
    const events = await collectEvents(provider, chatRequest("hi"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error).toMatch(/RPC transport which is not implemented/);
    }
  });

  it("delivers tasks via stdin for stdin adapters (real node spawn)", async () => {
    const cliManager = new CliManager();
    cliManager.register(
      createCustomCliAdapter({
        id: "stdin-stub",
        name: "Stdin Stub",
        executablePath: "node",
        args: ["-e", "process.stdin.on('data',d=>process.stdout.write('echo:'+d))"],
        taskDelivery: "stdin",
        engineAliases: ["stdin-stub"],
      }),
    );
    const provider = new CliProvider({
      command: "node",
      args: ["-e", "process.stdin.on('data',d=>process.stdout.write('echo:'+d))"],
      cliManager,
    });
    const events = await collectEvents(provider, chatRequest("hello-stdin"));
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""))
      .join("");
    expect(text).toContain("hello-stdin");
  });

  it("streams deltas and tool calls through provider normalization (mocked session)", async () => {
    const fakeSession = {
      sendPrompt: async function* () {
        yield { type: "delta", content: "part1 " };
        yield { type: "tool_call", toolCall: { name: "get_price", arguments: { symbol: "BTC" } } };
        yield { type: "delta", content: "part2" };
      },
    };
    const fakeSessionManager = {
      getOrCreateSession: async () => fakeSession,
    };
    const provider = new CliProvider({
      command: "node",
      args: ["-e", "x"],
      spawnImpl: (async () => ({ stdout: "unused", stderr: "", code: 0 })) as any,
      sessionManager: fakeSessionManager as any,
    });
    const events = await collectEvents(provider, chatRequest("hi"));
    expect(events[0]?.type).toBe("message_start");
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2);
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool?.type).toBe("tool_call");
    if (tool?.type === "tool_call") {
      expect(tool.name).toBe("get_price");
      expect(tool.arguments).toEqual({ symbol: "BTC" });
    }
    expect(events.at(-1)?.type).toBe("message_complete");
  });

  it("surfaces spawn failures as error events, not exceptions", async () => {
    const provider = new CliProvider({
      command: "definitely-missing-cli-xyz",
      args: ["{prompt}"],
    });
    const events = await collectEvents(provider, chatRequest("hi"));
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.error).toMatch(/not found/);
    }
  });

  it("honours cancellation via AbortSignal (real node sleep)", async () => {
    const provider = new CliProvider({
      command: "node",
      args: ["-e", "setTimeout(()=>process.stdout.write('late'),30000)"],
      timeoutMs: 20000,
    });
    const ctrl = new AbortController();
    const pending = collectEvents(provider, chatRequest("hi"), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 500);
    const events = await pending;
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
  }, 15000);
});
