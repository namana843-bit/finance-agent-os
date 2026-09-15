import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAICompatDriver } from "../src/llm/openai-compat.js";
import { LlmService } from "../src/llm/llm-service.js";
import {
  UsageTracker,
  estimateTokens,
  priceForModel,
} from "../src/llm/usage.js";

function mkTracker(): UsageTracker {
  return new UsageTracker(mkdtempSync(join(tmpdir(), "usage-test-")));
}

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
  });
  it("returns 0 for empty input", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
  });
});

describe("priceForModel", () => {
  it("prices known models", () => {
    expect(priceForModel("gpt-4o-mini", "openai-compat")).toEqual({
      input: 0.15,
      output: 0.6,
    });
    expect(priceForModel("claude-sonnet-4", "openai-compat")).toEqual({
      input: 3,
      output: 15,
    });
  });
  it("treats free CLI engines as zero cost", () => {
    expect(priceForModel(undefined, "cli", "gemini")).toEqual({ zero: true });
    expect(priceForModel("agent default", "cli", "ollama")).toEqual({
      zero: true,
    });
  });
  it("returns null when no price is known", () => {
    expect(priceForModel("mystery-model-9", "openai-compat")).toBeNull();
    expect(priceForModel(undefined, "cli", "someco-cli")).toBeNull();
  });
});

describe("UsageTracker", () => {
  it("records a turn with reported usage and computed cost", async () => {
    const tracker = mkTracker();
    await tracker.ready;
    const row = await tracker.record("chief", {
      model: "gpt-4o-mini",
      provider: "openai-compat",
      promptChars: 100,
      completionChars: 200,
      usage: { promptTokens: 10, completionTokens: 20 },
    });
    expect(row.turns).toBe(1);
    expect(row.tokens).toBe(30);
    // (10 * 0.15 + 20 * 0.6) / 1e6
    expect(row.costUsd).toBeCloseTo(13.5 / 1_000_000, 12);
  });

  it("estimates tokens and leaves cost unknown when unpriced", async () => {
    const tracker = mkTracker();
    await tracker.ready;
    const row = await tracker.record("quant", {
      model: "mystery-model-9",
      provider: "openai-compat",
      promptChars: 400,
      completionChars: 800,
    });
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(200);
    expect(row.costUsd).toBeNull();
  });

  it("accumulates turns and sums known costs in totals", async () => {
    const tracker = mkTracker();
    await tracker.ready;
    await tracker.record("chief", {
      model: "gpt-4o-mini",
      provider: "openai-compat",
      promptChars: 0,
      completionChars: 0,
      usage: { promptTokens: 1000, completionTokens: 0 },
    });
    await tracker.record("chief", {
      model: "gpt-4o-mini",
      provider: "openai-compat",
      promptChars: 0,
      completionChars: 0,
      usage: { promptTokens: 0, completionTokens: 1000 },
    });
    await tracker.record("echo", {
      model: "unknown",
      provider: "cli",
      command: "echo",
      promptChars: 400,
      completionChars: 400,
    });
    const snap = tracker.snapshot();
    expect(snap.rows.map((r) => r.botId).sort()).toEqual(["chief", "echo"]);
    expect(snap.totals.turns).toBe(3);
    const chief = snap.rows.find((r) => r.botId === "chief");
    expect(chief?.turns).toBe(2);
    // Only chief has a known price, so the total is chief's cost.
    expect(snap.totals.costUsd).toBeCloseTo(chief?.costUsd ?? -1, 12);
  });

  it("totals cost is null when nothing has a known price", async () => {
    const tracker = mkTracker();
    await tracker.ready;
    await tracker.record("echo", {
      provider: "cli",
      command: "echo",
      promptChars: 100,
      completionChars: 100,
    });
    expect(tracker.snapshot().totals.costUsd).toBeNull();
  });

  it("persists across instances in the same data dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-persist-"));
    const first = new UsageTracker(dir);
    await first.ready;
    await first.record("chief", {
      model: "gpt-4o-mini",
      provider: "openai-compat",
      promptChars: 0,
      completionChars: 0,
      usage: { promptTokens: 5, completionTokens: 7 },
    });
    const second = new UsageTracker(dir);
    await second.ready;
    // The first tracker's save is fire-and-forget; poll for the file.
    let snap = second.snapshot();
    const deadline = Date.now() + 2000;
    while (snap.rows.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      const retry = new UsageTracker(dir);
      await retry.ready;
      snap = retry.snapshot();
    }
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]?.turns).toBe(1);
    expect(snap.rows[0]?.tokens).toBe(12);
  });
});

describe("OpenAICompatDriver.completeWithUsage", () => {
  it("parses usage from the response", async () => {
    const driver = new OpenAICompatDriver({
      baseUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4o-mini",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const result = await driver.completeWithUsage("hello");
    expect(result.text).toBe("hi");
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 22 });
  });

  it("omits usage when the response has none", async () => {
    const driver = new OpenAICompatDriver({
      baseUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4o-mini",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
          status: 200,
        })) as typeof fetch,
    });
    const result = await driver.completeWithUsage("hello");
    expect(result.text).toBe("hi");
    expect(result.usage).toBeUndefined();
  });
});

describe("LlmService usage recording", () => {
  const cfg = {
    provider: "openai-compat" as const,
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "USAGE_TEST_KEY",
    model: "gpt-4o-mini",
  };
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { status: 200 },
    )) as typeof fetch;

  it("records settled turns with the bot id", async () => {
    process.env["USAGE_TEST_KEY"] = "test-key";
    const tracker = mkTracker();
    const svc = new LlmService({ fetchImpl, tracker });
    const text = await svc.complete(cfg, "prompt", { botId: "chief" });
    expect(text).toBe("answer");
    const snap = svc.getUsage();
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]?.botId).toBe("chief");
    expect(snap.rows[0]?.tokens).toBe(30);
    delete process.env["USAGE_TEST_KEY"];
  });

  it("records nothing on failure", async () => {
    process.env["USAGE_TEST_KEY"] = "test-key";
    const tracker = mkTracker();
    const svc = new LlmService({
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      tracker,
    });
    await expect(svc.complete(cfg, "prompt", { botId: "chief" })).rejects.toThrow();
    expect(svc.getUsage().rows).toHaveLength(0);
    delete process.env["USAGE_TEST_KEY"];
  });

  it("works without a tracker", async () => {
    process.env["USAGE_TEST_KEY"] = "test-key";
    const svc = new LlmService({ fetchImpl });
    const text = await svc.complete(cfg, "prompt", { botId: "chief" });
    expect(text).toBe("answer");
    expect(svc.getUsage().rows).toHaveLength(0);
    delete process.env["USAGE_TEST_KEY"];
  });
});
