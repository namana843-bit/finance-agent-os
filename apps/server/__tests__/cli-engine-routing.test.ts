// ============================================================================
// CLI engine routing — engine ID → provider → registered CLI adapter.
// Proves each configured engine invokes its OWN adapter (argv, executable,
// model flag) instead of silently falling back to another CLI.
// All providers use injected mock spawners: no real processes, no installed
// CLIs required.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry, EngineManager } from "../src/llm/registry.js";
import { CliProvider } from "../src/llm/providers/cli-engine.js";
import { CliManager } from "../src/cli/index.js";

// Hermetic engine overrides: EngineManager reads FINANCE_DATA_DIR/engines.json,
// which may exist on a dev machine. Point it at an empty temp dir instead.
let prevDataDir: string | undefined;
let sandboxDir: string;
beforeEach(() => {
  prevDataDir = process.env.FINANCE_DATA_DIR;
  sandboxDir = mkdtempSync(join(tmpdir(), "fa-routing-test-"));
  process.env.FINANCE_DATA_DIR = sandboxDir;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.FINANCE_DATA_DIR;
  else process.env.FINANCE_DATA_DIR = prevDataDir;
  rmSync(sandboxDir, { recursive: true, force: true });
});

function makeManagers(): EngineManager {
  return new EngineManager(new ProviderRegistry());
}

function collect(stream: AsyncIterable<any>): Promise<any[]> {
  return (async () => {
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  })();
}

describe("engine routing — catalog ids invoke their own adapter", () => {
  it.each(["claude", "codex", "gemini"])("routes engine '%s' to a same-id provider", async (engine) => {
    const em = makeManagers();
    const { provider } = await em.getProviderForEngine(engine);
    expect(provider).toBeInstanceOf(CliProvider);
    expect(provider.id).toBe(engine);
  });

  it.each([
    ["claude-code", "cli-claude", "claude"],
    ["claude-cli", "cli-claude", "claude"],
    ["codex-cli", "cli-codex", "codex"],
    ["openai-codex", "cli-codex", "codex"],
    ["gemini-cli", "cli-gemini", "gemini"],
    ["google-gemini", "cli-gemini", "gemini"],
  ])("routes alias '%s' to adapter-bound provider '%s' (%s binary)", async (alias, id, command) => {
    const em = makeManagers();
    const { provider } = await em.getProviderForEngine(alias);
    expect(provider).toBeInstanceOf(CliProvider);
    expect(provider.id).toBe(id);
    expect((provider as unknown as { command: string }).command).toBe(command);
  });

  it("keeps backward-compatible opencode + api engines", async () => {
    const em = makeManagers();
    const opencode = await em.getProviderForEngine("opencode-cli");
    expect(opencode.provider.id).toBe("cli");
    const gpt = await em.getProviderForEngine("openai-gpt4");
    expect(gpt.provider.id).toBe("openai");
    const ollama = await em.getProviderForEngine("ollama-local");
    expect(ollama.provider.id).toBe("ollama");
  });

  it("rejects truly unknown engine ids instead of running another CLI", async () => {
    const em = makeManagers();
    await expect(em.getProviderForEngine("no-such-engine-xyz")).rejects.toThrow(
      /No provider registered for engine 'no-such-engine-xyz'/,
    );
  });
});

describe("adapter argv composition through CliProvider", () => {
  it("sends claude --model exactly once (no duplicate flag)", async () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    // Mirror of EngineManager.resolveCliEngine output for the catalog entry.
    const provider = new CliProvider({
      id: "claude",
      name: "Claude",
      command: "claude",
      args: ["-p", "{prompt}", "--model", "{model}"],
      spawnImpl: (async (cmd: string, args: string[]) => {
        seen.push({ cmd, args });
        return { stdout: "ok", stderr: "", code: 0 };
      }) as any,
    });
    const events = await collect(
      provider.chat({ messages: [{ role: "user", content: "hi" }], model: "sonnet" } as any),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cmd).toContain("claude");
    // Exactly one --model flag carrying the requested model.
    expect(seen[0]?.args.filter((a) => a === "--model")).toHaveLength(1);
    expect(seen[0]?.args.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(seen[0]?.args[0]).toBe("-p");
    expect(events.map((e) => e.type)).toContain("message_complete");
  });

  it("passes task, cwd and env through to the spawned process", async () => {
    const seen: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const provider = new CliProvider({
      id: "claude",
      name: "Claude",
      command: "claude",
      args: ["-p", "{prompt}"],
      cwd: "/tmp/work",
      env: { FOO: "bar" },
      spawnImpl: (async (cmd: string, args: string[], opts: any) => {
        seen.push({ cmd, args, opts });
        return { stdout: "done", stderr: "", code: 0 };
      }) as any,
    });
    const events = await collect(
      provider.chat({ messages: [{ role: "user", content: "hello task" }] } as any),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args[0]).toBe("-p");
    expect(seen[0]?.args.join("\n")).toContain("hello task");
    expect(seen[0]?.args.filter((a) => a === "--model")).toHaveLength(1);
    expect(seen[0]?.args).toContain("claude");
    expect(seen[0]?.opts.cwd).toBe("/tmp/work");
    expect(seen[0]?.opts.env).toMatchObject({ FOO: "bar" });
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "message_complete"]);
  });
});

describe("provider failure semantics (mocked)", () => {
  it("reports missing executables without spawning", async () => {
    const provider = new CliProvider({ id: "x", command: "definitely-missing-binary-xyz-9999" });
    const events = await collect(provider.chat({ messages: [{ role: "user", content: "hi" }] } as any));
    expect(events.map((e) => e.type)).toContain("error");
    expect(events.find((e) => e.type === "error")?.error).toMatch(/not found/);
  });

  it("surfaces non-zero exits with stderr as error events", async () => {
    const provider = new CliProvider({
      id: "x",
      command: "testcli",
      spawnImpl: (async () => ({ stdout: "", stderr: "boom", code: 1 })) as any,
    });
    const events = await collect(provider.chat({ messages: [{ role: "user", content: "hi" }] } as any));
    expect(events.find((e) => e.type === "error")?.error).toMatch(/boom/);
  });

  it("reports empty responses explicitly", async () => {
    const provider = new CliProvider({
      id: "x",
      command: "testcli",
      spawnImpl: (async () => ({ stdout: "", stderr: "", code: 0 })) as any,
    });
    const events = await collect(provider.chat({ messages: [{ role: "user", content: "hi" }] } as any));
    expect(events.find((e) => e.type === "error")?.error).toMatch(/empty response/);
  });
});

describe("session modes per adapter", () => {
  it("rejects persistent sessions for one-shot adapters with an explicit error", async () => {
    const manager = new CliManager({});
    const { createClaudeAdapter } = await import("../src/cli/adapters/claude-adapter.js");
    manager.register(createClaudeAdapter());
    await expect(manager.start("claude", { mode: "persistent" })).rejects.toThrow(/does not support 'persistent' sessions/);
  });

  it("claude/codex/gemini advertise one-shot only", async () => {
    const { createClaudeAdapter } = await import("../src/cli/adapters/claude-adapter.js");
    const { createCodexAdapter } = await import("../src/cli/adapters/codex-adapter.js");
    const { createGeminiAdapter } = await import("../src/cli/adapters/gemini-adapter.js");
    for (const make of [createClaudeAdapter, createCodexAdapter, createGeminiAdapter]) {
      const meta = make().getMetadata();
      expect(meta.sessionModes ?? ["one-shot"]).toEqual(["one-shot"]);
    }
  });
});
