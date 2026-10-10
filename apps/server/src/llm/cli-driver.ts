import type { LlmCompletion, LlmDriver } from "./types.js";
import { runCliProcess } from "../cli/process-runner.js";

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface CliDriverOptions {
  command: string;
  model?: string;
  args?: string[];
  timeoutMs?: number;
  spawnImpl?: SpawnFn;
}

// NOTE: the default spawn implementation delegates to the shared CLI process
// runner (`cli/process-runner.ts`) with `shell: false`. The CLI command path
// comes from user configuration, and routing it through a shell would allow
// shell-metacharacter injection (e.g. `foo; rm -rf ~` would execute the
// trailing payload). The runner invokes the binary directly with an argv
// array, so no shell parsing or expansion ever happens.
export function defaultSpawnImpl(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCliProcess(
    { command: cmd, args, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs },
  ).then((result) => {
    if (result.spawnError !== undefined) {
      throw new Error(result.spawnError);
    }
    if (result.timedOut) {
      const err = new Error(`CLI process killed (timeout ${opts.timeoutMs}ms)`);
      (err as { killed?: boolean }).killed = true;
      throw err;
    }
    if (result.cancelled) {
      const err = new Error("CLI process cancelled");
      (err as { killed?: boolean }).killed = true;
      throw err;
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode ?? 1 };
  });
}

export class CliDriver implements LlmDriver {
  private readonly command: string;
  private readonly model: string | undefined;
  private readonly args: string[] | undefined;
  private readonly timeoutMs: number;
  private readonly spawnImpl: SpawnFn;

  constructor(opts: CliDriverOptions) {
    this.command = opts.command;
    this.model = opts.model;
    this.args = opts.args;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
  }

  async complete(prompt: string, opts?: { model?: string }): Promise<string> {
    const result = await this.completeWithUsage(prompt, opts);
    return result.text;
  }

  async completeWithUsage(
    prompt: string,
    opts?: { model?: string },
  ): Promise<LlmCompletion> {
    const model = opts?.model ?? this.model;
    const templates = this.args ?? ["-p", "{prompt}"];
    const finalArgs: string[] = [];
    for (const template of templates) {
      if (template.includes("{model}") && model === undefined) {
        continue;
      }
      finalArgs.push(
        template.split("{prompt}").join(prompt).split("{model}").join(model ?? ""),
      );
    }
    const result = await this.spawnImpl(this.command, finalArgs, {
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(`cli exited ${result.code}: ${result.stderr.slice(0, 500)}`);
    }
    const output = result.stdout.trim();
    if (output.length === 0) {
      throw new Error("empty CLI response");
    }
    // CLI engines don't report token usage; the service estimates from text.
    return { text: output };
  }
}
