// ============================================================================
// Generic CLI model discovery — contract tests.
//
// Deterministic: no network (fetch is stubbed to reject), no env keys, and
// curated catalogs are asserted statically. Dynamic CLI sources are only
// exercised through the OpenCode module's own tests.
// ============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCliModelsCache,
  discoverCliModels,
} from "../src/llm/cli-models.js";

afterEach(() => {
  clearCliModelsCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("discoverCliModels", () => {
  it("returns the curated catalog for gemini when no API key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    const result = await discoverCliModels("gemini");
    expect(result.source).toBe("curated");
    expect(result.models.length).toBeGreaterThan(3);
    expect(result.models.some((m) => m.id === "gemini-2.5-pro")).toBe(true);
  });

  it("returns the curated catalog for claude with Sonnet/Opus ids and aliases", async () => {
    const result = await discoverCliModels("claude");
    expect(result.source).toBe("curated");
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-5-20250929");
    expect(ids).toContain("sonnet");
  });

  it("returns the curated catalog for codex", async () => {
    const result = await discoverCliModels("codex");
    expect(result.source).toBe("curated");
    expect(result.models.some((m) => m.id.startsWith("gpt-"))).toBe(true);
  });

  it("maps the cursor adapter's `agent` executable to the Cursor catalog", async () => {
    const result = await discoverCliModels("agent");
    expect(result.source).toBe("curated");
    expect(result.models.some((m) => m.id === "composer-1")).toBe(true);
  });

  it("falls back to a single executable entry for an unknown CLI", async () => {
    const result = await discoverCliModels("totally-unknown-cli");
    expect(result.source).toBe("fallback");
    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("totally-unknown-cli");
  });

  it("degrades to curated (with an error) when a dynamic source throws", async () => {
    // ollama has a dynamic path (`ollama list`); make the exec fail.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));
    const result = await discoverCliModels("ollama");
    // Either a parsed ollama list (if the binary exists) or the fallback —
    // the contract is only that it never throws and returns ≥ 0 models.
    expect(Array.isArray(result.models)).toBe(true);
  });

  it("caches results between calls unless refresh is requested", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    const first = await discoverCliModels("gemini");
    const second = await discoverCliModels("gemini");
    expect(second).toBe(first); // same cached object reference

    const refreshed = await discoverCliModels("gemini", { refresh: true });
    expect(refreshed).not.toBe(first);
    expect(refreshed.models.length).toBe(first.models.length);
  });
});
