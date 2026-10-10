// Phase A — claude/codex/gemini adapters: metadata, argv, manager lookup.
// No installed CLI required (no spawning; validation asserts miss shape only).

import { describe, it, expect } from "vitest";
import {
  CliManager,
  createClaudeAdapter,
  createCodexAdapter,
  createGeminiAdapter,
  createDefaultCliManager,
} from "../src/cli/index.js";

describe("phase-a adapters", () => {
  it("exposes argv one-shot metadata", () => {
    expect(createClaudeAdapter().getMetadata()).toMatchObject({
      id: "claude",
      executable: "claude",
      taskDelivery: "argv",
    });
    expect(createCodexAdapter().getMetadata().defaultArgs).toEqual(["exec", "--json", "{prompt}"]);
    expect(createGeminiAdapter().getMetadata().defaultArgs).toEqual([
      "-p",
      "{prompt}",
      "--output-format",
      "stream-json",
    ]);
  });

  it("builds one-shot argv with prompt substitution", () => {
    const claude = createClaudeAdapter();
    expect(claude.buildOneShotArgs(["-p", "{prompt}"], "hi", { daemonUrl: null })).toEqual(["-p", "hi"]);
    // claude inserts --model after -p only when set (verified: claude -p --model)
    expect(claude.decorateTaskArgs(["-p", "{prompt}"], { model: "sonnet" })).toEqual([
      "-p",
      "--model",
      "sonnet",
      "{prompt}",
    ]);
    expect(claude.decorateTaskArgs(["-p", "{prompt}"], {})).toEqual(["-p", "{prompt}"]);
  });

  it("registers in the default manager and resolves by engine id", () => {
    const manager: CliManager = createDefaultCliManager();
    for (const id of ["claude", "codex", "gemini", "opencode"]) {
      expect(manager.has(id)).toBe(true);
    }
    expect(manager.findByEngineId("claude")?.getMetadata().id).toBe("claude");
    expect(manager.findByEngineId("codex-cli")?.getMetadata().id).toBe("codex");
    expect(manager.findByExecutable("gemini")?.getMetadata().id).toBe("gemini");
  });

  it("validateInstallation reports miss without throwing", async () => {
    const res = await createCodexAdapter().validateInstallation();
    expect(res.adapterId).toBe("codex");
    expect(typeof res.ok).toBe("boolean");
    expect(res.checkedAt).toBeGreaterThan(0);
  });

  it("one-shot session streams via the shared runner (real node spawn)", async () => {
    const { CliSessionManager } = await import("../src/llm/cli-session.js");
    const manager = new CliSessionManager({ cliManager: createDefaultCliManager() });
    try {
      const session = await manager.getOrCreateSession("test-bot", "node", [
        "-e",
        "process.stdout.write('out-{prompt}')",
      ]);
      let text = "";
      for await (const chunk of session.sendPrompt("X")) {
        if (chunk.type === "delta" && chunk.content) text += chunk.content;
        if (chunk.type === "error") throw new Error(chunk.error);
      }
      expect(text).toContain("out-X");
    } finally {
      await manager.terminateAll();
    }
  });
});
