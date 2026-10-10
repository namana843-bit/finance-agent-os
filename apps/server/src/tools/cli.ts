// ============================================================================
// Finance Agent OS — Generic CLI agent tool
// Adapter-agnostic counterpart of `opencode_run`: agents can drive any
// registered CLI adapter through the CLI manager without knowing which CLI it is.
// ============================================================================

import type { ToolDefinition } from "@finance/shared";

export function cliRunTool(): ToolDefinition {
  return {
    id: "cli_run",
    name: "CLI Run",
    description:
      "Send a task to any registered CLI agent adapter (e.g. opencode) via the CLI manager and return the normalized result. Use for code/analysis tasks that need an external agent CLI.",
    inputSchema: {
      type: "object",
      properties: {
        adapterId: { type: "string", description: "CLI adapter id (e.g. opencode). Omit to use the default adapter." },
        task: { type: "string", description: "Task/prompt text sent to the CLI" },
        model: { type: "string", description: "Optional model identifier" },
        timeoutMs: { type: "number", description: "Optional task timeout in milliseconds" },
      },
      required: ["task"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        adapterId: { type: "string" },
        sessionId: { type: "string" },
        output: { type: "string" },
        exitCode: { type: "number" },
        toolActivities: { type: "array" },
        error: { type: "string" },
      },
    },
    permissions: { required: false },
  };
}

export interface CliRunGateway {
  listMetadata(): Array<{ id: string }>;
  get(id: string): unknown;
  start(id: string, opts?: Record<string, unknown>): Promise<{ id: string }>;
  sendTask(sessionId: string, request: Record<string, unknown>): Promise<unknown>;
  stop(sessionId: string): Promise<void>;
}

/** Adapter-agnostic executor used by the finance tool registry. */
export async function executeCliRun(
  getCliManager: () => CliRunGateway | undefined,
  input: Record<string, unknown>,
): Promise<unknown> {
  const task = String(input.task ?? "").trim();
  if (!task) throw new Error("task is required");

  const cli = getCliManager();
  if (!cli) throw new Error("cli manager not available (service not registered)");

  const adapters = cli.listMetadata();
  const requestedId = String(input.adapterId ?? "").trim();
  const adapterId = requestedId || adapters[0]?.id;
  if (!adapterId) throw new Error("no CLI adapters registered");
  if (!cli.get(adapterId)) {
    throw new Error(
      `unknown CLI adapter '${adapterId}' (available: ${adapters.map((a) => a.id).join(", ") || "none"})`,
    );
  }

  const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
  const session = await cli.start(adapterId, undefined);
  try {
    return await cli.sendTask(session.id, {
      task,
      model: typeof input.model === "string" ? input.model : undefined,
      agentId: "tool:cli_run",
      timeoutMs,
    });
  } finally {
    await cli.stop(session.id).catch(() => {});
  }
}