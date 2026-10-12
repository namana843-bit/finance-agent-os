// Cline CLI — primary adapter + gateway: metadata, argv, parsing, gating.
// No installed CLI required (no spawning; validation asserts shape only).

import { describe, it, expect } from "vitest";
import {
  CliManager,
  createClineAdapter,
  createDefaultCliManager,
  createOpenCodeAdapter,
} from "../src/cli/index.js";
import { ClineCliGateway } from "../src/gateway/cline-cli-gateway.js";
import { OpencodeCliGateway } from "../src/gateway/opencode-cli-gateway.js";
import type { TypedEventBus } from "@finance/core";

function stubBus() {
  const published: Array<{ type: string }> = [];
  return {
    bus: {
      publish: (e: { type: string }) => {
        published.push({ type: e.type });
        return e as never;
      },
    } as unknown as TypedEventBus,
    published,
  };
}

describe("cline adapter (primary)", () => {
  it("exposes one-shot argv metadata and registers first", () => {
    const adapter = createClineAdapter();
    expect(adapter.getMetadata()).toMatchObject({
      id: "cline",
      executable: "cline",
      taskDelivery: "argv",
      supportsStreaming: true,
      supportsCancellation: true,
    });
    expect(adapter.getMetadata().defaultArgs).toEqual(["--json", "{prompt}"]);
    expect(adapter.supportsMode("one-shot")).toBe(true);
    // Persistent mode is deliberately NOT advertised.
    expect(adapter.supportsMode("persistent")).toBe(false);

    const manager: CliManager = createDefaultCliManager();
    expect(manager.has("cline")).toBe(true);
    expect(manager.has("opencode")).toBe(true); // deprecated fallback kept
    expect(manager.findByEngineId("cline-cli")?.getMetadata().id).toBe("cline");
    expect(manager.findByEngineId("cline")?.getMetadata().id).toBe("cline");
  });

  it("builds one-shot argv with -m only when a model is set", () => {
    const cline = createClineAdapter();
    expect(cline.buildOneShotArgs(["--json", "{prompt}"], "hi", { daemonUrl: null })).toEqual([
      "--json",
      "hi",
    ]);
    expect(cline.decorateTaskArgs(["--json", "{prompt}"], { model: "anthropic/claude-sonnet-4" })).toEqual([
      "--json",
      "-m",
      "anthropic/claude-sonnet-4",
      "{prompt}",
    ]);
    expect(cline.decorateTaskArgs(["--json", "{prompt}"], {})).toEqual(["--json", "{prompt}"]);
    expect(cline.decorateTaskArgs(["--json", "{prompt}"], { model: "default" })).toEqual([
      "--json",
      "{prompt}",
    ]);
  });

  it("parses cline --json message shapes into deltas, tolerates malformed output", () => {
    const cline = createClineAdapter();
    expect(cline.parseLine('{"type":"say","text":"hello"}')).toMatchObject({
      type: "delta",
      content: "hello",
    });
    expect(cline.parseLine('{"delta":"world"}')).toMatchObject({
      type: "delta",
      content: "world",
    });
    expect(cline.parseLine("plain text line")).toBeNull();
    expect(cline.parseLine("{not json")).toBeNull();
  });

  it("validateInstallation reports a well-formed result without throwing", async () => {
    const res = await createClineAdapter().validateInstallation();
    expect(res.adapterId).toBe("cline");
    expect(typeof res.ok).toBe("boolean");
    expect(res.checkedAt).toBeGreaterThan(0);
    if (!res.ok) expect(res.error).toMatch(/cline/);
  });
});

describe("cline gateway (primary)", () => {
  it("accepts a bare one-shot prompt and rejects shell metachars", async () => {
    const { bus, published } = stubBus();
    const gw = new ClineCliGateway(bus, {
      enabled: true,
      cliPathOverride: "definitely-not-a-real-binary-xyz",
      timeoutMs: 1000,
    });
    // Bare prompt is allowed through gating (execution will fail: no binary —
    // that proves gating passed and only the spawn failed).
    const bare = await gw.run({ command: "summarize this repo", agentId: "test" });
    expect(bare.gated.allowed).toBe(true);
    expect(bare.ok).toBe(false);
    expect(published.map((p) => p.type)).toContain("cline.cli_request");

    const evil = await gw.run({ command: "do X; rm -rf ~", agentId: "test" });
    expect(evil.gated.allowed).toBe(false);
    expect(published.map((p) => p.type)).toContain("cline.cli_rejected");
  });

  it("opencode gateway keeps legacy behavior (bare prompts rejected)", async () => {
    const { bus } = stubBus();
    const gw = new OpencodeCliGateway(bus, {
      enabled: true,
      cliPathOverride: "definitely-not-a-real-binary-xyz",
      timeoutMs: 1000,
    });
    const bare = await gw.run({ command: "summarize this repo", agentId: "test" });
    expect(bare.gated.allowed).toBe(false);
    const run = await gw.run({ command: "run", args: ["run", "hello"], agentId: "test" });
    expect(run.gated.allowed).toBe(true);
  });

  it("opencode adapter still registered with unchanged one-shot shape", () => {
    expect(createOpenCodeAdapter().getMetadata().defaultArgs).toEqual(["run", "--auto", "{prompt}"]);
  });
});
