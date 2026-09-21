// ============================================================================
// LLM CLI driver — CliDriver, detectCliEngines, LlmService cli branch
// ============================================================================

import { describe, it, expect } from "vitest";
import { CliDriver } from "../src/llm/cli-driver.js";
import type { SpawnFn } from "../src/llm/cli-driver.js";
import { detectCliEngines } from "../src/llm/engines.js";
import { LlmService } from "../src/llm/llm-service.js";
import type { CliConfig } from "../src/llm/types.js";

function cliCfg(overrides?: Partial<CliConfig>): CliConfig {
  return {
    provider: "cli",
    command: "mycli",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. CliDriver
// ---------------------------------------------------------------------------

describe("CliDriver", () => {
  it("substitutes {prompt} into default args and returns trimmed stdout", async () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    const spawnImpl: SpawnFn = async (cmd, args) => {
      seen.push({ cmd, args });
      return { stdout: "  hello from cli  \n", stderr: "", code: 0 };
    };
    const driver = new CliDriver({ command: "mycli", spawnImpl });
    const out = await driver.complete("say hi");
    expect(out).toBe("hello from cli");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toBe("mycli");
    expect(seen[0]!.args).toEqual(["-p", "say hi"]);
  });

  it("substitutes {prompt} and {model} into custom args", async () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    const spawnImpl: SpawnFn = async (cmd, args) => {
      seen.push({ cmd, args });
      return { stdout: "ok", stderr: "", code: 0 };
    };
    const driver = new CliDriver({
      command: "claude",
      model: "opus-1",
      args: ["-p", "{prompt}", "--model", "{model}"],
      spawnImpl,
    });
    await driver.complete("do things");
    expect(seen[0]!.args).toEqual(["-p", "do things", "--model", "opus-1"]);
  });

  it("throws with exit code + stderr on non-zero exit", async () => {
    const spawnImpl: SpawnFn = async () => ({
      stdout: "",
      stderr: "kaboom: bad flags",
      code: 2,
    });
    const driver = new CliDriver({ command: "mycli", spawnImpl });
    await expect(driver.complete("hi")).rejects.toThrow(/cli exited 2: kaboom: bad flags/);
  });

  it("throws on blank stdout", async () => {
    const spawnImpl: SpawnFn = async () => ({
      stdout: "   \n  ",
      stderr: "",
      code: 0,
    });
    const driver = new CliDriver({ command: "mycli", spawnImpl });
    await expect(driver.complete("hi")).rejects.toThrow("empty CLI response");
  });

  it("drops args containing {model} when no model is set", async () => {
    const seen: string[][] = [];
    const spawnImpl: SpawnFn = async (_cmd, args) => {
      seen.push(args);
      return { stdout: "ok", stderr: "", code: 0 };
    };
    const driver = new CliDriver({
      command: "ollama",
      args: ["run", "{model}", "{prompt}"],
      spawnImpl,
    });
    await driver.complete("hello");
    expect(seen[0]).toEqual(["run", "hello"]);
  });

  it("keeps {model} args when a model is provided via complete opts", async () => {
    const seen: string[][] = [];
    const spawnImpl: SpawnFn = async (_cmd, args) => {
      seen.push(args);
      return { stdout: "ok", stderr: "", code: 0 };
    };
    const driver = new CliDriver({
      command: "ollama",
      args: ["run", "{model}", "{prompt}"],
      spawnImpl,
    });
    await driver.complete("hello", { model: "llama3" });
    expect(seen[0]).toEqual(["run", "llama3", "hello"]);
  });
});

// ---------------------------------------------------------------------------
// 2. detectCliEngines
// ---------------------------------------------------------------------------

describe("detectCliEngines", () => {
  it("marks found CLIs with path and missing ones as not found", async () => {
    const execImpl = async (cmd: string): Promise<string | null> => {
      if (cmd === "claude") return "/usr/local/bin/claude\n";
      return null;
    };
    const engines = await detectCliEngines(execImpl);
    expect(engines.map((e) => e.command)).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "ollama",
      "hermes",
      "agy",
      "opencode",
      "qwen",
      "pi",
    ]);
    const claude = engines.find((e) => e.command === "claude")!;
    expect(claude.found).toBe(true);
    expect(claude.path).toBe("/usr/local/bin/claude");
    for (const e of engines.filter((x) => x.command !== "claude")) {
      expect(e.found).toBe(false);
      expect(e.path).toBeUndefined();
    }
    // Every engine carries suggested args.
    for (const e of engines) {
      expect(Array.isArray(e.suggestedArgs)).toBe(true);
      expect(e.suggestedArgs!.length).toBeGreaterThan(0);
    }
  });

  it("never rejects when execImpl throws", async () => {
    const execImpl = async (_cmd: string): Promise<string | null> => {
      throw new Error("probe exploded");
    };
    const engines = await detectCliEngines(execImpl);
    expect(engines).toHaveLength(10);
    for (const e of engines) {
      expect(e.found).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. LlmService cli branch
// ---------------------------------------------------------------------------

describe("LlmService cli branch", () => {
  it("completes via CLI without any env key", async () => {
    const spawnImpl: SpawnFn = async (cmd, args) => {
      expect(cmd).toBe("hellocli");
      expect(args).toEqual(["exec", "ping?"]);
      return { stdout: "pong", stderr: "", code: 0 };
    };
    const svc = new LlmService({ spawnImpl });
    const out = await svc.complete(
      cliCfg({ command: "hellocli", args: ["exec", "{prompt}"] }),
      "ping?",
    );
    expect(out).toBe("pong");
  });

  it("isConfigured reflects blank vs non-blank command", () => {
    const svc = new LlmService();
    expect(svc.isConfigured(cliCfg({ command: "codex" }))).toBe(true);
    expect(svc.isConfigured(cliCfg({ command: "" }))).toBe(false);
    expect(svc.isConfigured(cliCfg({ command: "   " }))).toBe(false);
  });
});
