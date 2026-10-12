// ============================================================================
// CLI provider adapters — contract tests for Claude Code (first provider).
// Uses an injected fake runner; no installed CLI or credentials required.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  CliManager,
  createClaudeAdapter,
  createCodexAdapter,
} from "../src/cli/index.js";
import { parseClaudeStreamLine } from "../src/cli/adapters/claude-adapter.js";
import { ClaudeAdapter } from "../src/cli/adapters/claude-adapter.js";
import { parseCodexJsonLine } from "../src/cli/adapters/codex-adapter.js";
import { CodexAdapter } from "../src/cli/adapters/codex-adapter.js";
import { createGeminiAdapter } from "../src/cli/index.js";
import { parseGeminiStreamLine } from "../src/cli/adapters/gemini-adapter.js";
import { GeminiAdapter } from "../src/cli/adapters/gemini-adapter.js";
import { createCursorCliAdapter } from "../src/cli/index.js";
import { CursorCliAdapter } from "../src/cli/adapters/cursor-adapter.js";
import { createClineCliAdapter } from "../src/cli/index.js";
import { parseClineJsonLine } from "../src/cli/adapters/cline-adapter.js";
import { ClineCliAdapter } from "../src/cli/adapters/cline-adapter.js";
import { AcpConnection } from "../src/cli/index.js";
import { createDefaultCliManager } from "../src/cli/index.js";

describe("Provider registration", () => {
  it("registers all seven providers in the default manager", () => {
    const manager = createDefaultCliManager();
    expect(manager.listMetadata().map((m) => m.id).sort()).toEqual([
      "claude",
      "cline",
      "cline-cli",
      "codex",
      "cursor-cli",
      "gemini",
      "opencode",
    ]);
    // Engine-alias lookup keeps working for every provider.
    // "cline" resolves to the primary adapter (first registration wins).
    expect(manager.findByEngineId("codex")?.getMetadata().id).toBe("codex");
    expect(manager.findByEngineId("gemini")?.getMetadata().id).toBe("gemini");
    expect(manager.findByEngineId("cursor")?.getMetadata().id).toBe("cursor-cli");
    expect(manager.findByEngineId("cline")?.getMetadata().id).toBe("cline");
    expect(manager.findByEngineId("opencode-cli")?.getMetadata().id).toBe("opencode");
  });
});

/** Provider adapters with filesystem resolution stubbed (hermetic tests). */
class TestClaudeAdapter extends ClaudeAdapter {
  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/claude";
  }
}

class TestCodexAdapter extends CodexAdapter {
  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/codex";
  }
}

class TestGeminiAdapter extends GeminiAdapter {
  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/gemini";
  }
}

class TestCursorAdapter extends CursorCliAdapter {
  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/agent";
  }
}

class TestClineAdapter extends ClineCliAdapter {
  override async resolveExecutable(): Promise<string | null> {
    return "/fake/bin/cline";
  }
}
import type {
  CliProcessHandlers,
  CliProcessResult,
  CliProcessSpec,
} from "../src/cli/index.js";

function fakeRunner(
  script: Partial<CliProcessResult> & { stdout?: string; delayMs?: number; seen?: CliProcessSpec[] },
): (spec: CliProcessSpec, handlers?: CliProcessHandlers) => Promise<CliProcessResult> {
  return async (spec, handlers = {}) => {
    script.seen?.push(spec);
    const started = Date.now();
    const timeout = spec.timeoutMs ?? 60_000;
    let outcome: "done" | "timeout" | "cancelled" = "done";
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      if (outcome === "done") outcome = "timeout";
      timer = null;
    }, Math.max(timeout, 0));
    const onAbort = () => {
      if (outcome === "done") {
        outcome = "cancelled";
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (script.stdout) handlers.onStdoutChunk?.(script.stdout);
    const delay = script.delayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 50)));
      if (outcome === "done" && delay > 60) {
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (outcome !== "done") {
              clearInterval(poll);
              resolve();
            }
          }, 1);
          setTimeout(() => {
            clearInterval(poll);
            resolve();
          }, delay);
        });
      }
    }
    if (timer) clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
    if (outcome === "cancelled") {
      return { exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true, durationMs: Date.now() - started };
    }
    if (outcome === "timeout") {
      return { exitCode: null, stdout: "", stderr: "", timedOut: true, cancelled: false, durationMs: Date.now() - started };
    }
    return {
      exitCode: script.exitCode ?? 0,
      stdout: script.stdout ?? "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
    };
  };
}

describe("Claude Code adapter", () => {
  it("publishes one-shot metadata with stream-json argv", () => {
    const adapter = createClaudeAdapter();
    const meta = adapter.getMetadata();
    expect(meta.id).toBe("claude");
    expect(meta.executable).toBe("claude");
    expect(meta.taskDelivery).toBe("argv");
    expect(meta.sessionModes).toEqual(["one-shot"]);
    expect(meta.supportsStreaming).toBe(true);
    expect(meta.supportsCancellation).toBe(true);
    expect(adapter.buildSessionArgs({})).toEqual([
      "-p",
      "{prompt}",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("injects --model/--agent flags without touching the prompt argv", () => {
    const adapter = createClaudeAdapter();
    expect(
      adapter.decorateTaskArgs(["-p", "{prompt}", "--output-format", "stream-json"], {
        model: "sonnet",
        agentId: "quant",
      }),
    ).toEqual(["-p", "--model", "sonnet", "--agent", "quant", "{prompt}", "--output-format", "stream-json"]);
    // No duplication when flags already present.
    expect(
      adapter.decorateTaskArgs(["-p", "--model", "x", "{prompt}"], { model: "sonnet" }),
    ).toEqual(["-p", "--model", "x", "{prompt}"]);
  });

  it("parses assistant text, tool_use blocks and result events", () => {
    expect(
      parseClaudeStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      ),
    ).toEqual([{ type: "delta", content: "hi" }]);
    expect(
      parseClaudeStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", arguments: { command: "ls" } }]);
    expect(parseClaudeStreamLine('{"type":"result","result":"done"}')).toEqual([
      { type: "delta", content: "done" },
    ]);
    // Unknown shapes fall back to plain text (empty = no protocol chunk).
    expect(parseClaudeStreamLine('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(parseClaudeStreamLine("not json")).toEqual([]);
    expect(parseClaudeStreamLine('{"broken')).toEqual([]);
  });

  it("runs a task through the manager: argv array, no shell string", async () => {
    const seen: CliProcessSpec[] = [];
    const manager = new CliManager({
      runProcessImpl: fakeRunner({
        stdout: '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n',
        seen,
      }),
    });
    manager.register(new TestClaudeAdapter());
    const session = await manager.start("claude");
    const result = await session.runTask({ task: "say ok", model: "sonnet" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
    expect(seen).toHaveLength(1);
    // Prompt travels as a discrete argv element — never interpolated into
    // a shell command string. `shell` itself is adapter-declared (Windows
    // .cmd shims need it) and environment-dependent, so assert the argv
    // property instead of a fixed shell value.
    expect(seen[0]?.args).toContain("say ok");
    expect(seen[0]?.args).toContain("-p");
    expect(seen[0]?.args).toContain("--output-format");
    await manager.stop(session.id);
  });

  it("reports timeouts and cancellation", async () => {
    const manager = new CliManager({
      runProcessImpl: fakeRunner({ stdout: "", delayMs: 5_000 }),
    });
    manager.register(new TestClaudeAdapter());
    const session = await manager.start("claude", { timeoutMs: 15 });
      const timed = await session.runTask({ task: "slow" });
      expect(timed.ok).toBe(false);
      expect(timed.timedOut).toBe(true);

      const controller = new AbortController();
      const pending = session.runTask({ task: "slow", signal: controller.signal });
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.cancelled).toBe(true);
      await manager.stop(session.id);
  });
});

describe("Codex CLI adapter", () => {
  it("publishes one-shot exec metadata with JSONL argv", () => {
    const adapter = createCodexAdapter();
    const meta = adapter.getMetadata();
    expect(meta.id).toBe("codex");
    expect(meta.executable).toBe("codex");
    expect(meta.taskDelivery).toBe("argv");
    expect(meta.sessionModes).toEqual(["one-shot"]);
    expect(adapter.buildSessionArgs({})).toEqual(["exec", "--json", "{prompt}"]);
  });

  it("injects -m without touching the prompt argv", () => {
    const adapter = createCodexAdapter();
    expect(
      adapter.decorateTaskArgs(["exec", "--json", "{prompt}"], { model: "gpt-5-codex" }),
    ).toEqual(["exec", "-m", "gpt-5-codex", "--json", "{prompt}"]);
    expect(
      adapter.decorateTaskArgs(["exec", "-m", "x", "{prompt}"], { model: "gpt-5-codex" }),
    ).toEqual(["exec", "-m", "x", "{prompt}"]);
  });

  it("parses agent messages, tool items and error events", () => {
    expect(
      parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'),
    ).toEqual([{ type: "delta", content: "hi" }]);
    expect(
      parseCodexJsonLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}',
      ),
    ).toEqual([{ type: "tool_call", name: "command_execution", arguments: { command: "ls" } }]);
    expect(
      parseCodexJsonLine(
        '{"type":"item.completed","item":{"type":"mcp_tool_call","name":"get_price","arguments":{"symbol":"BTC"}}}',
      ),
    ).toEqual([{ type: "tool_call", name: "mcp.get_price", arguments: { symbol: "BTC" } }]);
    // Lifecycle events carry no user content; unknown shapes fall back.
    expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"t1"}')).toEqual([]);
    expect(parseCodexJsonLine('{"type":"turn.completed"}')).toEqual([]);
    expect(parseCodexJsonLine("plain text")).toEqual([]);
  });

  it("runs a task through the manager and surfaces tool calls", async () => {
    const seen: CliProcessSpec[] = [];
    const manager = new CliManager({
      runProcessImpl: fakeRunner({
        stdout:
          '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n' +
          '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}\n',
        seen,
      }),
    });
    manager.register(new TestCodexAdapter());
    const session = await manager.start("codex");
    const result = await session.runTask({ task: "say ok", model: "gpt-5" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
    expect(result.toolActivities).toEqual([
      { name: "command_execution", arguments: { command: "ls" } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toContain("exec");
    expect(seen[0]?.args).toContain("--json");
    expect(seen[0]?.args).toContain("say ok");
    await manager.stop(session.id);
  });
});

describe("Gemini CLI adapter", () => {
  it("publishes one-shot headless metadata with stream-json argv", () => {
    const adapter = createGeminiAdapter();
    const meta = adapter.getMetadata();
    expect(meta.id).toBe("gemini");
    expect(meta.executable).toBe("gemini");
    expect(meta.taskDelivery).toBe("argv");
    expect(meta.sessionModes).toEqual(["one-shot"]);
    expect(adapter.buildSessionArgs({})).toEqual([
      "-p",
      "{prompt}",
      "--output-format",
      "stream-json",
    ]);
  });

  it("injects -m without touching the prompt argv", () => {
    const adapter = createGeminiAdapter();
    expect(
      adapter.decorateTaskArgs(["-p", "{prompt}", "--output-format", "stream-json"], {
        model: "gemini-2.5-flash",
      }),
    ).toEqual(["-p", "-m", "gemini-2.5-flash", "{prompt}", "--output-format", "stream-json"]);
  });

  it("parses message text, tool_use and result events", () => {
    expect(parseGeminiStreamLine('{"type":"message","text":"hi"}')).toEqual([
      { type: "delta", content: "hi" },
    ]);
    expect(
      parseGeminiStreamLine('{"type":"tool_use","name":"run_shell_command","args":{"cmd":"ls"}}'),
    ).toEqual([{ type: "tool_call", name: "run_shell_command", arguments: { cmd: "ls" } }]);
    expect(parseGeminiStreamLine('{"type":"result","response":"done"}')).toEqual([
      { type: "delta", content: "done" },
    ]);
    expect(parseGeminiStreamLine('{"type":"init","session_id":"s1"}')).toEqual([]);
    expect(parseGeminiStreamLine("plain text")).toEqual([]);
  });

  it("runs a task through the manager and surfaces tool calls", async () => {
    const seen: CliProcessSpec[] = [];
    const manager = new CliManager({
      runProcessImpl: fakeRunner({
        stdout:
          '{"type":"message","text":"ok"}\n' +
          '{"type":"tool_use","name":"run_shell_command","args":{"cmd":"ls"}}\n',
        seen,
      }),
    });
    manager.register(new TestGeminiAdapter());
    const session = await manager.start("gemini");
    const result = await session.runTask({ task: "say ok", model: "gemini-2.5-flash" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
    expect(result.toolActivities).toEqual([
      { name: "run_shell_command", arguments: { cmd: "ls" } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toContain("-p");
    expect(seen[0]?.args).toContain("stream-json");
    expect(seen[0]?.args).toContain("say ok");
    await manager.stop(session.id);
  });
});

describe("Cursor CLI adapter", () => {
  it("publishes honest one-shot print metadata (no structured streaming)", () => {
    const adapter = createCursorCliAdapter();
    const meta = adapter.getMetadata();
    expect(meta.id).toBe("cursor-cli");
    expect(meta.executable).toBe("agent");
    expect(meta.taskDelivery).toBe("argv");
    expect(meta.sessionModes).toEqual(["one-shot"]);
    // No structured stream is documented for print mode — not claimed.
    expect(meta.supportsStreaming).toBe(false);
    expect(meta.supportsCancellation).toBe(true);
    expect(adapter.buildSessionArgs({})).toEqual(["-p", "{prompt}", "--output-format", "text"]);
  });

  it("injects --model/--mode without touching the prompt argv", () => {
    const adapter = createCursorCliAdapter();
    expect(
      adapter.decorateTaskArgs(["-p", "{prompt}", "--output-format", "text"], {
        model: "gpt-5",
        agentId: "ask",
      }),
    ).toEqual(["-p", "--mode", "ask", "--model", "gpt-5", "{prompt}", "--output-format", "text"]);
  });

  it("passes plain-text output through and runs a task", async () => {
    const seen: CliProcessSpec[] = [];
    const manager = new CliManager({
      runProcessImpl: fakeRunner({ stdout: "all done\n", seen }),
    });
    manager.register(new TestCursorAdapter());
    const session = await manager.start("cursor-cli");
    const result = await session.runTask({ task: "say ok" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("all done");
    expect(result.toolActivities).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toContain("-p");
    expect(seen[0]?.args).toContain("say ok");
    await manager.stop(session.id);
  });
});

describe("Cline CLI adapter", () => {
  it("publishes one-shot JSON metadata", () => {
    const adapter = createClineCliAdapter();
    const meta = adapter.getMetadata();
    expect(meta.id).toBe("cline-cli");
    expect(meta.executable).toBe("cline");
    expect(meta.taskDelivery).toBe("argv");
    expect(meta.sessionModes).toEqual(["one-shot"]);
    expect(adapter.buildSessionArgs({})).toEqual(["--json", "{prompt}"]);
  });

  it("parses say text and ask approval requests", () => {
    expect(parseClineJsonLine('{"type":"say","text":"hi","ts":123}')).toEqual([
      { type: "delta", content: "hi" },
    ]);
    expect(
      parseClineJsonLine('{"type":"ask","ask":"command","text":"run ls?","ts":124}'),
    ).toEqual([
      { type: "tool_call", name: "ask", arguments: { ask_type: "command", text: "run ls?" } },
    ]);
    expect(parseClineJsonLine("plain text")).toEqual([]);
    expect(parseClineJsonLine('{"type":"other"}')).toEqual([]);
  });

  it("runs a task through the manager and surfaces ask events", async () => {
    const seen: CliProcessSpec[] = [];
    const manager = new CliManager({
      runProcessImpl: fakeRunner({
        stdout:
          '{"type":"say","text":"ok","ts":1}\n' +
          '{"type":"ask","ask":"command","text":"run?","ts":2}\n',
        seen,
      }),
    });
    manager.register(new TestClineAdapter());
    const session = await manager.start("cline-cli");
    const result = await session.runTask({ task: "say ok" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
    expect(result.toolActivities).toEqual([
      { name: "ask", arguments: { ask_type: "command", text: "run?" } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toContain("--json");
    expect(seen[0]?.args).toContain("say ok");
    await manager.stop(session.id);
  });
});

describe("Shared ACP transport", () => {
  function frame(body: string): string {
    return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
  }

  function harness() {
    const written: string[] = [];
    const dataHandlers: Array<(chunk: string) => void> = [];
    const conn = new AcpConnection({
      write: (data) => {
        written.push(data);
      },
      onData: (handler) => {
        dataHandlers.push(handler);
        return () => undefined;
      },
    });
    return { written, dataHandlers, conn };
  }

  it("resolves requests and routes notifications", async () => {
    const { written, dataHandlers, conn } = harness();
    const notifications: Array<{ method: string; params: unknown }> = [];
    conn.onNotification((method, params) => {
      notifications.push({ method, params });
    });
    const pending = conn.request("initialize", { version: 1 }, 1000);
    expect(written).toHaveLength(1);
    for (const handler of dataHandlers) {
      handler(
        frame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })) +
          frame(JSON.stringify({ jsonrpc: "2.0", method: "progress", params: { n: 1 } })),
      );
    }
    await expect(pending).resolves.toEqual({ ok: true });
    expect(notifications).toEqual([{ method: "progress", params: { n: 1 } }]);
    conn.close();
  });

  it("rejects on error responses, timeouts and close", async () => {
    const { dataHandlers, conn } = harness();
    const failing = conn.request("do", {}, 1000);
    for (const handler of dataHandlers) {
      handler(frame(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nope" } })));
    }
    await expect(failing).rejects.toThrow(/nope/);

    const slow = conn.request("slow", {}, 15);
    await expect(slow).rejects.toThrow(/timed out/);

    const orphan = conn.request("orphan", {}, 1000);
    conn.close();
    conn.close();
    await expect(orphan).rejects.toThrow(/closed/);
    expect(conn.isConnected()).toBe(false);
    expect(() => conn.notify("x")).toThrow(/closed/);
  });
});
