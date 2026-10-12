import type { ToolDefinition } from "@finance/shared";

export function clineTool(): ToolDefinition {
  return {
    id: "cline_run",
    name: "Cline CLI Run",
    description: "Run an allowed cline CLI command via the gateway (requires CLINE_GATEWAY_ENABLED=true and allowlisted command), or run a bare one-shot prompt. Use for code/analysis tasks that need Cline.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "cline subcommand (e.g. --version, --help, task) or a bare one-shot prompt" },
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

export async function executeClineRun(
  getGateway: () => { run: (req: { command: string; args?: string[]; agentId?: string }) => Promise<unknown> } | undefined,
  input: Record<string, unknown>,
): Promise<unknown> {
  const cmd = String(input.command ?? "").trim();
  if (!cmd) throw new Error("command is required");
  const argsIn = Array.isArray(input.args) ? (input.args as unknown[]).map((v) => String(v)) : [];
  // Keep free text as ONE arg (never split prompts on whitespace): when the
  // caller supplies no explicit argv, the whole command string is the prompt.
  // Otherwise the first token is the subcommand and explicit args follow.
  const gw = getGateway();
  if (!gw) throw new Error("cline gateway not available (service not registered)");
  if (argsIn.length === 0) {
    return gw.run({ command: cmd, args: [cmd], agentId: "tool:cline_run" });
  }
  const parts = cmd.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? cmd;
  const args = [...parts.slice(1), ...argsIn];
  return gw.run({ command, args, agentId: "tool:cline_run" });
}
