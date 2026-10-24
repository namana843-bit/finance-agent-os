// ============================================================================
// Coding Agent Workspace — contract, registry, projects, sessions.
//
// Deterministic: every provider is a fake adapter with an injected process
// runner. No real CLI, no network, no credentials.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  CliAdapterBase,
  CliManager,
  type CliProcessHandlers,
  type CliProcessResult,
  type CliProcessSpec,
} from "../src/cli/index.js";
import {
  CodingProviderRegistry,
  capabilitiesFromMetadata,
  statusFromValidation,
} from "../src/coding/providers.js";
import { CodingProjectStore, validateProjectPath } from "../src/coding/projects.js";
import { CodingSessionError, CodingSessionManager } from "../src/coding/sessions.js";
import type { CliMetadata } from "../src/cli/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeOptions {
  id: string;
  defaultArgs?: string[];
  supportsStreaming?: boolean;
  supportsCancellation?: boolean;
  sessionModes?: CliMetadata["sessionModes"];
  resolvedPath?: string | null;
  validationError?: string;
  version?: string | null;
}

class FakeAdapter extends CliAdapterBase {
  constructor(private readonly opts: FakeOptions) {
    super({
      id: opts.id,
      name: `Fake ${opts.id}`,
      description: "test adapter",
      executable: `fake-${opts.id}`,
      supportsStreaming: opts.supportsStreaming ?? true,
      supportsCancellation: opts.supportsCancellation ?? true,
      taskDelivery: "argv",
      defaultArgs: opts.defaultArgs ?? ["run", "{prompt}"],
      engineAliases: [opts.id],
      ...(opts.sessionModes ? { sessionModes: opts.sessionModes } : {}),
    });
  }

  override async resolveExecutable(): Promise<string | null> {
    return this.opts.resolvedPath === undefined ? `/fake/bin/${this.opts.id}` : this.opts.resolvedPath;
  }

  override async validateInstallation() {
    const resolvedPath = this.opts.resolvedPath === undefined ? `/fake/bin/${this.opts.id}` : this.opts.resolvedPath;
    const result = {
      adapterId: this.opts.id,
      ok: resolvedPath !== null && !this.opts.validationError,
      executable: this.getMetadata().executable,
      resolvedPath,
      version: this.opts.version ?? null,
      checkedAt: Date.now(),
    };
    return this.opts.validationError ? { ...result, error: this.opts.validationError } : result;
  }
}

type Runner = (spec: CliProcessSpec, handlers?: CliProcessHandlers) => Promise<CliProcessResult>;

function streamingRunner(behavior: "ok" | "fail" | "slow" = "ok"): Runner {
  return async (_spec, handlers = {}) => {
    const started = Date.now();
    if (behavior === "fail") {
      handlers.onStdoutChunk?.("error: invalid api key (test)\n");
      return {
        exitCode: 1,
        stdout: "error: invalid api key (test)\n",
        stderr: "",
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started,
      };
    }
    handlers.onStdoutChunk?.('{"delta":"Hello "}\n');
    handlers.onStdoutChunk?.('{"tool_call":{"name":"read_file","arguments":{"path":"a.ts"}}}\n');
    handlers.onStdoutChunk?.('{"delta":"world"}\n');
    if (behavior === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
    };
  };
}

function buildManager(opts: { runner?: Runner; adapters?: FakeOptions[] } = {}): CliManager {
  const manager = new CliManager({ runProcessImpl: opts.runner ?? streamingRunner("ok") });
  for (const adapter of opts.adapters ?? [
    { id: "opencode" },
    { id: "claude", defaultArgs: ["-p", "{prompt}", "--model", "{model}"] },
    { id: "gemini", supportsCancellation: false },
    { id: "codex", resolvedPath: null },
  ]) {
    manager.register(new FakeAdapter(adapter));
  }
  return manager;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coding-ws-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Phase 1 — contract / capability discovery
// ---------------------------------------------------------------------------

describe("capability discovery", () => {
  it("derives different capabilities for different adapters", () => {
    const opencode = capabilitiesFromMetadata({
      id: "opencode",
      name: "OpenCode",
      description: "",
      executable: "opencode",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "argv",
      defaultArgs: ["run", "{prompt}"],
      engineAliases: ["opencode"],
    });
    const claude = capabilitiesFromMetadata({
      id: "claude",
      name: "Claude",
      description: "",
      executable: "claude",
      supportsStreaming: true,
      supportsCancellation: true,
      taskDelivery: "stdin",
      defaultArgs: ["-p", "{prompt}", "--model", "{model}"],
      engineAliases: ["claude"],
    });

    expect(opencode.streaming.supported).toBe(true);
    expect(opencode.model_selection.supported).toBe(false);
    expect(claude.model_selection.supported).toBe(true);
    // Unsupported capabilities must carry a reason, never a bare false.
    const reason = opencode.permission_requests;
    expect(reason.supported).toBe(false);
    if (!reason.supported) expect(reason.reason.length).toBeGreaterThan(10);
  });

  it("reports persistent_session only when the adapter declares it", () => {
    const oneShot = capabilitiesFromMetadata({
      id: "a", name: "A", description: "", executable: "a",
      supportsStreaming: true, supportsCancellation: true, taskDelivery: "argv",
      defaultArgs: ["{prompt}"], engineAliases: [],
    });
    const persistent = capabilitiesFromMetadata({
      id: "b", name: "B", description: "", executable: "b",
      supportsStreaming: true, supportsCancellation: true, taskDelivery: "argv",
      defaultArgs: ["{prompt}"], engineAliases: [], sessionModes: ["one-shot", "persistent"],
    });
    expect(oneShot.persistent_session.supported).toBe(false);
    expect(persistent.persistent_session.supported).toBe(true);
  });

  it("maps an installation failure to installed=false and keeps auth unknown", () => {
    const status = statusFromValidation({
      adapterId: "x", ok: false, executable: "x", resolvedPath: null,
      version: null, error: "executable not found on PATH", checkedAt: 1,
    });
    expect(status.installed).toBe(false);
    expect(status.auth).toBe("unknown");
  });

  it("maps an auth error to unauthenticated without leaking the message value", () => {
    const status = statusFromValidation({
      adapterId: "x", ok: true, executable: "x", resolvedPath: "/x",
      version: "1.0.0", error: "login required: run `x login`", checkedAt: 1,
    });
    expect(status.auth).toBe("unauthenticated");
    expect(status.version).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — registry reports observed status only
// ---------------------------------------------------------------------------

describe("provider registry", () => {
  it("marks a missing executable as not installed", async () => {
    const registry = new CodingProviderRegistry(buildManager());
    const providers = await registry.describeAll();
    const codex = providers.find((provider) => provider.providerId === "codex");
    expect(codex?.status.installed).toBe(false);
    expect(codex?.status.resolvedPath).toBeNull();
  });

  it("does not list unknown provider ids", async () => {
    const registry = new CodingProviderRegistry(buildManager());
    expect(registry.has("nope")).toBe(false);
    expect(await registry.describe("nope")).toBeNull();
  });

  it("returns an explicit unsupported result for model enumeration", async () => {
    const registry = new CodingProviderRegistry(buildManager());
    const result = await registry.listModels("claude");
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toMatch(/model/i);
  });

  it("honours the provider allow-list order", async () => {
    const registry = new CodingProviderRegistry(buildManager(), { only: ["claude", "opencode"] });
    expect(registry.listIds()).toEqual(["opencode", "claude"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — project path validation
// ---------------------------------------------------------------------------

describe("project path validation", () => {
  it("accepts a real absolute directory", async () => {
    const result = await validateProjectPath(root);
    expect(result.ok).toBe(true);
  });

  it("rejects relative paths", async () => {
    const result = await validateProjectPath("some/relative/dir");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_absolute");
  });

  it("rejects traversal segments", async () => {
    const result = await validateProjectPath(`${root}${sep}..${sep}escape`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("traversal");
  });

  it("rejects a missing directory", async () => {
    const result = await validateProjectPath(join(root, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
  });

  it("rejects a file", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "x");
    const result = await validateProjectPath(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_a_directory");
  });

  it("rejects credential stores and OS directories", async () => {
    const ssh = await validateProjectPath(join(root, ".ssh"));
    expect(ssh.ok).toBe(false);
    if (!ssh.ok) expect(ssh.code).toBe("blocked_location");
  });

  it("rejects paths outside configured roots", async () => {
    const other = await mkdtemp(join(tmpdir(), "coding-outside-"));
    try {
      const result = await validateProjectPath(other, { allowedRoots: [root] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("outside_allowed_root");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("does not throw on non-string input", async () => {
    const result = await validateProjectPath(42);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phases 3/4/6 — sessions, streaming, isolation, cancellation
// ---------------------------------------------------------------------------

describe("coding sessions", () => {
  async function setup(runner: Runner = streamingRunner("ok")) {
    const manager = buildManager({ runner });
    const registry = new CodingProviderRegistry(manager);
    const projects = new CodingProjectStore(join(root, "state", "projects.json"));
    await mkdir(join(root, "proj-a"), { recursive: true });
    await mkdir(join(root, "proj-b"), { recursive: true });
    const projectA = projects.add(join(root, "proj-a"));
    const projectB = projects.add(join(root, "proj-b"));
    const sessions = new CodingSessionManager({
      cli: manager,
      providers: registry,
      projects,
      storagePath: join(root, "state", "sessions.json"),
    });
    return { manager, registry, projects, sessions, projectA, projectB };
  }

  it("streams text and tool events from a provider", async () => {
    const { sessions, projectA } = await setup();
    const session = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const seen: string[] = [];
    let text = "";
    const iterator = sessions.streamTurn(session.id, "Explain a.ts");
    let step = await iterator.next();
    while (!step.done) {
      seen.push(step.value.type);
      if (step.value.type === "text") text += step.value.content;
      step = await iterator.next();
    }
    expect(seen).toContain("tool");
    expect(text).toContain("Hello");
    expect(step.value.role).toBe("assistant");
    expect(sessions.get(session.id)?.status).toBe("idle");
  });

  it("keeps provider and project contexts separate", async () => {
    const { sessions, projectA, projectB } = await setup();
    const a = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const b = await sessions.create({ providerId: "claude", projectId: projectB.id });

    expect(a.id).not.toBe(b.id);
    expect(a.providerId).toBe("opencode");
    expect(b.providerId).toBe("claude");
    expect(a.projectPath).toBe(projectA.path);
    expect(b.projectPath).toBe(projectB.path);
    expect(sessions.list({ providerId: "opencode" }).map((s) => s.id)).toEqual([a.id]);
    expect(sessions.list({ projectId: projectB.id }).map((s) => s.id)).toEqual([b.id]);
  });

  it("records history on one session without touching another", async () => {
    const { sessions, projectA, projectB } = await setup();
    const a = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const b = await sessions.create({ providerId: "opencode", projectId: projectB.id });
    const iterate = async (id: string, text: string) => {
      const iterator = sessions.streamTurn(id, text);
      let step = await iterator.next();
      while (!step.done) step = await iterator.next();
    };
    await iterate(a.id, "first session task");
    expect(sessions.get(a.id)?.turns.length).toBe(2);
    expect(sessions.get(b.id)?.turns.length).toBe(0);
  });

  it("refuses to create a session for an uninstalled provider", async () => {
    const { sessions, projectA } = await setup();
    await expect(sessions.create({ providerId: "codex", projectId: projectA.id }))
      .rejects.toBeInstanceOf(CodingSessionError);
  });

  it("refuses persistent mode when the adapter does not support it", async () => {
    const { sessions, projectA } = await setup();
    await expect(
      sessions.create({ providerId: "opencode", projectId: projectA.id, mode: "persistent" }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("surfaces a provider auth failure as a failed turn", async () => {
    const { sessions, projectA } = await setup(streamingRunner("fail"));
    const session = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const iterator = sessions.streamTurn(session.id, "do work");
    let step = await iterator.next();
    let thrown: unknown;
    try {
      while (!step.done) step = await iterator.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CodingSessionError);
    expect(sessions.get(session.id)?.status).toBe("failed");
  });

  it("cancels a running session and marks it cancelled", async () => {
    const { sessions, projectA } = await setup(streamingRunner("slow"));
    const session = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const iterator = sessions.streamTurn(session.id, "long task");
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const cancelled = await sessions.cancel(session.id);
    expect(cancelled?.status).toBe("cancelled");
    // Drain; the generator must terminate rather than hang.
    let step = await iterator.next();
    while (!step.done) step = await iterator.next();
  });

  it("rejects an empty turn", async () => {
    const { sessions, projectA } = await setup();
    const session = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    await expect(async () => {
      const iterator = sessions.streamTurn(session.id, "   ");
      await iterator.next();
    }).rejects.toMatchObject({ code: "invalid_turn" });
  });

  it("persists sessions and never restores a running status", async () => {
    const { sessions, projectA } = await setup();
    const session = await sessions.create({ providerId: "opencode", projectId: projectA.id });
    const reopened = new CodingSessionManager({
      cli: buildManager(),
      providers: new CodingProviderRegistry(buildManager()),
      projects: new CodingProjectStore(join(root, "state", "projects.json")),
      storagePath: join(root, "state", "sessions.json"),
    });
    const restored = reopened.get(session.id);
    expect(restored?.providerId).toBe("opencode");
    expect(restored?.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — isolated git worktrees for concurrent sessions
// ---------------------------------------------------------------------------

describe("isolated worktrees", () => {
  function initRepo(path: string): void {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: path, stdio: "ignore", windowsHide: true });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Coding Test");
    execFileSync("git", ["add", "."], { cwd: path, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["commit", "-m", "init"], { cwd: path, stdio: "ignore", windowsHide: true });
  }

  async function setupRepo(runner: Runner = streamingRunner("ok")) {
    const manager = buildManager({ runner });
    const registry = new CodingProviderRegistry(manager);
    const projects = new CodingProjectStore(join(root, "state", "projects.json"));
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
    initRepo(repo);
    const project = projects.add(repo);
    const sessions = new CodingSessionManager({
      cli: manager,
      providers: registry,
      projects,
      storagePath: join(root, "state", "sessions.json"),
      worktreeRoot: join(root, "worktrees"),
    });
    return { sessions, project, repo };
  }

  it("creates a worktree and runs the session in it", async () => {
    const { sessions, project } = await setupRepo();
    const session = await sessions.create({ providerId: "opencode", projectId: project.id, isolate: true });
    expect(session.isolated).toBe(true);
    expect(session.worktreePath).toBeTruthy();
    const worktreePath = session.worktreePath!;
    expect(existsSync(worktreePath)).toBe(true);
    expect(session.worktreeBranch).toBe(`coding/${session.id}`);
    // The main working tree is untouched by worktree creation.
    expect(existsSync(join(project.path, "a.ts"))).toBe(true);

    const removed = await sessions.removeWorktree(session.id, true);
    expect(removed?.worktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses a second non-isolated session while one is running", async () => {
    const { sessions, project } = await setupRepo(streamingRunner("slow"));
    const first = await sessions.create({ providerId: "opencode", projectId: project.id });
    const iterator = sessions.streamTurn(first.id, "long task");
    await iterator.next();
    await expect(
      sessions.create({ providerId: "opencode", projectId: project.id }),
    ).rejects.toMatchObject({ code: "project_busy" });
    const isolated = await sessions.create({ providerId: "opencode", projectId: project.id, isolate: true });
    expect(isolated.isolated).toBe(true);
    await sessions.cancel(first.id);
    let step = await iterator.next();
    while (!step.done) step = await iterator.next();
  });

  it("refuses isolation for a non-repo project", async () => {
    const manager = buildManager();
    const registry = new CodingProviderRegistry(manager);
    const projects = new CodingProjectStore(join(root, "state", "projects.json"));
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });
    const project = projects.add(plain);
    const sessions = new CodingSessionManager({
      cli: manager,
      providers: registry,
      projects,
      worktreeRoot: join(root, "worktrees"),
    });
    await expect(
      sessions.create({ providerId: "opencode", projectId: project.id, isolate: true }),
    ).rejects.toMatchObject({ code: "isolation_unavailable" });
  });

  it("refuses to remove a worktree that is not isolated", async () => {
    const { sessions, project } = await setupRepo();
    const session = await sessions.create({ providerId: "opencode", projectId: project.id });
    await expect(sessions.removeWorktree(session.id, true)).rejects.toMatchObject({ code: "not_isolated" });
  });
});
