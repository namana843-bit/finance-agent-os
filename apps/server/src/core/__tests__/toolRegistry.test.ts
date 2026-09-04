import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../toolRegistry.js";
import { BaseTool } from "../tool.js";
import { EventBus } from "../eventBus.js";

class AddTool extends BaseTool<{ a: number; b: number }, { sum: number }> {
  name = "add";
  description = "add two numbers";
  inputSchema = {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  };
  async execute(input: { a: number; b: number }): Promise<{ sum: number }> {
    this.validate(input);
    return { sum: input.a + input.b };
  }
}

describe("ToolRegistry", () => {
  it("registers once and executes with validation", async () => {
    const bus = new EventBus();
    const reg = new ToolRegistry(bus);
    reg.register(new AddTool());
    assert.throws(() => reg.register(new AddTool()), /already registered/);
    const ok = await reg.execute("add", { a: 2, b: 3 }, { agentId: "quant" });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.output, { sum: 5 });
    assert.ok(bus.getHistory({ type: "tool.completed" }).length >= 1);
  });

  it("rejects invalid input and unknown tools", async () => {
    const reg = new ToolRegistry();
    reg.register(new AddTool());
    const bad = await reg.execute("add", { a: 1 }, {});
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /required/);
    const unknown = await reg.execute("nope", {}, {});
    assert.equal(unknown.ok, false);
  });

  it("finance tools: validate-symbol + format-money (no strategies)", async () => {
    const { ValidateSymbolTool } = await import("../../tools/validateSymbol.js");
    const { FormatMoneyTool } = await import("../../tools/formatMoney.js");
    const reg = new ToolRegistry();
    reg.register(new ValidateSymbolTool());
    reg.register(new FormatMoneyTool());
    const v = await reg.execute<{ symbol: string; valid: boolean }>("validate-symbol", { symbol: "btcusdt" }, {});
    assert.equal(v.ok, true);
    assert.deepEqual(v.output, { symbol: "BTCUSDT", valid: true });
    const m = await reg.execute<{ formatted: string }>("format-money", { amount: 125430.22, currency: "USDT" }, {});
    assert.equal(m.ok, true);
    assert.equal(m.output!.formatted, "125,430.22 USDT");
  });
});
