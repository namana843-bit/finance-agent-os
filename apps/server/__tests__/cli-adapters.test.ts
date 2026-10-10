// ============================================================================
// CLI adapter layer — interface, manager, OpenCode/custom adapters,
// registration, process lifecycle, streaming, cancellation, failure handling.
// Process tests use an injected fake runner; a small smoke section exercises
// the REAL process spawner against the node executable so no installed CLI is
// ever required.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  CliAdapterBase,
  CliManager,
  CustomCliAdapter,
  OpenCodeAdapter,
  createCustomCliAdapter,
  createOpenCodeAdapter,
  defaultOneShotArgs,
  parseJsonLineChunk,
} from "../src/cli/index.js";
import type {
  CliEvent,
  CliMetadata,
} from "../src/cli/index.js";
import type {
  CliProcessHandlers,
  CliProcessResult,
  CliProcessSpec,
} from "../src/cli/process-runner.js";
import type { CliAdapter } from "../src/cli/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeScript {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: string;
  delayMs?: number;
  seen: CliProcessSpec[];
}

/**
 * Deterministic stand-in for the real process spawner. Honors timeouts and
 * aborts with a real timer, so cancellation/timeout tests are timing-accurate.
 */
function fakeRunner(script: FakeScript): (spec: CliProcessSpec, handlers?: CliProcessHandlers) => Promise<CliProcessResult> {
  return async (spec, handlers = {}) => {
    script.seen.push(spec);
    const started = Date.now();
    if (script.spawnError !== undefined) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        spawnError: script.spawnError,
        durationMs: Date.now() - started,
      };
    }

    const timeout = spec.timeoutMs ?? 60_000;
    let outcome: "done" | "timeout" | "cancelled" = "done";
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      outcome = "timeout";
      finish();
    }, Math.max(timeout, 0));
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      spec.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (outcome === "done") outcome = "cancelled";
      finish();
    };
    if (spec.signal?.aborted) {
      onAbort();
    } else {
      spec.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const stdout = script.stdout ?? "";
    const stderr = script.stderr ?? "";
    if (stdout) handlers.onStdoutChunk?.(stdout);
    if (stderr) handlers.onStderrChunk?.(stderr);

    const delay = script.delayMs ?? 0;
    if (delay > 0 && outcome === "done") {
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
    const cancelled = outcome === "cancelled";
    const timedOut = outcome === "timeout";
    finish();
    if (cancelled) {
      return { exitCode: null, stdout, stderr, timedOut: false, cancelled: true, durationMs: Date.now() - started };
    }
    if (timedOut) {
      return { exitCode: null, stdout, stderr, timedOut: true, cancelled: false, durationMs: Date.now() - started };
    }
    return {
      exitCode: script.exitCode ?? 0,
      stdout,
      stderr,
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
    };
  };
}

function script(overrides?: Partial<FakeScript>): FakeScript {
  return { seen: [], ...overrides };
}

/** Minimal adapter whose resolution never touches the real filesystem. */
class FakeAdapter extends CliAdapterBase {
  constructor(id = "fake") {
    super({
      id,
      name: `Fake ${id}`,
      description: "test CLI",
      executable: `fake-${id}`,
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["run", "{prompt}"],
      engineAliases: [id],
    });
  }

  override async resolveExecutable(): Promise<string | null> {
    return `/fake/bin/${this.getMetadata().id}`;
  }
}

function managedManager(fake: FakeScript, adapters: CliAdapter[] = [new FakeAdapter()]): CliManager {
  const manager = new CliManager({ runProcessImpl: fakeRunner(fake) });
  for (const adapter of adapters) manager.register(adapter);
  return manager;
}

// ---------------------------------------------------------------------------
// 1. Adapter interface + OpenCode adapter metadata
// ---------------------------------------------------------------------------

describe("CLI adapter interface", () => {
  it("OpenCodeAdapter publishes complete, UI-safe metadata", () => {
    const adapter = createOpenCodeAdapter();
    const meta: CliMetadata = adapter.getMetadata();
    expect(meta.id).toBe("opencode");
    expect(meta.name).toBe("OpenCode");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.executable).toBe("opencode");
    expect(meta.supportsStreaming).toBe(true);
    expect(meta.supportsCancellation).toBe(true);
    expect(meta.defaultArgs.length).toBeGreaterThan(0);
    expect(meta.engineAliases).toContain("opencode-cli");
  });

  it("adapter metadata copies are decoupled from the adapter", () => {
    const adapter = createOpenCodeAdapter();
    const meta = adapter.getMetadata();
    meta.defaultArgs.push("MUTATED");
    expect(adapter.getMetadata().defaultArgs).not.toContain("MUTATED");
  });

  it("matchesExecutable recognises ids, names, paths — and only them", () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.matchesExecutable("opencode")).toBe(true);
    expect(adapter.matchesExecutable("opencode-cli")).toBe(true);
    expect(adapter.matchesExecutable("C:\\tools\\opencode.cmd")).toBe(true);
    expect(adapter.matchesExecutable("/usr/local/bin/opencode")).toBe(true);
    expect(adapter.matchesExecutable("opencode", "C:\\tools\\opencode.exe")).toBe(true);
    expect(adapter.matchesExecutable("claude")).toBe(false);
    expect(adapter.matchesExecutable("codex")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. JSON-line protocol parsing (shared implementation used by every adapter)
// ---------------------------------------------------------------------------

describe("CLI stdout protocol parsing", () => {
  it("parses tool_call lines", () => {
    expect(parseJsonLineChunk('{"tool_call":{"name":"get_price","arguments":{"symbol":"BTC"}}}')).toEqual({
      type: "tool_call",
      name: "get_price",
      arguments: { symbol: "BTC" },
    });
  });

  it("parses delta/content/text variants", () => {
    expect(parseJsonLineChunk('{"delta":"hello"}')).toEqual({ type: "delta", content: "hello" });
    expect(parseJsonLineChunk('{"content":"world"}')).toEqual({ type: "delta", content: "world" });
    expect(parseJsonLineChunk('{"text":"!"}')).toEqual({ type: "delta", content: "!" });
  });

  it("returns null for plain text, malformed JSON and foreign JSON", () => {
    expect(parseJsonLineChunk("plain text")).toBeNull();
    expect(parseJsonLineChunk("{not json")).toBeNull();
    expect(parseJsonLineChunk('{"ready":true}')).toBeNull();
    expect(parseJsonLineChunk('{"tool_call":{"name":""}}')).toBeNull();
    expect(parseJsonLineChunk("")).toBeNull();
  });

  it("defaults {model} template args and substitutes {prompt}", () => {
    expect(defaultOneShotArgs(["run", "{model}", "{prompt}"], "hi")).toEqual(["run", "hi"]);
    expect(defaultOneShotArgs(["-p", "{prompt}"], "hi")).toEqual(["-p", "hi"]);
  });
});

// ---------------------------------------------------------------------------
// 3. OpenCode adapter behaviour (pure: no process, no filesystem)
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter task argv", () => {
  it("inserts --agent/--model after `run` (legacy ordering)", () => {
    const adapter = createOpenCodeAdapter();
    expect(
      adapter.decorateTaskArgs(["run", "--auto", "{prompt}"], { model: "opencode", agentId: "quant" }),
    ).toEqual(["run", "--agent", "quant", "--model", "opencode", "--auto", "{prompt}"]);
  });

  it("sanitises the agent name and skips decoration without an agent id", () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.decorateTaskArgs(["run", "{prompt}"], { model: "opencode", agentId: "my agent/x" })).toEqual([
      "run",
      "--agent",
      "my-agent-x",
      "--model",
      "opencode",
      "{prompt}",
    ]);
    expect(adapter.decorateTaskArgs(["run", "{prompt}"], { model: "opencode" })).toEqual([
      "run",
      "{prompt}",
    ]);
  });

  it("never duplicates an existing --agent flag and leaves other CLIs alone", () => {
    const adapter = createOpenCodeAdapter();
    const args = ["run", "--agent", "other", "--auto", "{prompt}"];
    expect(adapter.decorateTaskArgs(args, { model: "opencode", agentId: "quant" })).toEqual(args);
    expect(adapter.decorateTaskArgs(["-p", "{prompt}"], { model: "m", agentId: "a" })).toEqual([
      "-p",
      "{prompt}",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Registration, lookup, validation
// ---------------------------------------------------------------------------

describe("CliManager registration and lookup", () => {
  it("registers, lists and unregisters adapters", () => {
    const fake = script();
    const manager = new CliManager({ runProcessImpl: fakeRunner(fake) });
    expect(manager.list()).toHaveLength(0);

    manager.register(new FakeAdapter("alpha"));
    manager.register(new FakeAdapter("beta"));
    expect(manager.listMetadata().map((a) => a.id).sort()).toEqual(["alpha", "beta"]);
    expect(manager.has("alpha")).toBe(true);
    expect(manager.get("alpha")?.getMetadata().name).toBe("Fake alpha");

    expect(manager.unregister("alpha")).toBe(true);
    expect(manager.has("alpha")).toBe(false);
    expect(manager.unregister("alpha")).toBe(false);
  });

  it("rejects adapters without an id", () => {
    const manager = new CliManager({});
    expect(() => manager.register({ getMetadata: () => ({ id: "" }) } as never)).toThrow(
      /without id/,
    );
    expect(() => manager.register(undefined as never)).toThrow(/invalid CLI adapter/);
  });

  it("finds adapters by executable and by engine id", () => {
    const manager = new CliManager({});
    manager.register(createOpenCodeAdapter());
    manager.register(new FakeAdapter("claudeish"));

    expect(manager.findByExecutable("/usr/local/bin/opencode")?.getMetadata().id).toBe(
      "opencode",
    );
    expect(manager.findByExecutable("claude-x", "/x/fake-claudeish")?.getMetadata().id).toBe(
      "claudeish",
    );
    expect(manager.findByExecutable("unknown-cli-xyz")).toBeUndefined();

    expect(manager.findByEngineId("opencode")?.getMetadata().id).toBe("opencode");
    expect(manager.findByEngineId("opencode-cli")?.getMetadata().id).toBe("opencode");
    expect(manager.findByEngineId("OPeNcOdE")?.getMetadata().id).toBe("opencode");
    expect(manager.findByEngineId("claudeish")?.getMetadata().id).toBe("claudeish");
    expect(manager.findByEngineId("unknown-xyz")).toBeUndefined();
  });

  it("validates installations and reports missing adapters", async () => {
    const manager = new CliManager({});
    manager.register(
      createCustomCliAdapter({
        id: "missing-cli-xyz",
        name: "Missing CLI",
        executablePath: "definitely-missing-binary-xyz-9999",
      }),
    );
    const result = await manager.validate("missing-cli-xyz");
    expect(result.adapterId).toBe("missing-cli-xyz");
    expect(result.ok).toBe(false);
    expect(result.resolvedPath).toBeNull();
    expect(result.executable).toBe("definitely-missing-binary-xyz-9999");
    expect(result.checkedAt).toBeGreaterThan(0);

    const missing = await manager.validate("nope");
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Unknown CLI adapter/);
  });

  it("registers descriptor-driven custom adapters", () => {
    const manager = new CliManager({});
    manager.register(
      createCustomCliAdapter({
        id: "my-agent",
        name: "My Agent",
        executablePath: "/path/to/agent",
        workingDirectory: "/project",
        args: ["run", "{prompt}"],
      }),
    );
    const meta = manager.get("my-agent")?.getMetadata();
    expect(meta?.name).toBe("My Agent");
    expect(meta?.executable).toBe("/path/to/agent");
    expect((manager.get("my-agent") as CustomCliAdapter).defaultCwd()).toBe("/project");
  });
});

// ---------------------------------------------------------------------------
// 5. Session lifecycle, stdout/stderr streaming, failure handling
// ---------------------------------------------------------------------------

describe("CliManager sessions", () => {
  it("starts sessions, discovers them and sends tasks with substituted argv", async () => {
    const fake = script({ stdout: '{"delta":"hi"}\n' });
    const manager = managedManager(fake);

    const session = await manager.start("fake");
    expect(manager.getStatus(session.id)).toBe("starting");
    expect(manager.listSessions()).toHaveLength(1);
    expect(manager.listSessions()[0]?.adapterId).toBe("fake");
    expect(session.subscribe).toBeDefined();

    const result = await manager.sendTask(session.id, { task: "say hi", model: "m" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hi");
    expect(result.exitCode).toBe(0);
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.command).toBe("/fake/bin/fake");
    expect(fake.seen[0]?.args).toEqual(["run", "say hi"]);
    expect(manager.getStatus(session.id)).toBe("ready");

    await manager.stop(session.id);
    expect(manager.getStatus(session.id)).toBe("stopped");
    await expect(manager.sendTask(session.id, { task: "nope" })).rejects.toThrow(/stopped/);
  });

  it("aggregates plain text, parses tool calls and surfaces stderr", async () => {
    const fake = script({
      stdout: 'plain line\n{"tool_call":{"name":"get_price","arguments":{"symbol":"BTCUSDT"}}}\n{"delta":"done"}\n',
      stderr: "warn: slow\n",
    });
    const manager = managedManager(fake);
    const session = await manager.start("fake");
    const events: CliEvent[] = [];
    const collect = (async () => {
      for await (const event of manager.streamEvents(session.id)) {
        events.push(event);
        if (event.type === "session_finished" || event.type === "session_failed") break;
      }
    })();

    const result = await manager.sendTask(session.id, { task: "t" });
    await collect;

    expect(result.ok).toBe(true);
    expect(result.output).toBe("plain line\ndone");
    expect(result.toolActivities).toEqual([{ name: "get_price", arguments: { symbol: "BTCUSDT" } }]);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("status_changed");
    expect(types).toContain("session_started");
    expect(types).toContain("output");
    expect(types).toContain("tool_activity");
    expect(types).toContain("session_finished");
    expect(events.filter((e) => e.type === "output" && e.stream === "stderr")).toHaveLength(1);
    expect(events.every((e) => e.sessionId === session.id && e.adapterId === "fake")).toBe(true);
  });

  it("fails when the executable cannot be resolved", async () => {
    const manager = new CliManager({
      runProcessImpl: fakeRunner(script({ stdout: "x" })),
    });
    manager.register(createOpenCodeAdapter());
    const adapter = manager.get("opencode")!;
    adapter.resolveExecutable = async () => null;
    const session = await manager.start("opencode");
    const result = await manager.sendTask(session.id, { task: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(manager.getStatus(session.id)).toBe("failed");
  });

  it("reports non-zero exit codes and keeps the session reusable", async () => {
    const fake = script({ stdout: "", stderr: "bad flags", exitCode: 2 });
    const manager = managedManager(fake);
    const session = await manager.start("fake");
    const result = await manager.sendTask(session.id, { task: "t" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error).toMatch(/exited with code 2/);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(manager.getStatus(session.id)).toBe("ready");
  });

  it("reports spawn errors as fatal and marks the session failed", async () => {
    const fake = script({ spawnError: "spawn ENOENT" });
    const manager = managedManager(fake);
    const session = await manager.start("fake");
    const result = await manager.sendTask(session.id, { task: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn ENOENT");
    expect(manager.getStatus(session.id)).toBe("failed");
    await expect(manager.sendTask(session.id, { task: "again" })).rejects.toThrow(/failed/);
  });
});

// ---------------------------------------------------------------------------
// 6. Cancellation and timeout
// ---------------------------------------------------------------------------

describe("CliManager cancellation and timeout", () => {
  it("cancels an in-flight task through stop()", async () => {
    const fake = script({ stdout: "partial", delayMs: 5_000 });
    const manager = managedManager(fake);
    const session = await manager.start("fake", { timeoutMs: 30_000 });
    const task = manager.sendTask(session.id, { task: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.stop(session.id, "user abort");
    const result = await task;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toMatch(/cancelled/);
    expect(manager.getStatus(session.id)).toBe("stopped");
  });

  it("honours an external AbortSignal", async () => {
    const fake = script({ stdout: "partial", delayMs: 5_000 });
    const manager = managedManager(fake);
    const session = await manager.start("fake", { timeoutMs: 30_000 });
    const controller = new AbortController();
    const task = manager.sendTask(session.id, { task: "slow", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await task;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  it("times out long tasks and keeps the session reusable", async () => {
    const fake = script({ stdout: "slow", delayMs: 5_000 });
    const manager = managedManager(fake);
    const session = await manager.start("fake");
    const result = await manager.sendTask(session.id, { task: "slow", timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/timed out/);
    expect(manager.getStatus(session.id)).toBe("ready");
  });

  it("stops all sessions without touching unrelated state", async () => {
    const manager = managedManager(script({ stdout: "x" }));
    const first = await manager.start("fake");
    const second = await manager.start("fake");
    const statuses = new Map(manager.listSessions().map((s) => [s.id, s.status]));
    await manager.stopAll();
    expect(statuses.get(first.id)).not.toBe("stopped");
    expect(manager.listSessions()).toHaveLength(0);
    expect(manager.getStatus(first.id)).toBeUndefined();
    expect(manager.getStatus(second.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple adapters coexist; events are tagged per adapter
// ---------------------------------------------------------------------------

describe("CliManager multiple adapters", () => {
  it("keeps sessions isolated per adapter", async () => {
    const fakeA = script({ stdout: "A" });
    const fakeB = script({ stdout: "B" });
    const runBoth = (spec: CliProcessSpec, handlers?: CliProcessHandlers) =>
      spec.command.includes("alpha") ? fakeRunner(fakeA)(spec, handlers) : fakeRunner(fakeB)(spec, handlers);
    const manager = new CliManager({ runProcessImpl: runBoth });
    manager.register(new FakeAdapter("alpha"));
    manager.register(new FakeAdapter("beta"));

    const a = await manager.start("alpha");
    const b = await manager.start("beta");
    const [ra, rb] = await Promise.all([
      manager.sendTask(a.id, { task: "x" }),
      manager.sendTask(b.id, { task: "y" }),
    ]);
    expect(ra.output).toBe("A");
    expect(rb.output).toBe("B");
    expect(ra.adapterId).toBe("alpha");
    expect(rb.adapterId).toBe("beta");
    expect(manager.listMetadata().map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
    expect((await manager.validateAll()).map((v) => v.adapterId).sort()).toEqual(["alpha", "beta"]);
  });
});

// ---------------------------------------------------------------------------
// 8. Real process smoke test — `node` as a fake CLI (no installed CLI needed)
// ---------------------------------------------------------------------------

describe("CliManager real process smoke", () => {
  const nodeAdapter = (args: string[], taskDelivery: "argv" | "stdin" = "stdin") =>
    createCustomCliAdapter({
      id: "node-smoke",
      name: "Node smoke CLI",
      executablePath: process.execPath,
      args,
      taskDelivery,
    });

  it("spawns a real process and captures stdout line by line", async () => {
    const manager = new CliManager({});
    manager.register(
      nodeAdapter(["-e", 'process.stdout.write("line1\\n");process.stdout.write("line2\\n")']),
    );
    const session = await manager.start("node-smoke");
    const result = await manager.sendTask(session.id, { task: "ignored" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("line1\nline2");
  });

  it("delivers tasks through stdin when the adapter declares it", async () => {
    const manager = new CliManager({});
    manager.register(
      nodeAdapter(["-e", "let b='';process.stdin.on('data',(c)=>b+=c).on('end',()=>process.stdout.write('got:'+b))"], "stdin"),
    );
    const session = await manager.start("node-smoke");
    const result = await manager.sendTask(session.id, { task: "hello-stdin" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("got:hello-stdin");
  });

  it("kills a hanging real process on stop()", async () => {
    const manager = new CliManager({});
    manager.register(nodeAdapter(["-e", "setInterval(()=>{}, 1000)"]));
    const session = await manager.start("node-smoke");
    const task = manager.sendTask(session.id, { task: "hang", timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await manager.stop(session.id, "smoke abort");
    const result = await task;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  }, 15_000);
});
