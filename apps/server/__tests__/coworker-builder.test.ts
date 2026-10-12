import { describe, expect, it } from "vitest";
import {
  COWORKER_TEMPLATES,
  buildCoworkerSystemPrompt,
  hasSafetyRails,
  templateSystemPrompt,
  withSafetyRails,
} from "../src/coworkers/coworker-templates.js";
import { validateCoworkerInput } from "../src/coworkers/coworker-validation.js";

const VALID_TOOLS = [
  "get_market_price",
  "get_ohlcv",
  "calculate_rsi",
  "calculate_macd",
  "calculate_supertrend",
  "get_portfolio",
  "create_trade_proposal",
];

const deps = {
  engineExists: (id: string) => ["opencode-cli", "ollama-local", "openai-gpt4"].includes(id),
  validTools: VALID_TOOLS,
};

const goodPrompt =
  "You analyze BTC momentum on the 4h timeframe and draft proposals with entry, stop-loss, and confidence.";

describe("coworker templates", () => {
  it("ships at least 4 production templates with safe defaults", () => {
    expect(COWORKER_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of COWORKER_TEMPLATES) {
      expect(t.key).toMatch(/^[a-z0-9-]+$/);
      expect(t.tools.length).toBeGreaterThan(0);
      for (const tool of t.tools) {
        expect(VALID_TOOLS).toContain(tool);
      }
      // Trade proposers must hold the proposal tool + execution permission.
      if (t.riskPermissions.allowTradeProposals) {
        expect(t.tools).toContain("create_trade_proposal");
        expect(t.permissions.execution).toBe(true);
      }
    }
  });

  it("every template prompt carries the non-negotiable safety rails", () => {
    for (const t of COWORKER_TEMPLATES) {
      const prompt = templateSystemPrompt(t);
      expect(hasSafetyRails(prompt)).toBe(true);
      expect(prompt).toMatch(/Paper trading only/);
      expect(prompt).toMatch(/Never bypass risk limits/);
      expect(prompt).toMatch(/Never invent market data/);
      expect(prompt).toMatch(/look-ahead/i);
    }
  });

  it("template keys are unique", () => {
    const keys = COWORKER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildCoworkerSystemPrompt", () => {
  it("renders role, responsibilities, tools, constraints, and safety rails", () => {
    const prompt = buildCoworkerSystemPrompt({
      role: "ETH Scout",
      responsibilities: ["Watch ETH funding rates"],
      constraints: ["Read-only"],
      tools: ["get_market_price"],
    });
    expect(prompt).toContain("ETH Scout");
    expect(prompt).toContain("Watch ETH funding rates");
    expect(prompt).toContain("get_market_price");
    expect(prompt).toContain("Read-only");
    expect(hasSafetyRails(prompt)).toBe(true);
  });
});

describe("withSafetyRails", () => {
  it("appends rails once and is idempotent", () => {
    const once = withSafetyRails("Do research well and thoroughly for the team.");
    expect(hasSafetyRails(once)).toBe(true);
    expect(withSafetyRails(once)).toBe(once);
  });
});

describe("validateCoworkerInput", () => {
  it("accepts a minimal valid coworker and appends safety rails", async () => {
    const result = await validateCoworkerInput(
      { name: "My Quant", engine: "opencode-cli", systemPrompt: goodPrompt },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.id).toMatch(/^[a-z0-9-]{3,64}$/);
    expect(hasSafetyRails(result.normalized?.systemPrompt ?? "")).toBe(true);
  });

  it("builds the prompt from responsibilities when systemPrompt is omitted", async () => {
    const result = await validateCoworkerInput(
      {
        name: "Scout",
        engine: "opencode-cli",
        role: "Strategy Researcher",
        responsibilities: ["Explore RSI divergences on BTC 1h data"],
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.normalized?.systemPrompt).toContain("Explore RSI divergences");
  });

  it("rejects missing name/engine/prompt with actionable errors", async () => {
    const result = await validateCoworkerInput({}, deps);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/'name'.*required/);
    expect(result.errors.join(" ")).toMatch(/'engine'.*required/);
    expect(result.errors.join(" ")).toMatch(/'systemPrompt'/);
  });

  it("rejects unknown engines", async () => {
    const result = await validateCoworkerInput(
      { name: "X", engine: "nope-cli", systemPrompt: goodPrompt },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unknown engine 'nope-cli'/);
  });

  it("rejects unknown tools and names the valid ones", async () => {
    const result = await validateCoworkerInput(
      { name: "X", engine: "opencode-cli", systemPrompt: goodPrompt, tools: ["get_market_price", "hack_exchange"] },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unknown tools: hack_exchange/);
  });

  it("rejects malformed ids", async () => {
    const result = await validateCoworkerInput(
      { id: "Bad_ID!!", name: "X", engine: "opencode-cli", systemPrompt: goodPrompt },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/'id'.*invalid/);
  });

  it("rejects duplicate ids (409 path)", async () => {
    const result = await validateCoworkerInput(
      { id: "taken-bot", name: "X", engine: "opencode-cli", systemPrompt: goodPrompt },
      { ...deps, idTaken: (id: string) => id === "taken-bot" },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/already taken/);
  });

  it("requires execution permission + proposal tool for trade proposers", async () => {
    const noExec = await validateCoworkerInput(
      {
        name: "X",
        engine: "opencode-cli",
        systemPrompt: goodPrompt,
        tools: ["create_trade_proposal"],
        permissions: { execution: false },
        riskPermissions: { allowTradeProposals: true },
      },
      deps,
    );
    expect(noExec.ok).toBe(false);
    expect(noExec.errors.join(" ")).toMatch(/permissions\.execution/);

    const noTool = await validateCoworkerInput(
      {
        name: "X",
        engine: "opencode-cli",
        systemPrompt: goodPrompt,
        tools: ["get_market_price"],
        permissions: { execution: true },
        riskPermissions: { allowTradeProposals: true },
      },
      deps,
    );
    expect(noTool.ok).toBe(false);
    expect(noTool.errors.join(" ")).toMatch(/create_trade_proposal/);
  });

  it("caps maxOrderSize at creation time", async () => {
    const result = await validateCoworkerInput(
      {
        name: "Whale",
        engine: "opencode-cli",
        systemPrompt: goodPrompt,
        riskPermissions: { allowTradeProposals: false, maxOrderSize: 999 },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/maxOrderSize/);
  });

  it("rejects short or non-object inputs", async () => {
    const short = await validateCoworkerInput(
      { name: "X", engine: "opencode-cli", systemPrompt: "too short" },
      deps,
    );
    expect(short.ok).toBe(false);
    const nonObject = await validateCoworkerInput("nope", deps);
    expect(nonObject.ok).toBe(false);
  });
});
