import type { ToolDefinition } from "@finance/shared";

export function opencodeTool(): ToolDefinition {
  return {
    id: "opencode_run",
    name: "Opencode CLI Run",
    description: "Run an allowed opencode CLI command via the gateway (requires OPENCODE_GATEWAY_ENABLED=true and allowlisted command). Use for code/analysis tasks that need opencode.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "opencode subcommand (e.g. run, --version, --help)" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
        cliPath: { type: "string" },
      },
    },
    permissions: { required: false },
  };
}

export async function executeOpencodeRun(
  getGateway: () => { run: (req: { command: string; args?: string[]; agentId?: string }) => Promise<unknown> } | undefined,
  input: Record<string, unknown>,
): Promise<unknown> {
  const cmd = String(input.command ?? "").trim();
  if (!cmd) throw new Error("command is required");
  const argsIn = Array.isArray(input.args) ? (input.args as unknown[]).map((v) => String(v)) : [];
  // If command itself contains spaces (e.g. \"run --help\"), split: first token is command, rest prepended to args
  const parts = cmd.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? cmd;
  const extra = parts.slice(1);
  const args = [...extra, ...argsIn];
  const gw = getGateway();
  if (!gw) throw new Error("opencode gateway not available (service not registered)");
  return gw.run({ command, args, agentId: "tool:opencode_run" });
}
