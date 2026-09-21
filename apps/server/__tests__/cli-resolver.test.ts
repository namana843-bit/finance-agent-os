import { describe, expect, it } from "vitest";
import { autoResolveCliPath } from "../src/llm/cli-resolver.js";

describe("autoResolveCliPath", () => {
  it("should return null for empty or invalid command string", async () => {
    expect(await autoResolveCliPath("")).toBeNull();
    expect(await autoResolveCliPath("   ")).toBeNull();
  });

  it("should resolve system executables in PATH automatically (e.g. node, npm, cmd/ls)", async () => {
    const cmd = process.platform === "win32" ? "cmd" : "ls";
    const resolved = await autoResolveCliPath(cmd);
    expect(resolved).not.toBeNull();
    expect(typeof resolved).toBe("string");
  });

  it("should return null gracefully for completely non-existent binary without throwing", async () => {
    const resolved = await autoResolveCliPath("non_existent_binary_test_99999");
    expect(resolved).toBeNull();
  });
});
