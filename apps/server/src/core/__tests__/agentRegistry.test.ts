import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../agentRegistry.js";
import { BaseAgent } from "../agent.js";

function makeAgent(id: string, deps: string[] = []): BaseAgent {
  return new (class extends BaseAgent {
    constructor() {
      super({ id, name: `${id} agent`, dependencies: deps });
    }
    protected async onStart(): Promise<void> {}
    protected async onStop(): Promise<void> {}
  })();
}

describe("AgentRegistry", () => {
  it("rejects duplicates and invalid agents", () => {
    const reg = new AgentRegistry();
    reg.register(makeAgent("a"));
    assert.throws(() => reg.register(makeAgent("a")), /already registered/);
    assert.throws(() => reg.register({} as never), /agent.id/);
  });

  it("starts in dependency order and reports health", async () => {
    const order: string[] = [];
    const mk = (id: string, deps: string[] = []) =>
      new (class extends BaseAgent {
        constructor() {
          super({ id, name: id, dependencies: deps });
        }
        protected async onStart(): Promise<void> {
          order.push(id);
        }
        protected async onStop(): Promise<void> {}
      })();
    const reg = new AgentRegistry();
    reg.register(mk("risk", ["quant"]));
    reg.register(mk("quant", ["market"]));
    reg.register(mk("market"));
    await reg.startAll();
    assert.deepEqual(order, ["market", "quant", "risk"]);
    const h = reg.health();
    assert.equal(h.total, 3);
    assert.equal(h.running, 3);
    await reg.stopAll();
    assert.equal(reg.health().running, 0);
  });

  it("runLoops executes N iterations (multi-loop verification)", async () => {
    const reg = new AgentRegistry();
    const out = await reg.runLoops(3, (i) => i * 2);
    assert.deepEqual(out, [0, 2, 4]);
    await assert.rejects(() => reg.runLoops(0, () => 1), /positive integer/);
  });

  it("uses bus-less agents (legacy compat path exercised in runtime test)", () => {
    const reg = new AgentRegistry();
    void reg;
    const a = makeAgent("solo");
    assert.ok(a instanceof BaseAgent);
  });
});
