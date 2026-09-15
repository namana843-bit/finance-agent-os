import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_CATALOG,
  getEngineStatuses,
  loadEngineOverrides,
  probeVersion,
  saveEngineOverride,
} from "../src/llm/engines.js";

describe("ENGINE_CATALOG", () => {
  it("has >= 12 entries with unique ids and valid groups", () => {
    expect(ENGINE_CATALOG.length).toBeGreaterThanOrEqual(12);
    const ids = ENGINE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ENGINE_CATALOG) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(["cloud", "local"]).toContain(entry.group);
      expect(["cli", "openai-compat"]).toContain(entry.kind);
    }
  });

  it("openai-compat entry has empty command and no install", () => {
    const entry = ENGINE_CATALOG.find((e) => e.id === "openai-compat");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("openai-compat");
    expect(entry!.command).toBe("");
    expect(entry!.install).toBeUndefined();
  });
});

describe("engine overrides store", () => {
  it("saveEngineOverride/loadEngineOverrides round-trip in an explicit dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engines-test-"));
    try {
      expect(await loadEngineOverrides(dir)).toEqual({});
      await saveEngineOverride(dir, "claude", "my-claude-binary");
      expect(await loadEngineOverrides(dir)).toEqual({
        claude: "my-claude-binary",
      });
      await saveEngineOverride(dir, "codex", "my-codex");
      expect(await loadEngineOverrides(dir)).toEqual({
        claude: "my-claude-binary",
        codex: "my-codex",
      });
      // undefined deletes the key
      await saveEngineOverride(dir, "claude", undefined);
      expect(await loadEngineOverrides(dir)).toEqual({ codex: "my-codex" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("probeVersion", () => {
  it("resolves undefined for a missing binary and never rejects", async () => {
    await expect(
      probeVersion("definitely-not-a-real-binary-xyz"),
    ).resolves.toBeUndefined();
  });
});

describe("getEngineStatuses", () => {
  it("returns one status per catalog entry with openai-compat always found", async () => {
    const statuses = await getEngineStatuses();
    expect(statuses).toHaveLength(ENGINE_CATALOG.length);
    const compat = statuses.find((s) => s.id === "openai-compat");
    expect(compat).toBeDefined();
    expect(compat!.found).toBe(true);
    expect(compat!.path).toBeUndefined();
    for (const status of statuses) {
      expect(typeof status.effectiveCommand).toBe("string");
      expect(typeof status.overridden).toBe("boolean");
    }
  });

  it("never rejects", async () => {
    await expect(getEngineStatuses()).resolves.toBeDefined();
  });
});
